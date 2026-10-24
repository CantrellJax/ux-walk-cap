// ux-walk.app: the recorder in the menu bar. Start a walk, chapter, mark, pause and stop from the menu (the
// Option+Shift+N / M / P shortcuts keep working); the end-of-walk questions come up as dialogs.
//
// The app uses the same `ux-walk start` command as agents and talks JSON lines to that child.
// JSON lines are defined in src/ipc.mjs. The capture helper is the recorder's child, so macOS
// charges Screen Recording and the microphone to this app, not to a terminal.
//
// Where Node and the repo are: ~/.config/ux-walk/launch.json { "root", "node", "path" }, written by
// install.sh (kept outside the bundle so a new PATH does not change the app's signature and its permissions).
// Settings: ~/.config/ux-walk/config.json (the same file the CLI reads); API keys in the login Keychain.

import AppKit
import AVFoundation
import CoreGraphics
import SwiftUI

let home = FileManager.default.homeDirectoryForCurrentUser.path
let configDir = ProcessInfo.processInfo.environment["CAP_UX_WALK_CONFIG_DIR"] ?? "\(home)/.config/ux-walk"
let configFile = "\(configDir)/config.json"
let launchFile = "\(configDir)/launch.json"
let logDir = "\(home)/Library/Logs/ux-walk"
let logFile = "\(logDir)/recorder.log"
let agentPlist = "\(home)/Library/LaunchAgents/com.onc4ll.ux-walk.plist"
let embeddedEngine = Bundle.main.resourceURL?.appendingPathComponent("engine")
let embedded = embeddedEngine.map { FileManager.default.fileExists(atPath: $0.appendingPathComponent("bin/node").path) } ?? false
let capUXBundle = Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

func launchConfig() -> [String: Any] {
  if embedded, let root = embeddedEngine?.path {
    let inherited = readJSON(launchFile)["path"] as? String ?? ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
    return ["root": root, "node": "\(root)/bin/node", "path": "\(root)/bin:\(home)/.local/bin:/opt/homebrew/bin:/usr/local/bin:\(inherited)"]
  }
  return readJSON(launchFile)
}

// Transcribers the recorder knows (src/transcribe/), with the Keychain item each key lives in.
struct Transcriber { let id: String; let name: String; let keychain: String; let keyURL: String }
let transcribers = [
  Transcriber(id: "elevenlabs", name: "ElevenLabs Scribe", keychain: "ux-walk-elevenlabs", keyURL: "https://elevenlabs.io/app/settings/api-keys"),
  Transcriber(id: "assemblyai", name: "AssemblyAI", keychain: "ux-walk-assemblyai", keyURL: "https://www.assemblyai.com/dashboard/api-keys"),
  Transcriber(id: "descript", name: "Descript", keychain: "descript-mcp-token", keyURL: "https://web.descript.com/settings/api"),
  Transcriber(id: "none", name: "None (no transcript)", keychain: "", keyURL: ""),
]

func expand(_ p: String) -> String { p.hasPrefix("~") ? home + p.dropFirst() : p }

func readJSON(_ file: String) -> [String: Any] {
  guard let d = FileManager.default.contents(atPath: file),
        let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return [:] }
  return o
}

func writeConfig(_ changes: [String: Any]) {
  var cfg = readJSON(configFile)
  for (k, v) in changes { cfg[k] = v }
  try? FileManager.default.createDirectory(atPath: configDir, withIntermediateDirectories: true)
  if let d = try? JSONSerialization.data(withJSONObject: cfg, options: [.prettyPrinted, .sortedKeys]) {
    FileManager.default.createFile(atPath: configFile, contents: d + Data("\n".utf8))
  }
}

@discardableResult
func run(_ tool: String, _ args: [String], input: String? = nil) -> (Int32, String) {
  let p = Process()
  p.executableURL = URL(fileURLWithPath: tool)
  p.arguments = args
  let out = Pipe()
  p.standardOutput = out
  p.standardError = Pipe()
  let inPipe = Pipe()
  if input != nil { p.standardInput = inPipe }
  do { try p.run() } catch { return (-1, "") }
  if let input { inPipe.fileHandleForWriting.write(Data(input.utf8)); try? inPipe.fileHandleForWriting.close() }
  let data = out.fileHandleForReading.readDataToEndOfFile()
  p.waitUntilExit()
  return (p.terminationStatus, String(data: data, encoding: .utf8) ?? "")
}

// The security CLI writes the item with an ACL the Node recorder (also through the security CLI) can read
// without a prompt; SecItemAdd from this app would tie the item to the app.
func keychainHas(_ item: String) -> Bool {
  !item.isEmpty && run("/usr/bin/security", ["find-generic-password", "-a", NSUserName(), "-s", item]).0 == 0
}
func keychainSet(_ item: String, _ value: String) -> Bool {
  run("/usr/bin/security", ["add-generic-password", "-U", "-a", NSUserName(), "-s", item, "-w", value]).0 == 0
}

func appendLog(_ line: String) {
  try? FileManager.default.createDirectory(atPath: logDir, withIntermediateDirectories: true)
  let stamp = ISO8601DateFormatter().string(from: Date())
  let data = Data("[\(stamp)] \(line)\n".utf8)
  if let h = FileHandle(forWritingAtPath: logFile) { h.seekToEndOfFile(); h.write(data); try? h.close() }
  else { FileManager.default.createFile(atPath: logFile, contents: data) }
}

func notify(_ title: String, _ body: String) {
  let esc = { (s: String) in s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") }
  run("/usr/bin/osascript", ["-e", "display notification \"\(esc(body))\" with title \"\(esc(title))\""])
}

func mmss(_ s: Int) -> String { String(format: "%02d:%02d", max(0, s) / 60, max(0, s) % 60) }

// MARK: - The recorder child process

final class Recorder {
  private var proc: Process?
  private var input: FileHandle?
  private var buffer = Data()
  var onEvent: ([String: Any]) -> Void = { _ in }
  var onExit: (Int32, String) -> Void = { _, _ in }
  private var stderrTail = ""
  var running: Bool { proc?.isRunning ?? false }

  // call: record a call (ux-walk call --app <id>) instead of a browser walk; url is then the call app id or "".
  // extra: the speakers screen's choices (--mic, --mic-people, --call-people, --call-app).
  // mode: "start" (a walk), "call" (url is then the call app id), or the legacy native "video" path.
  func start(topic: String, url: String, extra: [String], mode: String = "start") throws {
    let launch = launchConfig()
    guard let root = launch["root"] as? String, let node = launch["node"] as? String else {
      throw NSError(domain: "ux-walk", code: 1, userInfo: [NSLocalizedDescriptionKey: "Run install.sh in the ux-walk folder first: it tells the app where Node and ux-walk are (\(launchFile))."])
    }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: node)
    var args = ["\(root)/bin/ux-walk", mode, "--ipc", topic.isEmpty ? (["start", "record"].contains(mode) ? "walk" : mode) : topic]
    if mode == "call" { if !url.isEmpty { args += ["--app", url] } }
    else if !url.isEmpty { args.append(url) }
    args += extra
    p.arguments = args
    p.currentDirectoryURL = URL(fileURLWithPath: root)
    // A GUI app gets launchd's short PATH; ffmpeg, git and claude are called by name.
    var env = ProcessInfo.processInfo.environment
    if let path = launch["path"] as? String { env["PATH"] = path }
    env.removeValue(forKey: "TERM")
    p.environment = env
    let out = Pipe(), err = Pipe(), inp = Pipe()
    p.standardOutput = out
    p.standardError = err
    p.standardInput = inp
    out.fileHandleForReading.readabilityHandler = { [weak self] h in
      let d = h.availableData
      DispatchQueue.main.async { self?.take(d) }
    }
    err.fileHandleForReading.readabilityHandler = { [weak self] h in
      guard let s = String(data: h.availableData, encoding: .utf8), !s.isEmpty else { return }
      DispatchQueue.main.async {
        appendLog("stderr: \(s.trimmingCharacters(in: .whitespacesAndNewlines))")
        self?.stderrTail = String(((self?.stderrTail ?? "") + s).suffix(2000))
      }
    }
    p.terminationHandler = { [weak self] p in
      out.fileHandleForReading.readabilityHandler = nil
      err.fileHandleForReading.readabilityHandler = nil
      DispatchQueue.main.async {
        guard let self else { return }
        self.proc = nil; self.input = nil
        self.onExit(p.terminationStatus, self.stderrTail)
      }
    }
    appendLog("start: \(args.joined(separator: " "))")
    stderrTail = ""
    try p.run()
    proc = p
    input = inp.fileHandleForWriting
  }

  private func take(_ d: Data) {
    buffer.append(d)
    while let nl = buffer.firstIndex(of: 0x0A) {
      let line = buffer.subdata(in: buffer.startIndex..<nl)
      buffer.removeSubrange(buffer.startIndex...nl)
      guard let o = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else {
        if let s = String(data: line, encoding: .utf8), !s.isEmpty { appendLog("stdout: \(s)") }
        continue
      }
      onEvent(o)
    }
  }

  func send(_ o: [String: Any]) {
    guard let input, let d = try? JSONSerialization.data(withJSONObject: o) else { return }
    try? input.write(contentsOf: d + Data("\n".utf8))
  }
}

// MARK: - The floating control bar (Loom-style)
// A small capsule above every window while a walk records: record dot, timer, chapter, then next chapter, marker,
// pause/resume and stop. Click the timer to collapse it. Drag it anywhere; it remembers where. It is excluded from
// screen capture, so it never shows in the recording or in a Meet screen share.

let barMoss = Color(red: 0.17, green: 0.23, blue: 0.14)
let barCream = Color(red: 0.95, green: 0.94, blue: 0.89)
let barRed = Color(red: 0.93, green: 0.31, blue: 0.27)

final class BarModel: ObservableObject {
  @Published var paused = false
  @Published var startMs: Double = Date().timeIntervalSince1970 * 1000
  @Published var chapter = 1
  @Published var notes = 0
  @Published var compact = false
  @Published var flash: String?
  @Published var continuousMedia = false
  @Published var ownsRecording = true
  @Published var capRecording = true
  var pauseHelp: String { continuousMedia ? (capRecording ? "Pause logging (Cap keeps recording)" : "Pause logging") : "Pause" }
  var stopHelp: String { continuousMedia ? (!capRecording ? "End logging and finish" : ownsRecording ? "Stop recording and finish" : "End logging (Cap keeps recording)") : "Stop and finish" }
  func elapsed(_ now: Date) -> String { mmss(Int(now.timeIntervalSince1970 - startMs / 1000)) }
}

struct BarButton: View {
  let symbol: String, help: String
  var tint: Color = barCream
  let action: () -> Void
  @State private var hover = false
  var body: some View {
    Button(action: action) {
      Image(systemName: symbol).font(.system(size: 13, weight: .semibold)).foregroundStyle(tint)
        .frame(width: 30, height: 30)
        .background(Circle().fill(barCream.opacity(hover ? 0.14 : 0)))
    }
    .buttonStyle(.plain).help(help).onHover { hover = $0 }
  }
}

// AppKit's window dragging also works on the macOS 15 SDK; WindowDragGesture needs a newer SDK.
private final class BarDragView: NSView {
  override func mouseDown(with event: NSEvent) { window?.performDrag(with: event) }
}
private struct BarDragHandle: NSViewRepresentable {
  func makeNSView(context: Context) -> NSView { BarDragView() }
  func updateNSView(_ view: NSView, context: Context) {}
}

struct BarView: View {
  @ObservedObject var m: BarModel
  let next: () -> Void, mark: () -> Void, pause: () -> Void, stop: () -> Void
  @State private var pulse = false
  var body: some View {
    HStack(spacing: 2) {
      Image(systemName: "line.3.horizontal").rotationEffect(.degrees(90)).font(.system(size: 11, weight: .semibold))
        .foregroundStyle(barCream.opacity(0.45)).frame(width: 16, height: 30).contentShape(Rectangle())
        .overlay(BarDragHandle()).help("Drag to move")
      Button(action: { withAnimation(.easeInOut(duration: 0.18)) { m.compact.toggle() } }) {
        HStack(spacing: 8) {
          Circle().fill(m.paused ? Color.orange : barRed).frame(width: 9, height: 9)
            .opacity(m.paused ? 1 : (pulse ? 1 : 0.35))
          if m.paused {
            Text(m.continuousMedia ? (m.capRecording ? "Logging paused · Cap recording" : "Logging paused · Cap ended") : "Paused").font(.system(size: 13, weight: .semibold, design: .rounded))
          } else {
            TimelineView(.periodic(from: .now, by: 1)) { ctx in
              Text(m.elapsed(ctx.date)).font(.system(size: 13, weight: .semibold, design: .rounded).monospacedDigit())
            }
          }
          if !m.compact {
            Text(m.flash ?? "\(m.continuousMedia ? (m.capRecording ? "Cap · " : "Cap ended · ") : "")ch \(m.chapter)\(m.notes > 0 ? " · \(m.notes) note\(m.notes == 1 ? "" : "s")" : "")")
              .font(.system(size: 12, weight: .medium)).foregroundStyle(barCream.opacity(0.65))
          }
        }
        .padding(.leading, 10).padding(.trailing, m.compact ? 10 : 6).frame(height: 30).contentShape(Rectangle())
      }
      .buttonStyle(.plain).help(m.compact ? "Show the controls" : "Collapse")
      if !m.compact {
        Rectangle().fill(barCream.opacity(0.18)).frame(width: 1, height: 18).padding(.horizontal, 3)
        BarButton(symbol: "forward.end.fill", help: m.continuousMedia ? "Chapter marker (Option+Shift+N)" : "Next chapter (Option+Shift+N)", action: next)
        BarButton(symbol: "bookmark.fill", help: "Drop a marker (Option+Shift+M)", action: mark)
        BarButton(symbol: m.paused ? "play.fill" : "pause.fill", help: m.paused ? (m.continuousMedia ? "Resume logging (Option+Shift+P)" : "Resume (Option+Shift+P)") : "\(m.pauseHelp) (Option+Shift+P)", action: pause)
        BarButton(symbol: "stop.fill", help: m.stopHelp, tint: barRed, action: stop)
      }
    }
    .padding(4)
    .background(Capsule().fill(barMoss.opacity(0.95)))
    .overlay(Capsule().strokeBorder(barCream.opacity(0.14), lineWidth: 1))
    .foregroundStyle(barCream)
    .fixedSize()
    .onAppear { withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { pulse = true } }
  }
}

final class FloatingBar {
  let model = BarModel()
  private var panel: NSPanel?
  private var hosting: NSHostingView<BarView>?
  var actions: (next: () -> Void, mark: () -> Void, pause: () -> Void, stop: () -> Void) = ({}, {}, {}, {})

  private func make() -> NSPanel {
    let host = NSHostingView(rootView: BarView(m: model, next: { self.actions.next() }, mark: { self.actions.mark() }, pause: { self.actions.pause() }, stop: { self.actions.stop() }))
    let p = NSPanel(contentRect: NSRect(origin: .zero, size: host.fittingSize), styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: false)
    p.contentView = host
    p.isFloatingPanel = true
    p.level = .floating
    p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
    p.isMovableByWindowBackground = true
    p.backgroundColor = .clear
    p.isOpaque = false
    p.hasShadow = true
    p.hidesOnDeactivate = false
    p.sharingType = .none  // never in a recording or a screen share
    if let s = UserDefaults.standard.string(forKey: "barOrigin") {
      p.setFrameOrigin(NSPointFromString(s))
    } else if let screen = NSScreen.main {
      let f = screen.visibleFrame
      p.setFrameOrigin(NSPoint(x: f.midX - host.fittingSize.width / 2, y: f.maxY - host.fittingSize.height - 12))
    }
    NotificationCenter.default.addObserver(forName: NSWindow.didMoveNotification, object: p, queue: .main) { _ in
      UserDefaults.standard.set(NSStringFromPoint(p.frame.origin), forKey: "barOrigin")
    }
    hosting = host
    return p
  }

  // Keep the left edge and the top where they are while the capsule grows or shrinks.
  private func fit() {
    guard let p = panel, let h = hosting else { return }
    let size = h.fittingSize
    let top = p.frame.maxY
    p.setFrame(NSRect(x: p.frame.minX, y: top - size.height, width: size.width, height: size.height), display: true)
  }

  func update(phase: String, state: [String: Any]) {
    let show = (phase == "recording" || phase == "paused") && UserDefaults.standard.object(forKey: "showBar") as? Bool != false
    guard show else { panel?.orderOut(nil); return }
    if panel == nil { panel = make() }
    model.paused = phase == "paused"
    model.continuousMedia = state["continuousMedia"] as? Bool == true
    model.ownsRecording = state["ownsRecording"] as? Bool ?? true
    model.capRecording = state["capRecording"] as? Bool != false
    if let s = state["startMs"] as? Double { model.startMs = s }
    if let c = state["chapter"] as? Int { model.chapter = c }
    model.notes = state["notes"] as? Int ?? model.notes
    DispatchQueue.main.async { self.fit() }
    if panel?.isVisible != true { panel?.orderFrontRegardless() }
  }

  func flash(_ text: String) {
    model.flash = text
    DispatchQueue.main.async { self.fit() }
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) { [weak self] in
      if self?.model.flash == text { self?.model.flash = nil; self?.fit() }
    }
  }
}

// The biggest on-screen window of a process (global bounds, top-left origin).
func windowBounds(pid: Int) -> CGRect? {
  guard let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
  return info.filter { ($0[kCGWindowOwnerPID as String] as? Int) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }
    .compactMap { ($0[kCGWindowBounds as String] as? NSDictionary).flatMap { CGRect(dictionaryRepresentation: $0 as CFDictionary) } }
    .max { $0.width * $0.height < $1.width * $1.height }
}

// MARK: - The camera bubble
// Your camera in a round or rounded-square window, mirrored like a selfie view. A walk or video with the camera
// draws it over the recorded browser window (the helper's --bubble-window), or the whole screen shows it anyway.
// Drag the middle to move it, drag its edge or pinch to resize, hover for shape and hide. A hairline and a soft
// shadow, no ring (Loom-like). The hover controls sit just outside it and stay out of the recording.

final class BubbleView: NSView {
  weak var bubble: CameraBubble?
  private var resizing = false
  private var startSize: CGFloat = 0, startPoint = NSPoint.zero
  override var mouseDownCanMoveWindow: Bool { false }
  override func updateTrackingAreas() {
    trackingAreas.forEach(removeTrackingArea)
    addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .mouseMoved, .activeAlways, .inVisibleRect], owner: self))
  }
  override func mouseEntered(with e: NSEvent) { bubble?.hover(true) }
  override func mouseExited(with e: NSEvent) { bubble?.hover(false) }
  // The outer band (the last 16% of the radius) resizes; the middle moves.
  private func onEdge(_ p: NSPoint) -> Bool {
    let c = NSPoint(x: bounds.midX, y: bounds.midY), r = bounds.width / 2
    let d = bubble?.shape == "circle" ? hypot(p.x - c.x, p.y - c.y) : max(abs(p.x - c.x), abs(p.y - c.y))
    return d > r * 0.8
  }
  override func mouseMoved(with e: NSEvent) {
    (onEdge(convert(e.locationInWindow, from: nil)) ? NSCursor.crosshair : NSCursor.openHand).set()
  }
  override func mouseDown(with e: NSEvent) {
    let p = convert(e.locationInWindow, from: nil)
    if onEdge(p) { resizing = true; startSize = bounds.width; startPoint = NSEvent.mouseLocation }
    else { resizing = false; window?.performDrag(with: e); bubble?.snapInside() }
  }
  override func mouseDragged(with e: NSEvent) {
    guard resizing, let b = bubble else { return }
    let now = NSEvent.mouseLocation
    let grow = max(now.x - startPoint.x, startPoint.y - now.y)  // right or down grows, keeping the top-left
    b.resize(to: startSize + grow * 2, anchorTop: true)
  }
  override func mouseUp(with e: NSEvent) { if resizing { bubble?.snapInside() }; resizing = false }
  override func magnify(with e: NSEvent) { bubble.map { $0.resize(to: $0.size * (1 + e.magnification), anchorTop: false) } }
}

struct BubbleControls: View {
  let shape: String, mirrored: Bool
  let circle: () -> Void, square: () -> Void, mirror: () -> Void, hide: () -> Void
  var body: some View {
    HStack(spacing: 2) {
      BarButton(symbol: shape == "circle" ? "circle.fill" : "circle", help: "Circle", action: circle)
      BarButton(symbol: shape == "square" ? "square.fill" : "square", help: "Rounded square", action: square)
      BarButton(symbol: "arrow.left.and.right.righttriangle.left.righttriangle.right\(mirrored ? ".fill" : "")", help: mirrored ? "Mirrored (text reads backwards in the video)" : "Mirror", action: mirror)
      Rectangle().fill(barCream.opacity(0.18)).frame(width: 1, height: 16).padding(.horizontal, 2)
      BarButton(symbol: "eye.slash", help: "Hide the camera", action: hide)
    }
    .padding(3)
    .background(Capsule().fill(barMoss.opacity(0.95)))
    .overlay(Capsule().strokeBorder(barCream.opacity(0.14), lineWidth: 1))
    .fixedSize()
  }
}

final class CameraBubble: NSObject {
  private(set) var panel: NSPanel?
  private var controls: NSPanel?
  private let session = AVCaptureSession()
  private var preview: AVCaptureVideoPreviewLayer?
  private let edge = CAShapeLayer()
  private var view: BubbleView?
  private var hideTimer: Timer?
  var shape: String { get { UserDefaults.standard.string(forKey: "bubbleShape") ?? "circle" } set { UserDefaults.standard.set(newValue, forKey: "bubbleShape") } }
  var size: CGFloat { get { let v = UserDefaults.standard.double(forKey: "bubbleSize"); return v > 0 ? v : 230 } set { UserDefaults.standard.set(Double(newValue), forKey: "bubbleSize") } }
  var windowID: Int? { panel?.isVisible == true ? panel?.windowNumber : nil }
  var mirrored: Bool { get { UserDefaults.standard.bool(forKey: "bubbleMirrored") } set { UserDefaults.standard.set(newValue, forKey: "bubbleMirrored"); applyMirror() } }
  private func applyMirror() {
    if let c = preview?.connection, c.isVideoMirroringSupported { c.automaticallyAdjustsVideoMirroring = false; c.isVideoMirrored = mirrored }
  }
  // While a window is recorded: the bubble keeps its place relative to that window, and snaps back inside it when
  // dropped outside (only the part over the window is in the video).
  private var follow: Timer?
  private var target: CGRect?
  func follow(pid: Int) {
    follow?.invalidate()
    follow = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
      guard let self, let p = self.panel, p.isVisible, let r = windowBounds(pid: pid) else { return }
      if let old = self.target, old.origin != r.origin {
        p.setFrameOrigin(NSPoint(x: p.frame.minX + (r.minX - old.minX), y: p.frame.minY - (r.minY - old.minY)))
      }
      self.target = r
    }
  }
  func snapInside() {
    guard let p = panel, let r = target, let mainH = NSScreen.screens.first?.frame.height else { return }
    let w = NSRect(x: r.minX, y: mainH - r.maxY, width: r.width, height: r.height).insetBy(dx: 12, dy: 12)
    guard !w.contains(p.frame) else { return }
    let x = min(max(p.frame.minX, w.minX), w.maxX - p.frame.width), y = min(max(p.frame.minY, w.minY), w.maxY - p.frame.height)
    p.animator().setFrameOrigin(NSPoint(x: x, y: y))
  }

  static func cameras() -> [AVCaptureDevice] {
    AVCaptureDevice.DiscoverySession(deviceTypes: [.builtInWideAngleCamera, .external, .continuityCamera], mediaType: .video, position: .unspecified).devices
  }

  // The window exists at once (the recorder needs its id); the camera starts once access is granted.
  func show(camera: String?) {
    if panel == nil { build() }
    layout()
    panel?.orderFrontRegardless()
    AVCaptureDevice.requestAccess(for: .video) { ok in
      DispatchQueue.main.async {
        if ok { self.startCamera(camera) } else { notify("Camera not allowed", "System Settings > Privacy & Security > Camera: turn on ux-walk.") }
      }
    }
  }

  private func startCamera(_ name: String?) {
    let devs = CameraBubble.cameras()
    guard let dev = name.flatMap({ n in devs.first { $0.localizedName == n } }) ?? AVCaptureDevice.default(for: .video) ?? devs.first,
          let input = try? AVCaptureDeviceInput(device: dev) else { notify("No camera", "ux-walk found no camera to show."); return }
    session.beginConfiguration()
    for i in session.inputs { session.removeInput(i) }
    if session.canAddInput(input) { session.addInput(input) }
    session.sessionPreset = .high
    session.commitConfiguration()
    applyMirror()
    DispatchQueue.global(qos: .userInitiated).async { self.session.startRunning() }
  }

  private func build() {
    let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: size, height: size), styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: false)
    p.level = .floating
    p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
    p.backgroundColor = .clear
    p.isOpaque = false
    p.hasShadow = true
    p.hidesOnDeactivate = false
    p.acceptsMouseMovedEvents = true
    let v = BubbleView(frame: NSRect(x: 0, y: 0, width: size, height: size))
    v.bubble = self
    v.wantsLayer = true
    v.layer?.masksToBounds = true
    v.layer?.backgroundColor = NSColor(white: 0.12, alpha: 1).cgColor
    let pl = AVCaptureVideoPreviewLayer(session: session)
    pl.videoGravity = .resizeAspectFill
    v.layer?.addSublayer(pl)
    edge.fillColor = nil
    edge.strokeColor = NSColor(white: 1, alpha: 0.22).cgColor
    edge.lineWidth = 1
    v.layer?.addSublayer(edge)
    p.contentView = v
    if let s = UserDefaults.standard.string(forKey: "bubbleOrigin") { p.setFrameOrigin(NSPointFromString(s)) }
    else if let screen = NSScreen.main { p.setFrameOrigin(NSPoint(x: screen.visibleFrame.maxX - size - 48, y: screen.visibleFrame.minY + 48)) }
    NotificationCenter.default.addObserver(forName: NSWindow.didMoveNotification, object: p, queue: .main) { [weak self] _ in
      UserDefaults.standard.set(NSStringFromPoint(p.frame.origin), forKey: "bubbleOrigin")
      self?.placeControls()
    }
    panel = p; preview = pl; view = v
  }

  private func layout() {
    guard let p = panel, let v = view else { return }
    let top = p.frame.maxY
    p.setFrame(NSRect(x: p.frame.minX, y: top - size, width: size, height: size), display: true)
    v.frame = NSRect(x: 0, y: 0, width: size, height: size)
    let radius = shape == "circle" ? size / 2 : min(72, max(48, size * 0.21))
    v.layer?.cornerRadius = radius
    v.layer?.cornerCurve = .continuous
    preview?.frame = v.bounds
    edge.frame = v.bounds
    edge.path = CGPath(roundedRect: v.bounds.insetBy(dx: 0.5, dy: 0.5), cornerWidth: radius - 0.5, cornerHeight: radius - 0.5, transform: nil)
    p.invalidateShadow()
    placeControls()
  }

  func resize(to s: CGFloat, anchorTop: Bool) {
    guard let p = panel else { return }
    let new = min(600, max(150, s))
    if !anchorTop { // pinch: keep the centre
      let c = NSPoint(x: p.frame.midX, y: p.frame.midY)
      p.setFrameOrigin(NSPoint(x: c.x - new / 2, y: c.y + new / 2 - size))
    }
    size = new
    layout()
  }

  // Hover controls: a small capsule just below the bubble, in a child window kept out of recordings.
  private func makeControls() -> NSPanel {
    let host = NSHostingView(rootView: controlsView())
    let c = NSPanel(contentRect: NSRect(origin: .zero, size: host.fittingSize), styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: false)
    c.contentView = host
    c.level = .floating
    c.backgroundColor = .clear
    c.isOpaque = false
    c.hasShadow = true
    c.sharingType = .none
    return c
  }
  private func controlsView() -> BubbleControls {
    BubbleControls(shape: shape, mirrored: mirrored, circle: { [weak self] in self?.setShape("circle") }, square: { [weak self] in self?.setShape("square") },
                   mirror: { [weak self] in guard let self else { return }; self.mirrored.toggle(); self.refreshControls() }, hide: { [weak self] in self?.hide() })
  }
  private func refreshControls() { (controls?.contentView as? NSHostingView<BubbleControls>)?.rootView = controlsView() }
  private func setShape(_ s: String) {
    shape = s
    refreshControls()
    layout()
  }
  private func placeControls() {
    guard let p = panel, let c = controls else { return }
    c.setFrameOrigin(NSPoint(x: p.frame.midX - c.frame.width / 2, y: p.frame.minY - c.frame.height - 8))
  }
  func hover(_ inside: Bool) {
    hideTimer?.invalidate()
    if inside {
      if controls == nil { controls = makeControls(); panel?.addChildWindow(controls!, ordered: .above) }
      placeControls()
      controls?.orderFront(nil)
    } else {
      // A moment's grace so the pointer can travel from the bubble to the controls.
      hideTimer = Timer.scheduledTimer(withTimeInterval: 1.6, repeats: false) { [weak self] _ in
        guard let self, let c = self.controls else { return }
        if !NSPointInRect(NSEvent.mouseLocation, c.frame.insetBy(dx: -6, dy: -6)) { c.orderOut(nil) } else { self.hover(false) }
      }
    }
  }

  // Put the bubble in the bottom-left corner inside a window (global CG bounds, top-left origin).
  func place(inside bounds: CGRect) {
    guard let p = panel, let mainH = NSScreen.screens.first?.frame.height else { return }
    let cocoaBottom = mainH - bounds.maxY
    p.setFrameOrigin(NSPoint(x: bounds.maxX - size - 24, y: cocoaBottom + 24))
    placeControls()
  }

  func hide() {
    follow?.invalidate(); follow = nil; target = nil
    controls?.orderOut(nil)
    panel?.orderOut(nil)
    DispatchQueue.global().async { self.session.stopRunning() }
  }
}

// MARK: - Fixed URL handoff
// Links select an existing setup screen only. They never supply recorder arguments or start capture.
enum WalkStartRoute: Equatable {
  case instructions
  case cap
  var purpose: Int { self == .cap ? 1 : 0 }
}

func walkStartRoute(_ url: URL) -> WalkStartRoute? {
  // Match the retained URL spelling: older Foundation versions decode percentEncodedHost,
  // so component checks alone can turn an encoded authority into an accepted link.
  let parts = url.absoluteString.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
  guard parts[0].lowercased() == "ux-walk://start" else { return nil }
  if parts.count == 1 { return .instructions }
  return parts[1] == "capture=cap" ? .cap : nil
}

// MARK: - The menu bar app

final class App: NSObject, NSApplicationDelegate, NSMenuDelegate {
  let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  let recorder = Recorder()
  var state: [String: Any] = [:]
  var phase = "idle" // idle | starting | recording | paused | finishing
  var walkDir: String?
  var lastReply = ""
  var timer: Timer?
  let bar = FloatingBar()
  let bubble = CameraBubble()
  var recordingWholeScreen = false
  var openAsk: (id: Int, alert: NSAlert)?
  var quitting = false
  var launchCompleted = false
  var pendingStartRoute: WalkStartRoute?
  var startDialogWindow: NSWindow?

  func application(_ application: NSApplication, open urls: [URL]) {
    // Coalesce one delivery into one setup dialog. Unsupported links are ignored, never interpreted as commands.
    guard let route = urls.compactMap(walkStartRoute).first else { appendLog("Ignored unsupported ux-walk URL"); return }
    guard launchCompleted else { pendingStartRoute = route; return }
    openStartRoute(route)
  }

  func openStartRoute(_ route: WalkStartRoute) {
    NSApp.activate()
    startDialog(initialPurpose: route.purpose)
  }

  func applicationDidFinishLaunching(_ n: Notification) {
    // UXW_DIALOG_SNAPSHOT=<png> [UXW_DIALOG=call]: draw the start dialog to an image and quit (to check its layout).
    if let png = ProcessInfo.processInfo.environment["UXW_DIALOG_SNAPSHOT"] { snapshotDialog(png); exit(0) }
    // UXW_BAR_SNAPSHOT=<prefix>: the floating bar expanded, paused and collapsed, as PNGs.
    if let prefix = ProcessInfo.processInfo.environment["UXW_BAR_SNAPSHOT"] {
      for (name, paused, compact) in [("expanded", false, false), ("paused", true, false), ("compact", false, true), ("cap-paused", true, false), ("cap-attached", false, false)] {
        let m = BarModel(); m.startMs = Date().timeIntervalSince1970 * 1000 - 194_000; m.chapter = 2; m.notes = 3; m.paused = paused; m.compact = compact
        m.continuousMedia = name.hasPrefix("cap-"); m.ownsRecording = name != "cap-attached"
        let r = ImageRenderer(content: BarView(m: m, next: {}, mark: {}, pause: {}, stop: {}).padding(14).background(Color(white: 0.92)))
        r.scale = 2
        if let img = r.nsImage, let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) {
          try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: "\(prefix)-\(name).png"))
        }
      }
      exit(0)
    }
    let menu = NSMenu()
    menu.delegate = self
    item.menu = menu
    recorder.onEvent = { [weak self] e in self?.handle(e) }
    bar.actions = (
      next: { [weak self] in self?.recorder.send(["cmd": "next"]); self?.bar.flash("New chapter") },
      mark: { [weak self] in self?.recorder.send(["cmd": "mark", "text": "marker"]); self?.bar.flash("Marked") },
      pause: { [weak self] in self?.recorder.send(["cmd": "pause"]) },
      stop: { [weak self] in self?.recorder.send(["cmd": "stop"]) }
    )
    recorder.onExit = { [weak self] code, err in self?.exited(code, err) }
    timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in self?.refreshButton() }
    RunLoop.main.add(timer!, forMode: .common)
    refreshButton()
    // Ask for both permissions once, up front, so the first walk does not stall on a prompt.
    if !CGPreflightScreenCaptureAccess() { CGRequestScreenCaptureAccess() }
    if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined { AVCaptureDevice.requestAccess(for: .audio) { _ in } }
    if launchConfig()["root"] == nil {
      alert("ux-walk is not set up", "Run install.sh in the ux-walk folder once; it tells the app where Node and ux-walk are.")
    }
    launchCompleted = true
    if let route = pendingStartRoute {
      pendingStartRoute = nil
      // Return from launch before presenting the same setup screen used by the menu.
      DispatchQueue.main.async { [weak self] in self?.openStartRoute(route) }
    }
  }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    guard recorder.running else { return .terminateNow }
    quitting = true
    if let a = openAsk { NSApp.abortModal(); a.alert.window.orderOut(nil) }
    recorder.send(["cmd": "stop"])
    return .terminateLater
  }

  // MARK: Button

  // The footprint (assets/foot.svg, copied into the bundle by install.sh); red while recording.
  lazy var mark: NSImage? = {
    guard let url = Bundle.main.url(forResource: "foot", withExtension: "svg"), let img = NSImage(contentsOf: url) else { return nil }
    img.size = NSSize(width: 18 * img.size.width / max(1, img.size.height), height: 18)
    img.isTemplate = true
    return img
  }()

  func refreshButton() {
    guard let b = item.button else { return }
    let tint: NSColor?, title: String
    switch phase {
    case "recording":
      let start = (state["startMs"] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) } ?? Date()
      tint = .systemRed; title = " " + mmss(Int(Date().timeIntervalSince(start)))
    case "paused": tint = .systemOrange; title = " paused"
    case "starting": tint = nil; title = " starting"
    case "finishing": tint = nil; title = " finishing"
    default: tint = nil; title = ""
    }
    b.image = mark ?? NSImage(systemSymbolName: "record.circle", accessibilityDescription: "ux-walk")
    b.image?.isTemplate = true
    b.contentTintColor = tint
    b.title = title
    b.imagePosition = .imageLeading
    bar.update(phase: phase, state: state)
  }

  // MARK: Menu

  func menuNeedsUpdate(_ menu: NSMenu) {
    menu.removeAllItems()
    func add(_ title: String, _ action: Selector?, key: String = "", on: Bool = false) -> NSMenuItem {
      let m = NSMenuItem(title: title, action: action, keyEquivalent: key)
      m.target = self
      m.state = on ? .on : .off
      if action == nil { m.isEnabled = false }
      menu.addItem(m)
      return m
    }
    switch phase {
    case "recording", "paused":
      _ = add(statusLine(), nil)
      if let p = processingLine() { _ = add(p, nil) }
      if !lastReply.isEmpty { _ = add(lastReply, nil) }
      menu.addItem(.separator())
      if phase == "recording" {
        _ = add(continuousCap ? "Chapter marker…   ⌥⇧N" : "Next chapter…   ⌥⇧N", #selector(nextChapter))
        _ = add("Marker…   ⌥⇧M", #selector(marker))
        _ = add(continuousCap ? (capRecording ? "Pause logging (Cap keeps recording)   ⌥⇧P" : "Pause logging   ⌥⇧P") : "Pause   ⌥⇧P", #selector(pause))
      } else {
        _ = add(continuousCap ? "Resume logging   ⌥⇧P" : "Resume   ⌥⇧P", #selector(pause))
      }
      _ = add("Someone joined…", #selector(addSpeaker))
      menu.addItem(.separator())
      _ = add(stopTitle, #selector(stop), key: ".")
      if continuousCap && capRecording && state["ownsRecording"] as? Bool != false { _ = add("End logging, keep Cap recording", #selector(detachCap)) }
      _ = add("Open this walk's folder", #selector(openWalk))
    case "starting":
      _ = add("Starting the walk…", nil)
    case "finishing":
      _ = add(processingLine() ?? "Finishing the walk…", nil)
      _ = add("Open this walk's folder", #selector(openWalk))
    default:
      _ = add("Start a walk…", #selector(startWalk), key: "n")
      let advanced = NSMenuItem(title: "Advanced capture", action: nil, keyEquivalent: "")
      let sub = NSMenu()
      for (title, selector) in [("Record a call…", #selector(startCall)), ("Native video capture…", #selector(startVideo))] {
        let entry = NSMenuItem(title: title, action: selector, keyEquivalent: ""); entry.target = self; sub.addItem(entry)
      }
      advanced.submenu = sub; menu.addItem(advanced)
    }
    menu.addItem(.separator())
    let recent = NSMenuItem(title: "Recent walks", action: nil, keyEquivalent: "")
    recent.submenu = recentMenu()
    menu.addItem(recent)
    _ = add("Open recordings folder", #selector(openOut))
    menu.addItem(.separator())
    _ = add("Settings…", #selector(settings), key: ",")
    if !embedded { _ = add("Launch at login", #selector(toggleLogin), on: FileManager.default.fileExists(atPath: agentPlist)) }
    _ = add("Floating controls while recording", #selector(toggleBar), on: UserDefaults.standard.object(forKey: "showBar") as? Bool != false)
    _ = add("Show log", #selector(showLog))
    menu.addItem(.separator())
    _ = add("Quit ux-walk", #selector(quit), key: "q")
  }

  var continuousCap: Bool { state["continuousMedia"] as? Bool == true && state["mediaBackend"] as? String == "cap" }
  var capRecording: Bool { state["capRecording"] as? Bool != false }
  var stopTitle: String { continuousCap ? (!capRecording ? "End logging and finish" : state["ownsRecording"] as? Bool == false ? "End logging (Cap keeps recording)" : "Stop recording and finish") : "Stop and finish" }

  func statusLine() -> String {
    let notes = state["notes"] as? Int ?? 0, marks = state["marks"] as? Int ?? 0
    var parts: [String] = []
    if phase == "paused" { parts.append(continuousCap ? (capRecording ? "Logging paused · Cap recording" : "Logging paused · Cap ended") : "Paused") }
    else if let n = state["chapter"] as? Int {
      let start = (state["startMs"] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) } ?? Date()
      parts.append("● Chapter \(n) \"\(state["name"] as? String ?? "")\" \(mmss(Int(Date().timeIntervalSince(start))))")
    }
    if continuousCap && phase != "paused" { parts.append(!capRecording ? "Cap recording ended" : state["ownsRecording"] as? Bool == false ? "Attached to Cap" : "Cap recording") }
    parts.append("\(notes) note\(notes == 1 ? "" : "s")")
    if marks > 0 { parts.append("\(marks) marker\(marks == 1 ? "" : "s")") }
    if let sp = state["speakers"] as? [String], !sp.isEmpty { parts.append(sp.joined(separator: ", ")) }
    return parts.joined(separator: " · ")
  }

  func processingLine() -> String? {
    let chapters = state["chapters"] as? [[String: Any]] ?? []
    let by = { (s: String) in chapters.filter { $0["status"] as? String == s }.compactMap { $0["n"] as? Int } }
    var parts: [String] = []
    if !by("processing").isEmpty { parts.append("processing ch" + by("processing").map(String.init).joined(separator: ", ch")) }
    if !by("ready").isEmpty { parts.append("\(by("ready").count) ready") }
    if !by("no transcript").isEmpty { parts.append("no transcript ch" + by("no transcript").map(String.init).joined(separator: ", ch")) }
    if !by("failed").isEmpty { parts.append("failed ch" + by("failed").map(String.init).joined(separator: ", ch")) }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
  }

  var outDir: String { expand(readJSON(configFile)["outDir"] as? String ?? "~/Movies/ux-walk") }

  func recentMenu() -> NSMenu {
    let m = NSMenu()
    let fm = FileManager.default
    let dirs = ((try? fm.contentsOfDirectory(atPath: outDir)) ?? [])
      .filter { fm.fileExists(atPath: "\(outDir)/\($0)/session.json") }
      .sorted(by: >).prefix(10)
    if dirs.isEmpty { m.addItem(NSMenuItem(title: "No walks yet", action: nil, keyEquivalent: "")) }
    for d in dirs {
      let path = "\(outDir)/\(d)"
      let s = readJSON("\(path)/session.json")
      let chapters = s["chapters"] as? [[String: Any]] ?? []
      let ready = chapters.filter { $0["status"] as? String == "ready" }.count
      let title = "\(d.prefix(15).replacingOccurrences(of: "-", with: " ")) · \(s["topic"] as? String ?? String(d.dropFirst(16)))"
        + (chapters.count > 1 || ready < chapters.count ? "  (\(ready)/\(chapters.count) ready)" : "")
      let sub = NSMenu()
      for (label, sel) in [("Open Claude in cmux", #selector(openAgent(_:))), ("Copy agent prompt", #selector(copyPrompt(_:))), ("Open folder", #selector(openPath(_:))), ("Open index", #selector(openIndex(_:)))] {
        let mi = NSMenuItem(title: label, action: sel, keyEquivalent: "")
        mi.target = self
        mi.representedObject = path
        sub.addItem(mi)
      }
      let sessionProject = "\(path)/media/source.cap"
      if fm.fileExists(atPath: sessionProject) {
        let edit = NSMenuItem(title: "Edit recording in Cap", action: #selector(editCap(_:)), keyEquivalent: "")
        edit.target = self; edit.representedObject = sessionProject; sub.addItem(edit)
      }
      // Old walks keep their per-chapter projects and remain editable.
      for chapter in chapters where !fm.fileExists(atPath: sessionProject) {
        let project = "\(path)/\(chapter["dir"] as? String ?? "")/source.cap"
        if fm.fileExists(atPath: project) {
          let edit = NSMenuItem(title: "Edit chapter \(chapter["n"] as? Int ?? 1) in Cap", action: #selector(editCap(_:)), keyEquivalent: "")
          edit.target = self; edit.representedObject = project; sub.addItem(edit)
        }
      }
      let mi = NSMenuItem(title: title, action: nil, keyEquivalent: "")
      mi.submenu = sub
      m.addItem(mi)
    }
    return m
  }

  // MARK: The speakers screen: every audio source found, and who is on each

  struct Sources { var mics: [(name: String, isDefault: Bool)] = []; var calls: [(id: String, name: String, active: Bool)] = [] }

  // The capture helper lists the microphones and the call apps with audio (uxw-capture --sources).
  func detectSources() -> Sources {
    var out = Sources()
    guard let root = launchConfig()["root"] as? String else { return out }
    let (_, text) = run("\(root)/bin/uxw-capture", ["--sources"])
    for line in text.split(separator: "\n") {
      guard let d = line.data(using: .utf8), let e = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { continue }
      if e["ev"] as? String == "mic", let n = e["name"] as? String { out.mics.append((n, e["default"] as? Bool ?? false)) }
      if e["ev"] as? String == "callapp", let id = e["id"] as? String { out.calls.append((id, e["name"] as? String ?? id, e["active"] as? Bool ?? false)) }
    }
    return out
  }

  static let callChoices: [(String, String)] = [("Zoom", "zoom"), ("FaceTime", "facetime"), ("Google Meet (Chrome)", "meet"), ("Slack huddle", "slack"),
                                               ("Microsoft Teams", "teams"), ("Arc", "arc"), ("Safari", "safari")]

  // The rows: microphone and the people at this Mac, call audio and the people on the call. Returns the rows and a
  // function that reads them back as recorder arguments. forCall: a call recording (no "none", no "everything").
  func audioRows(_ src: Sources, forCall: Bool, metering: Bool = true) -> (rows: [(String, NSView)], read: () -> (args: [String], app: String), stop: () -> Void) {
    let d = UserDefaults.standard
    let me = readJSON(configFile)["me"] as? String ?? NSFullUserName().components(separatedBy: " ").first ?? ""
    let mic = NSPopUpButton()
    let mics = src.mics.isEmpty ? [("System default", true)] : src.mics
    mic.addItems(withTitles: mics.map { $0.isDefault ? "\($0.name) (default)" : $0.name })
    let micPeople = NSTextField(string: d.string(forKey: "micPeople") ?? me)
    micPeople.placeholderString = "you first, then anyone in the room"
    // Call audio: the app in a call now first, then auto, everything, none, every known app.
    var choices: [(String, String)] = []
    for c in src.calls where c.active { choices.append(("\(c.name), in a call now", c.id)) }
    choices.append((forCall ? "The app I'm in a call on" : "Auto: whichever app is in a call", "auto"))
    if !forCall { choices.append(("Everything the Mac plays", "system")); choices.append(("None: microphone only", "none")) }
    for (n, id) in App.callChoices where !choices.contains(where: { $0.1 == id }) { choices.append((n, id)) }
    let call = NSPopUpButton()
    call.addItems(withTitles: choices.map(\.0))
    if !src.calls.contains(where: { $0.active }), let last = d.string(forKey: forCall ? "lastCallApp" : "lastWalkCallApp"), let i = choices.firstIndex(where: { $0.1 == last }) { call.selectItem(at: i) }
    // The people in the Meet call open right now (the ux-walk Chrome extension lists them, refreshed every 30 s).
    let meet = readJSON("\(configDir)/meet-participants.json")
    let meetNames = (meet["t"] as? Double).flatMap { Date().timeIntervalSince1970 * 1000 - $0 < 90_000 ? meet["names"] as? [String] : nil } ?? []
    let callPeople = NSTextField(string: meetNames.isEmpty ? (d.string(forKey: "callPeople") ?? "") : meetNames.joined(separator: ", "))
    callPeople.placeholderString = "the people on the call (names you can fix later)"
    let live = src.calls.filter { $0.active }.map(\.name)
    let found = NSTextField(labelWithString: !meetNames.isEmpty ? "Names from the Meet call open in Chrome; captions will name each voice."
      : !live.isEmpty ? "In a call now: \(live.joined(separator: ", ")). Its sound gets its own track."
      : forCall ? "No call app is using the microphone yet: join the call, then record." : "No call right now: Auto records everything the Mac plays.")
    found.font = .systemFont(ofSize: NSFont.smallSystemFontSize); found.textColor = .secondaryLabelColor
    // Live meters beside each source, so you can see which one hears you before you start.
    let meter = { () -> NSLevelIndicator in
      let m = NSLevelIndicator()
      m.levelIndicatorStyle = .continuousCapacity
      m.minValue = 0; m.maxValue = 1; m.warningValue = 0.85; m.criticalValue = 0.95
      m.translatesAutoresizingMaskIntoConstraints = false
      m.widthAnchor.constraint(equalToConstant: 96).isActive = true
      return m
    }
    let micMeter = meter(), callMeter = meter()
    let watcher = LevelWatcher(mic: micMeter, call: callMeter)
    let restart = {
      let m = mics[mic.indexOfSelectedItem]
      if metering { watcher.restart(micName: m.isDefault || src.mics.isEmpty ? nil : m.name, callApp: choices[call.indexOfSelectedItem].1) }
      callPeople.isEnabled = choices[call.indexOfSelectedItem].1 != "none"
    }
    for popup in [mic, call] {
      let t = ClosureTarget { restart() }
      popup.target = t; popup.action = #selector(ClosureTarget.fire)
      watcher.targets.append(t)
    }
    let row = { (popup: NSView, m: NSView) -> NSStackView in
      let st = NSStackView(views: [popup, m]); st.orientation = .horizontal; st.spacing = 10; return st
    }
    restart()
    let header = NSTextField(labelWithString: "Who is talking, and where")
    header.font = .boldSystemFont(ofSize: NSFont.systemFontSize)
    // Just me: a solo walk (talking to agents): only you at the mic, no call audio.
    let justMe = NSButton(checkboxWithTitle: "Just me", target: nil, action: nil)
    let noneIndex = choices.firstIndex { $0.1 == "none" }
    let applyJustMe = {
      let on = justMe.state == .on
      if on { micPeople.stringValue = me; callPeople.stringValue = ""; if let i = noneIndex { call.selectItem(at: i) } }
      micPeople.isEnabled = !on; call.isEnabled = !on; callPeople.isEnabled = !on && choices[call.indexOfSelectedItem].1 != "none"
      restart()
    }
    let jt = ClosureTarget { applyJustMe() }
    justMe.target = jt; justMe.action = #selector(ClosureTarget.fire); watcher.targets.append(jt)
    if !forCall && noneIndex != nil && d.bool(forKey: "justMe") && src.calls.allSatisfy({ !$0.active }) { justMe.state = .on; applyJustMe() }
    let headerRow = NSStackView(views: forCall ? [header] : [header, justMe]); headerRow.orientation = .horizontal; headerRow.spacing = 16
    let rows: [(String, NSView)] = [("", headerRow), ("Microphone", row(mic, micMeter)), ("People here", micPeople), ("Call audio", row(call, callMeter)), ("On the call", callPeople), ("", found)]
    let read = { () -> (args: [String], app: String) in
      watcher.stop()
      let clean = { (f: NSTextField) in f.stringValue.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.joined(separator: ",") }
      let pickedMic = mics[mic.indexOfSelectedItem]
      let app = choices[call.indexOfSelectedItem].1
      d.set(micPeople.stringValue, forKey: "micPeople"); d.set(callPeople.stringValue, forKey: "callPeople")
      if !forCall { d.set(justMe.state == .on, forKey: "justMe") }
      if justMe.state != .on { d.set(app, forKey: forCall ? "lastCallApp" : "lastWalkCallApp") }
      var args: [String] = []
      if !pickedMic.isDefault && !src.mics.isEmpty { args += ["--mic", pickedMic.name] }
      if !clean(micPeople).isEmpty { args += ["--mic-people", clean(micPeople)] }
      if app != "none" && !clean(callPeople).isEmpty { args += ["--call-people", clean(callPeople)] }
      if !forCall { args += ["--call-app", app] }
      return (args, app)
    }
    return (rows, read, { watcher.stop() })
  }

  func snapshotDialog(_ png: String) {
    let kind = ProcessInfo.processInfo.environment["UXW_DIALOG"] ?? "start"
    if kind != "call" { startDialog(initialPurpose: kind == "cap" ? 1 : kind == "attach" ? 2 : 0); return }
    let call = ProcessInfo.processInfo.environment["UXW_DIALOG"] == "call"
    let topic = NSComboBox(); topic.placeholderString = call ? "who or what the call is about" : "what this walk is about"
    let url = NSTextField(string: UserDefaults.standard.string(forKey: "lastURL") ?? (readJSON(configFile)["url"] as? String ?? ""))
    let audio = audioRows(detectSources(), forCall: call)
    let a = NSAlert()
    a.messageText = call ? "Record a call" : "Start a walk"
    a.informativeText = call ? "Join the call first. A Chrome window opens at the start page: share that window in the call." : "Chrome opens at the start page and only its window is recorded."
    a.accessoryView = formView((call ? [("Topic", topic), ("Record", { let b = NSPopUpButton(); b.addItems(withTitles: ["A ux-walk window to share", "Just the conversation"]); return b }()), ("Start page", url)] : [("Topic", topic), ("Start page", url)]) + audio.rows)
    a.addButton(withTitle: call ? "Record" : "Start"); a.addButton(withTitle: "Cancel")
    a.window.appearance = NSAppearance(named: .aqua)
    a.layout()
    // Let the meters take a few readings first.
    let until = Date().addingTimeInterval(1.5)
    while Date() < until { RunLoop.main.run(mode: .default, before: until) }
    a.layout()
    defer { audio.stop() }
    guard let v = a.window.contentView, let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) else { return }
    v.cacheDisplay(in: v.bounds, to: rep)
    try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: png))
  }

  // MARK: Actions

  @objc func startWalk() { startDialog() }

  // One door, with optional media. Every choice calls the same CLI available to an agent.
  func startDialog(initialPurpose: Int = 0) {
    // A URL can arrive during a modal loop or a recording. Keep that work intact.
    if let current = startDialogWindow ?? NSApp.modalWindow {
      NSApp.activate(); current.makeKeyAndOrderFront(nil); return
    }
    guard phase == "idle", !recorder.running else {
      refreshButton()
      alert("A walk is already in progress", "Use the current walk’s controls to continue. Finish it before starting another walk.")
      return
    }
    let cfg = readJSON(configFile), d = UserDefaults.standard
    // Snapshot fixtures exercise this same dialog without touching capture devices or Cap.
    let snapshot = ProcessInfo.processInfo.environment["UXW_DIALOG_SNAPSHOT"]
    let recents = d.stringArray(forKey: "recentTopics") ?? []
    let topic = NSComboBox(); topic.addItems(withObjectValues: recents)
    topic.placeholderString = "what this walk is about"; topic.completes = true
    let purpose = NSPopUpButton()
    purpose.addItems(withTitles: ["Agent instructions", "Shareable video with Cap", "Log an existing Cap recording"])
    purpose.selectItem(at: initialPurpose)
    let url = NSTextField(string: d.string(forKey: "lastURL") ?? (cfg["url"] as? String ?? ""))
    url.placeholderString = "https://… or /path (default from Settings)"
    let camera = cameraPopup(defaultNone: true)
    var audio: (rows: [(String, NSView)], read: () -> (args: [String], app: String), stop: () -> Void)?
    let area = NSPopUpButton(), capCamera = NSPopUpButton(), mic = NSPopUpButton(), session = NSPopUpButton()
    let system = NSButton(checkboxWithTitle: "Record all system audio", target: nil, action: nil)
    var screens: [[String: Any]] = [], cameras: [[String: Any]] = [], mics: [[String: Any]] = [], sessions: [[String: Any]] = []
    var targetsLoaded = false, targetsLoading = false, sessionsLoaded = false, sessionsLoading = false
    var capError = "", sessionError = "", alive = true
    if snapshot != nil {
      screens = [["name": "Example display", "id": 1]]
      cameras = [["displayName": "Example camera", "deviceId": "fixture-camera"]]
      mics = [["name": "Example microphone"]]
      sessions = [["recordingId": "example-session", "path": "/example/walk.cap", "status": "recording", "alive": true]]
      area.addItems(withTitles: ["Whole screen: Example display"])
      capCamera.addItems(withTitles: ["No camera", "Example camera"])
      mic.addItems(withTitles: ["No microphone", "Example microphone"])
      session.addItems(withTitles: ["walk.cap · example-session"])
      targetsLoaded = true; sessionsLoaded = true
    }
    let a = NSAlert(); a.messageText = "Start a walk"
    startDialogWindow = a.window
    defer { startDialogWindow = nil }
    a.addButton(withTitle: "Start"); a.addButton(withTitle: "Cancel")
    a.window.initialFirstResponder = topic
    let details = NSStackView(); details.orientation = .vertical; details.alignment = .leading
    let content = NSStackView(views: [formView([("Purpose", purpose), ("Topic", topic)]), details])
    content.orientation = .vertical; content.alignment = .leading; content.spacing = 12
    a.accessoryView = content
    let message = { (text: String) -> [(String, NSView)] in
      let label = NSTextField(wrappingLabelWithString: text)
      label.preferredMaxLayoutWidth = 340; label.textColor = .secondaryLabelColor
      return [("", label)]
    }
    var render: (() -> Void)!
    render = { [weak self] in
      guard let self, alive else { return }
      for view in details.arrangedSubviews { details.removeArrangedSubview(view); view.removeFromSuperview() }
      let mode = purpose.indexOfSelectedItem
      var rows: [(String, NSView)] = []
      var ready = true
      if mode == 0 {
        a.informativeText = "Record instructions for your agent with a transcript, notes and browser evidence. Chrome opens at the start page and only its window is recorded."
        if audio == nil { audio = self.audioRows(snapshot == nil ? self.detectSources() : Sources(mics: [("Example microphone", true)]), forCall: false, metering: snapshot == nil) }
        rows = [("Start page", url), ("Camera", camera)] + (audio?.rows ?? [])
      } else {
        audio?.stop(); audio = nil
        a.informativeText = mode == 1
          ? "Cap records the selected whole screen; ux-walk adds notes and chapter markers to one continuous recording. Pause affects logging only. Stop ends both. Camera and audio are optional; transcription uses your configured provider."
          : "Attach notes to a live Cap CLI recording. Choose its screen explicitly for screenshots. Devices stay as configured in Cap. Pausing or ending logging keeps Cap recording. Recordings started in Cap’s GUI cannot attach yet."
        if !capError.isEmpty { rows = message(capError); ready = false }
        else if !targetsLoaded {
          rows = message("Loading Cap capture targets…"); ready = false
          if !targetsLoading {
            targetsLoading = true
            self.runCLIAsync(["cap", "targets"]) { status, text in
              guard alive else { return }
              if status == 0, let data = text.data(using: .utf8), let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
                screens = value["screens"] as? [[String: Any]] ?? []
                cameras = value["cameras"] as? [[String: Any]] ?? []
                mics = value["mics"] as? [[String: Any]] ?? []
                area.addItems(withTitles: screens.map { "Whole screen: \($0["name"] as? String ?? String(describing: $0["id"] ?? ""))" })
                capCamera.addItems(withTitles: ["No camera"] + cameras.map { $0["displayName"] as? String ?? "Camera" })
                mic.addItems(withTitles: ["No microphone"] + mics.map { $0["name"] as? String ?? "Microphone" })
                if screens.isEmpty { capError = "No Cap screens available. Check Cap’s Screen Recording permission, then try again." }
              } else { capError = "Cap is unavailable. Install Cap Desktop or run ux-walk cap doctor.\n\(text.trimmingCharacters(in: .whitespacesAndNewlines))" }
              targetsLoaded = true; render()
            }
          }
        } else if mode == 1 {
          rows = [("Record", area), ("Camera", capCamera), ("Microphone", mic), ("", system)]
            + message("Cap keeps cursor and keyboard events locally. Screen contents and all enabled audio are recorded, including during a logging pause. Editing and sharing happen in Cap.")
        } else if !sessionError.isEmpty { rows = message(sessionError); ready = false }
        else if !sessionsLoaded {
          rows = message("Finding active Cap CLI recordings…"); ready = false
          if !sessionsLoading {
            sessionsLoading = true
            self.runCLIAsync(["cap", "sessions"]) { status, text in
              guard alive else { return }
              if status == 0, let data = text.data(using: .utf8), let value = try? JSONSerialization.jsonObject(with: data) {
                let rows = value as? [[String: Any]] ?? (value as? [String: Any])?["sessions"] as? [[String: Any]] ?? []
                sessions = rows.filter { $0["status"] as? String == "recording" && $0["alive"] as? Bool == true && $0["recordingId"] as? String != nil }
                session.addItems(withTitles: sessions.map { row in
                  let name = URL(fileURLWithPath: row["path"] as? String ?? "Cap recording").lastPathComponent
                  return "\(name) · \(row["recordingId"] as? String ?? "")"
                })
                if sessions.isEmpty { sessionError = "No live Cap CLI recording found. Start a shareable video here, or use Cap’s detached CLI recording, then reopen Start a walk." }
              } else { sessionError = "Could not list Cap recordings. Run ux-walk cap sessions for details." }
              sessionsLoaded = true; render()
            }
          }
        } else { rows = [("Recording", session), ("Its screen", area)] + message("Select the same screen Cap is recording. Ending this log leaves that recording running; media can be reconciled after Cap finishes.") }
      }
      details.addArrangedSubview(self.formView(rows))
      a.buttons.first?.isEnabled = ready
      content.frame = NSRect(origin: .zero, size: content.fittingSize)
      a.layout()
    }
    let changed = ClosureTarget { render() }
    purpose.target = changed; purpose.action = #selector(ClosureTarget.fire)
    render()
    if let snapshot {
      a.window.appearance = NSAppearance(named: .aqua); a.layout()
      // Let AppKit lay out the real controls; fixtures never open a recording or a device.
      let until = Date().addingTimeInterval(0.15)
      while Date() < until { RunLoop.main.run(mode: .default, before: until) }
      if let view = a.window.contentView, let image = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
        view.cacheDisplay(in: view.bounds, to: image)
        // Visual-effect window backgrounds are transparent offscreen. Supply their backing for the PNG.
        let output = NSImage(size: view.bounds.size)
        output.lockFocus()
        NSColor.windowBackgroundColor.setFill(); NSRect(origin: .zero, size: view.bounds.size).fill()
        if let cgImage = image.cgImage { NSImage(cgImage: cgImage, size: view.bounds.size).draw(in: NSRect(origin: .zero, size: view.bounds.size)) }
        output.unlockFocus()
        if let tiff = output.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff) {
          try? bitmap.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: snapshot))
        }
      }
      alive = false; audio?.stop(); render = nil; _ = changed
      return
    }
    NSApp.activate()
    let accepted = a.runModal() == .alertFirstButtonReturn
    alive = false
    defer { audio?.stop(); render = nil; _ = changed }
    guard accepted else { return }
    let t = topic.stringValue.trimmingCharacters(in: .whitespaces)
    d.set(Array(([t] + recents.filter { $0 != t }).filter { !$0.isEmpty }.prefix(12)), forKey: "recentTopics")
    var extra: [String], startURL = ""
    if purpose.indexOfSelectedItem == 0 {
      startURL = url.stringValue.trimmingCharacters(in: .whitespaces)
      d.set(startURL, forKey: "lastURL")
      extra = (audio?.read().args ?? []) + bubbleArgs(camera)
      recordingWholeScreen = false
    } else {
      guard area.indexOfSelectedItem >= 0, area.indexOfSelectedItem < screens.count else { return }
      extra = ["--capture", "cap", "--no-browser", "--screen-id", String(describing: screens[area.indexOfSelectedItem]["id"] ?? "")]
      if purpose.indexOfSelectedItem == 2 {
        guard session.indexOfSelectedItem >= 0, session.indexOfSelectedItem < sessions.count,
              let id = sessions[session.indexOfSelectedItem]["recordingId"] as? String else { return }
        extra += ["--attach-cap", id]
      } else {
        extra += ["--fps", "30"]
        if capCamera.indexOfSelectedItem > 0, let id = cameras[capCamera.indexOfSelectedItem - 1]["deviceId"] as? String { extra += ["--camera", id] }
        if mic.indexOfSelectedItem > 0, let name = mics[mic.indexOfSelectedItem - 1]["name"] as? String { extra += ["--mic", name] }
        else { extra.append("--no-mic") }
        if system.state == .on { extra.append("--system-audio") }
      }
      recordingWholeScreen = true
    }
    state = [:]; lastReply = ""; walkDir = nil
    do { try recorder.start(topic: t, url: startURL, extra: extra); phase = "starting" }
    catch { bubble.hide(); alert("Could not start the walk", error.localizedDescription) }
    refreshButton()
  }

  // Cap queries never block the app’s main thread or alter Cap settings.
  func runCLIAsync(_ args: [String], completion: @escaping (Int32, String) -> Void) {
    let launch = launchConfig()
    guard let root = launch["root"] as? String, let node = launch["node"] as? String else { completion(-1, "Run ux-walk’s install.sh first."); return }
    DispatchQueue.global(qos: .userInitiated).async {
      let result = run(node, ["\(root)/bin/ux-walk"] + args)
      DispatchQueue.main.async { completion(result.0, result.1) }
    }
  }

  // Zoom, FaceTime, Meet...: by default the ux-walk Chrome window opens for you to share in the call and is
  // recorded like a walk (clicks, console, requests); your mic and the call's own sound go on separate tracks,
  // transcribed apart, so you and the people on the call are named by track. "Just the conversation" records
  // the call app's own window instead.
  @objc func startCall() {
    let d = UserDefaults.standard
    let cfg = readJSON(configFile)
    let topic = NSComboBox()
    topic.addItems(withObjectValues: d.stringArray(forKey: "recentCallTopics") ?? [])
    topic.placeholderString = "who or what the call is about"
    let show = NSPopUpButton()
    show.addItems(withTitles: ["A ux-walk window to share", "Just the conversation"])
    show.selectItem(at: d.integer(forKey: "callShow") == 1 ? 1 : 0)
    let url = NSTextField()
    url.stringValue = d.string(forKey: "lastURL") ?? (cfg["url"] as? String ?? "")
    url.placeholderString = "https://… or /path (default from Settings)"
    let audio = audioRows(detectSources(), forCall: true)
    let form = formView([("Topic", topic), ("Record", show), ("Start page", url)] + audio.rows)
    guard ask("Record a call", "Join the call first. A Chrome window opens at the start page: share that window in the call. ux-walk records it with every click, console message and request, and your mic and the call's sound on separate tracks, so the transcript names you apart from them. \"Just the conversation\" records the call's own window instead. Tell the people on the call you are recording.", form, ok: "Record", focus: topic) else { audio.stop(); return }
    let t = topic.stringValue.trimmingCharacters(in: .whitespaces)
    let recents = d.stringArray(forKey: "recentCallTopics") ?? []
    d.set(Array(([t] + recents.filter { $0 != t }).filter { !$0.isEmpty }.prefix(12)), forKey: "recentCallTopics")
    let conversation = show.indexOfSelectedItem == 1
    d.set(conversation ? 1 : 0, forKey: "callShow")
    let start = url.stringValue.trimmingCharacters(in: .whitespaces)
    if !conversation { d.set(start, forKey: "lastURL") }
    state = [:]; lastReply = ""; walkDir = nil
    let picked = audio.read()
    var extra = picked.args
    if conversation { extra.append("--conversation") } else if !start.isEmpty { extra.append(start) }
    recordingWholeScreen = false
    do {
      try recorder.start(topic: t, url: picked.app == "auto" ? "" : picked.app, extra: extra, mode: "call")
      phase = "starting"
    } catch {
      alert("Could not start recording the call", error.localizedDescription)
    }
    refreshButton()
  }

  // The camera choice shared by walks and videos (UserDefaults keeps the last one).
  func cameraPopup(defaultNone: Bool) -> NSPopUpButton {
    let p = NSPopUpButton()
    let names = ["No camera"] + CameraBubble.cameras().map(\.localizedName)
    p.addItems(withTitles: names)
    let key = defaultNone ? "lastWalkCamera" : "lastCamera"
    if let last = UserDefaults.standard.string(forKey: key), let i = names.firstIndex(of: last) { p.selectItem(at: i) }
    else if !defaultNone && names.count > 1 { p.selectItem(at: 1) }
    p.identifier = NSUserInterfaceItemIdentifier(key)
    return p
  }
  // Shows the bubble for the chosen camera and returns the recorder argument naming its window.
  func bubbleArgs(_ camera: NSPopUpButton) -> [String] {
    let name = camera.titleOfSelectedItem ?? "No camera"
    if let key = camera.identifier?.rawValue { UserDefaults.standard.set(name, forKey: key) }
    guard name != "No camera" else { return [] }
    bubble.show(camera: name)
    return bubble.panel.map { ["--bubble-window", String($0.windowNumber)] } ?? []
  }

  // Loom-style: a walk filmed as a video, with your face in a bubble. The ux-walk browser keeps its full log
  // (clicks, console, requests, database calls); "Whole screen" films everything instead of the browser window.
  @objc func startVideo() {
    let cfg = readJSON(configFile)
    let d = UserDefaults.standard
    let topic = NSComboBox()
    topic.addItems(withObjectValues: d.stringArray(forKey: "recentVideoTopics") ?? [])
    topic.placeholderString = "what the video shows"
    let url = NSTextField(string: d.string(forKey: "lastURL") ?? (cfg["url"] as? String ?? ""))
    url.placeholderString = "https://… or /path (default from Settings)"
    let area = NSPopUpButton()
    let screens = NSScreen.screens
    area.addItems(withTitles: ["The ux-walk browser window"] + screens.enumerated().map { i, s in "Whole screen: \(s.localizedName)\(i == 0 ? " (main)" : "")" })
    area.selectItem(at: min(d.integer(forKey: "lastVideoArea"), area.numberOfItems - 1))
    let camera = cameraPopup(defaultNone: false)
    let audio = audioRows(detectSources(), forCall: false)
    let form = formView([("Topic", topic), ("Start page", url), ("Record", area), ("Camera", camera)] + audio.rows)
    guard ask("Record a video", "A walk with your face in it: the ux-walk browser logs every click, console message and request as usual. Drag the bubble to move it, drag its edge to resize, hover it for shape. The ux-walk controls stay out of the video.", form, ok: "Record", focus: topic) else { audio.stop(); return }
    let t = topic.stringValue.trimmingCharacters(in: .whitespaces)
    let recents = d.stringArray(forKey: "recentVideoTopics") ?? []
    d.set(Array(([t] + recents.filter { $0 != t }).filter { !$0.isEmpty }.prefix(12)), forKey: "recentVideoTopics")
    d.set(url.stringValue, forKey: "lastURL")
    d.set(area.indexOfSelectedItem, forKey: "lastVideoArea")
    var extra = audio.read().args + bubbleArgs(camera)
    if area.indexOfSelectedItem > 0 { extra += ["--display", String(area.indexOfSelectedItem - 1)] }
    recordingWholeScreen = area.indexOfSelectedItem > 0
    state = [:]; lastReply = ""; walkDir = nil
    do {
      try recorder.start(topic: t, url: url.stringValue.trimmingCharacters(in: .whitespaces), extra: extra, mode: "video")
      phase = "starting"
    } catch {
      bubble.hide()
      alert("Could not start the video", error.localizedDescription)
    }
    refreshButton()
  }

  // Kept as a single optional purpose, rather than a second primary recording workflow.
  @objc func startCapVideo() { startDialog(initialPurpose: 1) }

  @objc func editCap(_ sender: NSMenuItem) {
    guard let project = sender.representedObject as? String else { return }
    let launch = launchConfig()
    guard let root = launch["root"] as? String, let node = launch["node"] as? String else { return }
    let (status, _) = run(node, ["\(root)/bin/ux-walk", "cap", "edit", project])
    if status != 0 { alert("Could not open Cap", "The source project was preserved. Check that Cap Desktop is installed and this recording is complete.") }
  }

  @objc func nextChapter() {
    let name = NSTextField()
    name.placeholderString = "optional"
    guard ask(continuousCap ? "Chapter marker" : "Next chapter", continuousCap ? "Adds a chapter boundary without interrupting Cap. Chapter media and transcripts are processed after the recording ends." : "The chapter just recorded is processed in the background.", formView([("Name", name)]), ok: continuousCap ? "Add chapter" : "Start chapter", focus: name) else { return }
    recorder.send(["cmd": "next", "name": name.stringValue])
  }

  @objc func marker() {
    let text = NSTextField()
    text.placeholderString = "bug: Add does nothing"
    guard ask("Drop a marker", "It goes into the timeline at this moment.", formView([("Marker", text)]), ok: "Mark", focus: text) else { return }
    recorder.send(["cmd": "mark", "text": text.stringValue.isEmpty ? "marker" : text.stringValue])
  }

  @objc func pause() { recorder.send(["cmd": "pause"]) }

  @objc func addSpeaker() {
    let names = NSTextField()
    names.placeholderString = "Clay"
    guard ask("Someone joined", "They are a speaker from now on.", formView([("Names", names)]), ok: "Add", focus: names), !names.stringValue.isEmpty else { return }
    recorder.send(["cmd": "speaker", "names": names.stringValue.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }])
  }

  @objc func stop() { recorder.send(["cmd": "stop"]) }
  @objc func detachCap() { recorder.send(["cmd": "detach"]) }
  @objc func openWalk() { if let d = walkDir { NSWorkspace.shared.open(URL(fileURLWithPath: d)) } }
  @objc func openOut() { NSWorkspace.shared.open(URL(fileURLWithPath: outDir)) }
  @objc func openPath(_ s: NSMenuItem) { if let p = s.representedObject as? String { NSWorkspace.shared.open(URL(fileURLWithPath: p)) } }
  @objc func openIndex(_ s: NSMenuItem) { if let p = s.representedObject as? String { NSWorkspace.shared.open(URL(fileURLWithPath: "\(p)/index.md")) } }
  @objc func showLog() {
    if !FileManager.default.fileExists(atPath: logFile) { appendLog("log started") }
    NSWorkspace.shared.open(URL(fileURLWithPath: logFile))
  }
  @objc func quit() { NSApp.terminate(nil) }

  // ux-walk agent <folder>: a Claude Code session (opus) in a new cmux workspace with the walk's prompt.
  @objc func openAgent(_ s: NSMenuItem) {
    guard let p = s.representedObject as? String else { return }
    let launch = launchConfig()
    guard let root = launch["root"] as? String, let node = launch["node"] as? String else { return }
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: node)
    proc.arguments = ["\(root)/bin/ux-walk", "agent", p]
    var env = ProcessInfo.processInfo.environment
    if let path = launch["path"] as? String { env["PATH"] = path }
    proc.environment = env
    let err = Pipe()
    proc.standardError = err
    proc.terminationHandler = { [weak self] pr in
      guard pr.terminationStatus != 0 else { return }
      let msg = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
      DispatchQueue.main.async { self?.alert("Could not open Claude in cmux", msg.trimmingCharacters(in: .whitespacesAndNewlines)) }
    }
    do { try proc.run() } catch { alert("Could not open Claude in cmux", error.localizedDescription) }
  }

  @objc func copyPrompt(_ s: NSMenuItem) {
    guard let p = s.representedObject as? String else { return }
    let index = (try? String(contentsOfFile: "\(p)/index.md", encoding: .utf8)) ?? ""
    let line = index.split(separator: "\n").first { $0.hasPrefix("For agents: ") }
      .map { $0.dropFirst("For agents: ".count).trimmingCharacters(in: CharacterSet(charactersIn: "`")) } ?? "/ux-walk \(p)"
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(line, forType: .string)
  }

  @objc func toggleBar() {
    let on = UserDefaults.standard.object(forKey: "showBar") as? Bool != false
    UserDefaults.standard.set(!on, forKey: "showBar")
    refreshButton()
  }

  @objc func toggleLogin() {
    let fm = FileManager.default
    if fm.fileExists(atPath: agentPlist) { try? fm.removeItem(atPath: agentPlist); return }
    let plist: [String: Any] = ["Label": "com.onc4ll.ux-walk", "ProgramArguments": ["/usr/bin/open", "-a", Bundle.main.bundlePath], "RunAtLoad": true]
    try? fm.createDirectory(atPath: (agentPlist as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    if let d = try? PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0) { fm.createFile(atPath: agentPlist, contents: d) }
  }

  @objc func settings() {
    if embedded {
      var components = URLComponents(string: "cap-ux://action")!
      components.queryItems = [URLQueryItem(name: "value", value: "{\"open_settings\":{\"page\":\"general\"}}")]
      if let url = components.url { _ = run("/usr/bin/open", ["-a", capUXBundle.path, url.absoluteString]) }
      return
    }
    let cfg = readJSON(configFile)
    let me = NSTextField(string: cfg["me"] as? String ?? "")
    me.placeholderString = NSFullUserName().components(separatedBy: " ").first ?? ""
    let url = NSTextField(string: cfg["url"] as? String ?? "")
    url.placeholderString = "https://onc4ll.com"
    let out = NSTextField(string: cfg["outDir"] as? String ?? "~/Movies/ux-walk")
    let pick = NSPopUpButton()
    pick.addItems(withTitles: transcribers.map(\.name))
    let current = cfg["transcriber"] as? String ?? "elevenlabs"
    pick.selectItem(at: transcribers.firstIndex { $0.id == current } ?? 0)
    let key = NSSecureTextField()
    let keyNote = NSTextField(labelWithString: "")
    keyNote.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
    keyNote.textColor = .secondaryLabelColor
    let showKeyState = {
      let t = transcribers[pick.indexOfSelectedItem]
      key.isEnabled = !t.keychain.isEmpty
      key.placeholderString = t.keychain.isEmpty ? "" : keychainHas(t.keychain) ? "saved in Keychain; paste to replace" : "paste your \(t.name) API key"
      keyNote.stringValue = t.keyURL.isEmpty ? "" : "Get a key: \(t.keyURL)"
    }
    showKeyState()
    let handler = ClosureTarget { showKeyState() }
    pick.target = handler
    pick.action = #selector(ClosureTarget.fire)
    let ending = NSPopUpButton()
    ending.addItems(withTitles: ["Copy the agent prompt", "Open Claude (Opus) in cmux"])
    ending.selectItem(at: cfg["agent"] as? String == "cmux" ? 1 : 0)
    let form = formView([("Your name", me), ("Start page", url), ("Recordings", out), ("Transcriber", pick), ("API key", key), ("", keyNote), ("When a walk ends", ending)])
    guard ask("ux-walk settings", "Saved to \(configFile.replacingOccurrences(of: home, with: "~")); the terminal ux-walk uses the same file.", form, ok: "Save") else { return }
    _ = handler
    let t = transcribers[pick.indexOfSelectedItem]
    writeConfig(["me": me.stringValue, "url": url.stringValue, "outDir": out.stringValue, "transcriber": t.id, "agent": ending.indexOfSelectedItem == 1 ? "cmux" : "copy"])
    let k = key.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    if !k.isEmpty && !t.keychain.isEmpty && !keychainSet(t.keychain, k) { alert("Could not save the key", "The Keychain refused it.") }
  }

  // MARK: Events from the recorder

  func handle(_ e: [String: Any]) {
    let ev = e["ev"] as? String ?? ""
    switch ev {
    case "ready":
      walkDir = e["dir"] as? String
      phase = "recording"
      if let pid = e["chromePid"] as? Int, let chrome = NSRunningApplication(processIdentifier: pid_t(pid)) {
        chrome.activate()
        // The bubble shows where it overlaps the browser window, so it starts in that window's corner.
        if bubble.windowID != nil, !recordingWholeScreen, let big = windowBounds(pid: pid) {
          bubble.place(inside: big)
          bubble.follow(pid: pid)
        }
      }
    case "state":
      state = e
      walkDir = e["dir"] as? String ?? walkDir
      if e["finishing"] as? Bool == true { phase = "finishing" }
      else if e["paused"] as? Bool == true { phase = "paused" }
      else if e["recording"] as? Bool == true { phase = "recording" }
    case "reply":
      lastReply = e["text"] as? String ?? ""
    case "log":
      let text = e["text"] as? String ?? ""
      appendLog(text)
      if text.contains("ready: ") || text.contains("processing failed") { lastReply = text }
      if text.hasPrefix("Stopping (") { phase = "finishing" }
    case "warn":
      appendLog("warn: \(e["text"] as? String ?? "")")
      if e["kind"] as? String == "meet" { notify("Turn on captions in Meet", "So ux-walk can tell who is speaking. CC in the Meet toolbar, or press C.") }
      // The walk records anyway; a key now means the chapters get their speech when they finish.
      if e["kind"] as? String == "transcriber" {
        DispatchQueue.main.async { [weak self] in
          let a = NSAlert()
          a.messageText = "This walk will have no transcript yet"
          a.informativeText = "\(e["text"] as? String ?? "")\n\nIt keeps recording. Add a key in Settings now and the chapters still to finish get their speech; finished ones can be redone with: ux-walk process <folder>."
          a.addButton(withTitle: "Open Settings")
          a.addButton(withTitle: "Keep recording")
          NSApp.activate()
          if a.runModal() == .alertFirstButtonReturn { self?.settings() }
        }
      }
    case "ask":
      showAsk(e)
    case "ask-cancel":
      if let a = openAsk, a.id == e["id"] as? Int { NSApp.abortModal(); a.alert.window.orderOut(nil) }
    case "done":
      let handoff = e["handoff"] as? String ?? ""
      appendLog("done: \(handoff)")
      if e["ok"] as? Bool == false {
        notify("Walk recording incomplete", "The log was retained. Check the recording error before treating its video as complete.")
      } else if e["pendingMedia"] as? Bool == true {
        notify("Walk log ready · Cap still recording", "Notes and evidence are ready. After Cap finishes, run ux-walk cap reconcile on this walk to prepare its video.")
      } else {
        notify("Walk ready", e["agent"] as? String == "cmux" ? "Claude (Opus) has the prompt in a new cmux workspace." : e["copied"] as? Bool == true ? "The agent prompt is on the clipboard." : handoff)
      }
    case "error":
      appendLog("error: \(e["message"] as? String ?? "")")
      alert("The walk stopped", e["message"] as? String ?? "unknown error")
    default:
      break
    }
    refreshButton()
  }

  func showAsk(_ e: [String: Any]) {
    guard let id = e["id"] as? Int else { return }
    if quitting { recorder.send(["cmd": "answer", "id": id, "text": ""]); return }
    let context = (e["context"] as? [String] ?? []).suffix(12).joined(separator: "\n")
    let field = NSTextField()
    field.frame = NSRect(x: 0, y: 0, width: 420, height: 24)
    let a = NSAlert()
    a.messageText = (e["text"] as? String ?? "").replacingOccurrences(of: " (Enter to skip)", with: "")
    a.informativeText = context
    a.accessoryView = field
    a.addButton(withTitle: "OK")
    a.addButton(withTitle: "Skip")
    a.window.initialFirstResponder = field
    openAsk = (id, a)
    NSApp.activate()
    let r = a.runModal()
    if openAsk?.id == id { openAsk = nil }
    recorder.send(["cmd": "answer", "id": id, "text": r == .alertFirstButtonReturn ? field.stringValue : ""])
  }

  func exited(_ code: Int32, _ stderr: String) {
    bubble.hide()
    appendLog("recorder exited (\(code))")
    let failed = code != 0 && phase != "idle" && !quitting
    phase = "idle"; state = [:]; lastReply = ""
    refreshButton()
    if quitting { NSApp.reply(toApplicationShouldTerminate: true); return }
    if failed {
      let tail = stderr.split(separator: "\n").suffix(6).joined(separator: "\n")
      alert("The recorder stopped (\(code))", tail.isEmpty ? "See the log (menu > Show log)." : tail)
    }
  }

  // MARK: Dialogs

  func formView(_ rows: [(String, NSView)]) -> NSView {
    let grid = NSGridView(views: rows.map { label, view -> [NSView] in
      let l = NSTextField(labelWithString: label)
      l.alignment = .right
      view.translatesAutoresizingMaskIntoConstraints = false
      if !(view is NSPopUpButton) && !(view.isKind(of: NSTextField.self) && !(view as! NSTextField).isEditable) {
        view.widthAnchor.constraint(equalToConstant: 340).isActive = true
      }
      return [l, view]
    })
    grid.rowSpacing = 8
    grid.columnSpacing = 8
    grid.column(at: 0).xPlacement = .trailing
    grid.frame = NSRect(origin: .zero, size: grid.fittingSize)
    return grid
  }

  func ask(_ title: String, _ info: String, _ view: NSView, ok: String, focus: NSView? = nil) -> Bool {
    let a = NSAlert()
    a.messageText = title
    a.informativeText = info
    a.accessoryView = view
    a.addButton(withTitle: ok)
    a.addButton(withTitle: "Cancel")
    if let focus { a.window.initialFirstResponder = focus }
    NSApp.activate()
    return a.runModal() == .alertFirstButtonReturn
  }

  func alert(_ title: String, _ info: String) {
    let a = NSAlert()
    a.messageText = title
    a.informativeText = info
    NSApp.activate()
    a.runModal()
  }
}

// The speakers screen's live meters: uxw-capture --levels on the chosen mic and call audio, ten readings a second.
final class LevelWatcher {
  let mic: NSLevelIndicator, call: NSLevelIndicator
  private var proc: Process?, input: FileHandle?, buffer = Data()
  var targets: [ClosureTarget] = []  // keeps the popups' actions alive
  init(mic: NSLevelIndicator, call: NSLevelIndicator) { self.mic = mic; self.call = call }

  func restart(micName: String?, callApp: String) {
    stop()
    guard let root = launchConfig()["root"] as? String else { return }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "\(root)/bin/uxw-capture")
    p.arguments = ["--levels", "--call-app", callApp] + (micName.map { ["--mic", $0] } ?? [])
    let out = Pipe(), inp = Pipe()
    p.standardOutput = out; p.standardInput = inp; p.standardError = FileHandle.nullDevice
    out.fileHandleForReading.readabilityHandler = { [weak self] h in
      let d = h.availableData
      DispatchQueue.main.async { self?.take(d) }
    }
    do { try p.run(); proc = p; input = inp.fileHandleForWriting } catch { appendLog("level meter: \(error.localizedDescription)") }
  }

  private func take(_ d: Data) {
    buffer.append(d)
    while let nl = buffer.firstIndex(of: 0x0A) {
      let line = buffer.subdata(in: buffer.startIndex..<nl)
      buffer.removeSubrange(buffer.startIndex...nl)
      guard let e = try? JSONSerialization.jsonObject(with: line) as? [String: Any], e["ev"] as? String == "level" else { continue }
      // -60 dBFS (silence) to 0 dBFS (full scale).
      let norm = { (v: Any?) in min(1, max(0, ((v as? Double) ?? -160) / 60 + 1)) }
      mic.doubleValue = norm(e["mic"]); call.doubleValue = norm(e["call"])
    }
  }

  func stop() {
    try? input?.close(); proc?.terminate(); proc = nil; input = nil
    mic.doubleValue = 0; call.doubleValue = 0
  }
}

// A popup's action as a closure (target-action needs an object).
final class ClosureTarget: NSObject {
  let f: () -> Void
  init(_ f: @escaping () -> Void) { self.f = f }
  @objc func fire() { f() }
}

// A write to a recorder that just exited must not kill the app.
if embedded {
  setenv("UXW_CAP_BINARY", capUXBundle.appendingPathComponent("Contents/MacOS/cap-cli").path, 1)
}
signal(SIGPIPE, SIG_IGN)
let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
