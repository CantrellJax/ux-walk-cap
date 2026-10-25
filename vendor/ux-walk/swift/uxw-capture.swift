// uxw-capture: record ONE window (plus the microphone) to MP4 with ScreenCaptureKit.
// The window is followed when it moves or is covered. Chapters rotate to a new file without
// stopping the stream.
//
// Usage: uxw-capture --out <file.mp4> (--pid <pid> | --app <name> | --window-id <id>)
//                    [--fps 15] [--bitrate 2500000] [--mic <name substring>] [--no-mic] [--max-width 1920]
//                    [--call-audio]   also record what the Mac plays (a FaceTime or Zoom call) as a
//                                     second audio track, so voices on the call can be told from
//                                     the person at the microphone
//                    [--call-app auto|<id>]  the call track is only the call app's sound (a Core Audio process tap
//                                     on Zoom, FaceTime, Meet in Chrome/Arc/Safari, Slack or Teams; ids below);
//                                     auto: the call app using the microphone. Falls back to everything the Mac
//                                     plays when no call app is found or the tap fails. Implies --call-audio.
//                    [--title <text>] with --app: the window whose title contains this (a Meet tab's window)
//                    [--bubble-window <id>] with a window target: also draw this window (the app's camera
//                                     bubble) over it. Only those two windows are drawn, cropped to the target window
//                                     and following it as it moves; the bubble shows where it overlaps the window.
//        uxw-capture --out <file.mp4> --display <n>   the whole display n (0 = main) instead of one window: video mode,
//                                     so the camera bubble on screen is in the recording (windows set to not be
//                                     shared, like the floating control bar, stay out)
//        uxw-capture --list            (print capturable windows as JSON and exit)
//        uxw-capture --calls           (print the call apps playing or recording audio as JSON and exit)
//        uxw-capture --sources         (the microphones, the default first, and the call apps, as JSON, then exit)
//        uxw-capture --levels [--mic <name>] [--call-app auto|<id>|system|none]
//                                      live loudness for the speakers screen: {"ev":"level","mic":-42,"call":-61}
//                                      ten times a second (dBFS), until stdin closes. Records nothing.
//        uxw-capture --hotkeys         the recorder shortcuts, system-wide: Option+Shift+N / M / P (and
//                                      Ctrl+Option+N / M / P) print {"ev":"hotkey","key":"n"} whichever app
//                                      is in front; app switches print {"ev":"front","pid":..,"app":".."}.
//                                      Exits when stdin closes. No permission needed (Carbon hot keys).
// stdin:  "rotate <file.mp4>"  finish the current file, keep recording into the next (also resumes after pause)
//         "pause"              finish the current file, record nothing until the next rotate
//         "stop"               finish the current file and exit
// stdout: one JSON object per line: ready | started | finished | error
// Needs macOS 15+ (microphone capture). Permissions come from the terminal app that launches it.

import AppKit
import AudioToolbox
import Carbon.HIToolbox
import CoreAudio
import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

setvbuf(stdout, nil, _IOLBF, 0)
_ = NSApplication.shared  // connects to the window server (CoreGraphics display calls need it)

func emit(_ obj: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: data, encoding: .utf8) {
    print(s)
  }
}

func fail(_ msg: String) -> Never {
  emit(["ev": "error", "message": msg])
  exit(1)
}

var opts: [String: String] = [:]
var flags = Set<String>()
do {
  var it = CommandLine.arguments.dropFirst().makeIterator()
  while let a = it.next() {
    guard a.hasPrefix("--") else { fail("unexpected argument \(a)") }
    let k = String(a.dropFirst(2))
    if ["no-mic", "list", "call-audio", "hotkeys", "calls", "sources", "levels"].contains(k) { flags.insert(k); continue }
    guard let v = it.next() else { fail("missing value for \(a)") }
    opts[k] = v
  }
}

func nowEpochMs() -> Double { Date().timeIntervalSince1970 * 1000 }

// Wall-clock epoch ms of a host-clock presentation timestamp (SCK stamps samples on the host clock).
func epochMs(of pts: CMTime) -> Double {
  let hostNow = CMClockGetTime(CMClockGetHostTimeClock()).seconds
  return nowEpochMs() - (hostNow - pts.seconds) * 1000
}

func hostNow() -> CMTime { CMClockGetTime(CMClockGetHostTimeClock()) }

final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
  let queue = DispatchQueue(label: "uxw.samples")
  let width: Int, height: Int, bitrate: Int, withMic: Bool
  var withCall = false
  var writer: AVAssetWriter?
  var videoIn: AVAssetWriterInput?
  var audioIn: AVAssetWriterInput?
  var callIn: AVAssetWriterInput?   // what the Mac plays: the other side of a call
  var started = false
  var firstPTS = CMTime.invalid
  var lastPTS = CMTime.invalid      // latest sample written to the current file (video or audio)
  var lastVideo: CMSampleBuffer?    // latest frame, reused when the window is still
  var path: String
  var stopRequested = false

  init(path: String, width: Int, height: Int, bitrate: Int, withMic: Bool) {
    self.path = path; self.width = width; self.height = height; self.bitrate = bitrate; self.withMic = withMic
  }

  func makeWriter(_ p: String) throws {
    let url = URL(fileURLWithPath: p)
    try? FileManager.default.removeItem(at: url)
    let w = try AVAssetWriter(outputURL: url, fileType: .mp4)
    let v = AVAssetWriterInput(mediaType: .video, outputSettings: [
      AVVideoCodecKey: AVVideoCodecType.h264,
      AVVideoWidthKey: width, AVVideoHeightKey: height,
      AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: bitrate,
        AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
        AVVideoAllowFrameReorderingKey: false,
      ],
    ])
    v.expectsMediaDataInRealTime = true
    w.add(v)
    var a: AVAssetWriterInput?
    if withMic {
      let ai = AVAssetWriterInput(mediaType: .audio, outputSettings: [
        AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48000, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 96000,
      ])
      ai.expectsMediaDataInRealTime = true
      w.add(ai)
      a = ai
    }
    var c: AVAssetWriterInput?
    if withCall {
      // Always the second audio track (after the mic), so processing can find it by position.
      let ci = AVAssetWriterInput(mediaType: .audio, outputSettings: [
        AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48000, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 64000,
      ])
      ci.expectsMediaDataInRealTime = true
      w.add(ci)
      c = ci
    }
    writer = w; videoIn = v; audioIn = a; callIn = c; started = false; firstPTS = .invalid; lastPTS = .invalid; path = p
  }

  func retimed(_ sb: CMSampleBuffer, at t: CMTime) -> CMSampleBuffer? {
    var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: t, decodeTimeStamp: .invalid)
    var out: CMSampleBuffer?
    CMSampleBufferCreateCopyWithNewTiming(allocator: nil, sampleBuffer: sb, sampleTimingEntryCount: 1,
                                          sampleTimingArray: &timing, sampleBufferOut: &out)
    return out
  }

  // All below run on `queue`.
  func appendVideo(_ sb: CMSampleBuffer, at pts: CMTime) {
    guard let w = writer, let v = videoIn else { return }
    if !started {
      guard w.startWriting() else { emit(["ev": "error", "message": "startWriting: \(w.error?.localizedDescription ?? "?")"]); return }
      w.startSession(atSourceTime: pts)
      started = true; firstPTS = pts
      emit(["ev": "started", "path": path, "epochMs": Int(epochMs(of: pts))])
    }
    guard pts > lastPTS || !lastPTS.isValid else { return }
    if v.isReadyForMoreMediaData, let b = (sb.presentationTimeStamp == pts ? sb : retimed(sb, at: pts)) {
      v.append(b); lastPTS = pts
    }
  }

  func finishCurrent(then: @escaping () -> Void) {
    guard let w = writer else { then(); return }
    if !started { writer = nil; w.cancelWriting(); emit(["ev": "finished", "path": path, "durationS": 0, "empty": true]); then(); return }
    // Hold the last frame to "now" so a still window still yields a full-length video track.
    let end = hostNow()
    if let last = lastVideo { appendVideo(last, at: end) }
    let p = path, dur = (lastPTS - firstPTS).seconds
    let v = videoIn, a = audioIn, c = callIn
    writer = nil; videoIn = nil; audioIn = nil; callIn = nil
    w.endSession(atSourceTime: lastPTS)
    v?.markAsFinished(); a?.markAsFinished(); c?.markAsFinished()
    w.finishWriting {
      if w.status == .completed { emit(["ev": "finished", "path": p, "durationS": dur]) }
      else { emit(["ev": "error", "message": "finish failed for \(p): \(w.error?.localizedDescription ?? "unknown")"]) }
      then()
    }
  }

  // Start the next chapter now, without waiting for the window to change.
  func rotate(to next: String) {
    finishCurrent {}
    do { try makeWriter(next) } catch { emit(["ev": "error", "message": "cannot open \(next): \(error)"]); return }
    if let last = lastVideo { appendVideo(last, at: hostNow()) }
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
    guard sb.isValid, !stopRequested else { return }
    let pts = sb.presentationTimeStamp
    switch type {
    case .screen:
      // Skip idle frames (no new pixels).
      guard let att = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
            let raw = att.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete,
            sb.imageBuffer != nil else { return }
      lastVideo = sb
      appendVideo(sb, at: pts)
    case .microphone:
      guard started, let a = audioIn, pts >= firstPTS, a.isReadyForMoreMediaData else { return }
      a.append(sb)
    case .audio:
      break  // the window stream does not capture app audio; call audio arrives through CallTap
    @unknown default:
      break
    }
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    queue.async { self.finishCurrent { emit(["ev": "error", "message": "stream stopped: \(error.localizedDescription)"]); exit(2) } }
  }

  func appendCall(_ sb: CMSampleBuffer) {
    guard started, let c = callIn, sb.presentationTimeStamp >= firstPTS, c.isReadyForMoreMediaData else { return }
    c.append(sb)
  }
}

// The Mac's sound output (every app but this one), from a second, audio-only stream on the display.
// Its frames are tiny and dropped. If it stops, the recording carries on without it.
final class CallTap: NSObject, SCStreamOutput, SCStreamDelegate {
  let rec: Recorder
  init(_ rec: Recorder) { self.rec = rec }
  func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .audio, sb.isValid, !rec.stopRequested else { return }
    rec.appendCall(sb)
  }
  func stream(_ stream: SCStream, didStopWithError error: Error) {
    emit(["ev": "warn", "message": "call audio stopped: \(error.localizedDescription)"])
  }
}
var callStream: SCStream?
var callTap: CallTap?

// MARK: Call apps and Core Audio process taps (macOS 14.2+)
// ScreenCaptureKit hears apps, not daemons: FaceTime's sound comes from avconferenced, and Chrome plays a Meet
// call from a helper process. A process tap on every process of the call app gets exactly the call.
struct CallApp { let id: String; let name: String; let bundles: [String]; let procNames: [String]; let window: String; let title: String? }
let callApps = [
  CallApp(id: "zoom", name: "Zoom", bundles: ["us.zoom.xos"], procNames: [], window: "zoom.us", title: nil),
  CallApp(id: "facetime", name: "FaceTime", bundles: ["com.apple.FaceTime"], procNames: ["avconferenced"], window: "FaceTime", title: nil),
  CallApp(id: "slack", name: "Slack", bundles: ["com.tinyspeck.slackmacgap"], procNames: [], window: "Slack", title: nil),
  CallApp(id: "teams", name: "Teams", bundles: ["com.microsoft.teams2", "com.microsoft.teams"], procNames: [], window: "Microsoft Teams", title: nil),
  CallApp(id: "meet", name: "Google Meet (Chrome)", bundles: ["com.google.Chrome"], procNames: [], window: "Google Chrome", title: "Meet"),
  CallApp(id: "arc", name: "Arc", bundles: ["company.thebrowser.Browser"], procNames: [], window: "Arc", title: nil),
  CallApp(id: "safari", name: "Safari", bundles: ["com.apple.Safari", "com.apple.WebKit"], procNames: [], window: "Safari", title: nil),
]

func caAddress(_ sel: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
}
func caGet<T>(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector, _ initial: T) -> T {
  var addr = caAddress(sel), size = UInt32(MemoryLayout<T>.size), v = initial
  return AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &v) == noErr ? v : initial
}
func caString(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector) -> String {
  var addr = caAddress(sel), size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  var v: Unmanaged<CFString>? = nil
  let st = withUnsafeMutablePointer(to: &v) { AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, $0) }
  guard st == noErr, let s = v?.takeRetainedValue() else { return "" }
  return s as String
}

struct AudioProc { let obj: AudioObjectID; let pid: pid_t; let bundle: String; let name: String; let input: Bool; let output: Bool }
func audioProcs() -> [AudioProc] {
  var addr = caAddress(kAudioHardwarePropertyProcessObjectList), size: UInt32 = 0
  let sys = AudioObjectID(kAudioObjectSystemObject)
  guard AudioObjectGetPropertyDataSize(sys, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
  var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(sys, &addr, 0, nil, &size, &ids) == noErr else { return [] }
  return ids.map { o in
    let pid: pid_t = caGet(o, kAudioProcessPropertyPID, -1)
    var buf = [CChar](repeating: 0, count: 256)
    _ = proc_name(pid, &buf, UInt32(buf.count))
    return AudioProc(obj: o, pid: pid, bundle: caString(o, kAudioProcessPropertyBundleID), name: String(cString: buf),
                     input: caGet(o, kAudioProcessPropertyIsRunningInput, UInt32(0)) != 0,
                     output: caGet(o, kAudioProcessPropertyIsRunningOutput, UInt32(0)) != 0)
  }
}

// Call apps with audio processes; the ones using the microphone (in a call) first.
func detectCalls() -> [(app: CallApp, procs: [AudioProc], active: Bool)] {
  let procs = audioProcs()
  return callApps.compactMap { app -> (app: CallApp, procs: [AudioProc], active: Bool)? in
    let mine = procs.filter { p in app.bundles.contains { p.bundle.hasPrefix($0) } || app.procNames.contains(p.name) }
    return mine.isEmpty ? nil : (app, mine, mine.contains { $0.input })
  }.sorted { ($0.active ? 1 : 0) > ($1.active ? 1 : 0) }
}

func defaultOutputUID() -> String? {
  let dev: AudioObjectID = caGet(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultSystemOutputDevice, AudioObjectID(0))
  guard dev != 0 else { return nil }
  let uid = caString(dev, kAudioDevicePropertyDeviceUID)
  return uid.isEmpty ? nil : uid
}

final class ProcessTap {
  var tap = AudioObjectID(kAudioObjectUnknown), agg = AudioObjectID(kAudioObjectUnknown)
  var proc: AudioDeviceIOProcID?
  var format = AudioStreamBasicDescription()
  var formatDesc: CMAudioFormatDescription?
  var heard = false  // a denied permission gives all-zero buffers, not an error
  var level: Float = -160  // loudness of the latest buffer, dBFS (for the meters)

  // objs empty and global: everything the Mac plays. rec nil: measure only (the speakers screen's meter).
  func start(_ objs: [AudioObjectID], rec: Recorder?, global: Bool = false, queue: DispatchQueue? = nil) throws {
    func check(_ st: OSStatus, _ what: String) throws {
      if st != noErr { throw NSError(domain: "uxw", code: Int(st), userInfo: [NSLocalizedDescriptionKey: "\(what) failed (\(st))"]) }
    }
    let desc = global ? CATapDescription(monoGlobalTapButExcludeProcesses: []) : CATapDescription(monoMixdownOfProcesses: objs)
    desc.uuid = UUID()
    desc.isPrivate = true
    desc.muteBehavior = .unmuted
    try check(AudioHardwareCreateProcessTap(desc, &tap), "process tap")
    var addr = caAddress(kAudioTapPropertyFormat), size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    try check(AudioObjectGetPropertyData(tap, &addr, 0, nil, &size, &format), "tap format")
    try check(CMAudioFormatDescriptionCreate(allocator: nil, asbd: &format, layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil,
                                             extensions: nil, formatDescriptionOut: &formatDesc), "format description")
    guard let out = defaultOutputUID() else { throw NSError(domain: "uxw", code: 1, userInfo: [NSLocalizedDescriptionKey: "no output device"]) }
    let settings: [String: Any] = [
      kAudioAggregateDeviceNameKey: "uxw-call", kAudioAggregateDeviceUIDKey: UUID().uuidString,
      kAudioAggregateDeviceMainSubDeviceKey: out, kAudioAggregateDeviceIsPrivateKey: true, kAudioAggregateDeviceIsStackedKey: false,
      kAudioAggregateDeviceTapAutoStartKey: true,
      kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: out]],
      kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: desc.uuid.uuidString, kAudioSubTapDriftCompensationKey: true]],
    ]
    try check(AudioHardwareCreateAggregateDevice(settings as CFDictionary, &agg), "aggregate device")
    try check(AudioDeviceCreateIOProcIDWithBlock(&proc, agg, rec?.queue ?? queue ?? DispatchQueue(label: "uxw.tap")) { [weak self] _, inData, inTime, _, _ in
      self?.take(inData, inTime, rec)
    }, "audio callback")
    try check(AudioDeviceStart(agg, proc), "audio start")
  }

  func take(_ inData: UnsafePointer<AudioBufferList>, _ inTime: UnsafePointer<AudioTimeStamp>, _ rec: Recorder?) {
    guard rec?.stopRequested != true, format.mBytesPerFrame > 0, let fd = formatDesc else { return }
    let abl = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inData))
    guard let first = abl.first, first.mDataByteSize > 0 else { return }
    if format.mFormatFlags & kAudioFormatFlagIsFloat != 0, let p = first.mData?.assumingMemoryBound(to: Float32.self) {
      let n = Int(first.mDataByteSize / 4)
      var sum: Float = 0
      for i in 0..<n { sum += p[i] * p[i]; if !heard && p[i] != 0 { heard = true } }
      level = n > 0 ? 10 * log10(max(sum / Float(n), 1e-16)) : -160
    }
    guard let rec else { return }
    // The tap's host time is the clock ScreenCaptureKit stamps its samples with.
    let pts = CMClockMakeHostTimeFromSystemUnits(inTime.pointee.mHostTime)
    var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: CMTimeScale(format.mSampleRate)), presentationTimeStamp: pts, decodeTimeStamp: .invalid)
    var sb: CMSampleBuffer?
    guard CMSampleBufferCreate(allocator: kCFAllocatorDefault, dataBuffer: nil, dataReady: false, makeDataReadyCallback: nil, refcon: nil,
                               formatDescription: fd, sampleCount: CMItemCount(first.mDataByteSize / format.mBytesPerFrame),
                               sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleSizeEntryCount: 0, sampleSizeArray: nil,
                               sampleBufferOut: &sb) == noErr, let sb,
          CMSampleBufferSetDataBufferFromAudioBufferList(sb, blockBufferAllocator: kCFAllocatorDefault, blockBufferMemoryAllocator: kCFAllocatorDefault,
                                                         flags: 0, bufferList: inData) == noErr else { return }
    rec.appendCall(sb)
  }

  func stop() {
    if let proc { AudioDeviceStop(agg, proc); AudioDeviceDestroyIOProcID(agg, proc) }
    if agg != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(agg) }
    if tap != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tap) }
    proc = nil; agg = kAudioObjectUnknown; tap = kAudioObjectUnknown
  }
}
var processTap: ProcessTap?

// The speakers screen's microphone meter: a capture session on the chosen mic, read through its channel power.
final class MicMeter: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate {
  let session = AVCaptureSession()
  var connection: AVCaptureConnection?
  let queue = DispatchQueue(label: "uxw.micmeter")
  func start(_ name: String?) -> String? {
    let devices = AVCaptureDevice.DiscoverySession(deviceTypes: [.microphone, .external], mediaType: .audio, position: .unspecified).devices
    guard let dev = name.flatMap({ n in devices.first { $0.localizedName.lowercased().contains(n.lowercased()) } }) ?? AVCaptureDevice.default(for: .audio),
          let input = try? AVCaptureDeviceInput(device: dev), session.canAddInput(input) else { return nil }
    session.addInput(input)
    let out = AVCaptureAudioDataOutput()
    out.setSampleBufferDelegate(self, queue: queue)
    guard session.canAddOutput(out) else { return nil }
    session.addOutput(out)
    connection = out.connection(with: .audio)
    session.startRunning()
    return dev.localizedName
  }
  var level: Float { connection?.audioChannels.map(\.averagePowerLevel).max() ?? -160 }
  func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {}
}

func runLevels() {
  let mic = MicMeter()
  let micName = flags.contains("no-mic") ? nil : mic.start(opts["mic"])
  var tap: ProcessTap?
  var source = "none"
  let want = opts["call-app"] ?? "auto"
  if want != "none" {
    let calls = detectCalls()
    let pick = want == "auto" ? calls.first(where: { $0.active }) : want == "system" ? nil : calls.first(where: { $0.app.id == want })
    let t = ProcessTap()
    do {
      if let pick { try t.start(pick.procs.map(\.obj), rec: nil); source = pick.app.name }
      else if want == "auto" || want == "system" { try t.start([], rec: nil, global: true); source = "everything the Mac plays" }
      tap = t
    } catch { emit(["ev": "warn", "message": "call meter: \(error.localizedDescription)"]) }
  }
  emit(["ev": "levels", "mic": micName ?? "", "call": source])
  let timer = DispatchSource.makeTimerSource(queue: .main)
  timer.schedule(deadline: .now(), repeating: .milliseconds(100))
  timer.setEventHandler {
    emit(["ev": "level", "mic": Double(micName == nil ? -160 : mic.level), "call": Double(tap?.level ?? -160)])
  }
  timer.resume()
  levelTimer = timer
  DispatchQueue.global().async {
    while readLine() != nil {}
    tap?.stop(); mic.session.stopRunning(); exit(0)
  }
}
var levelTimer: DispatchSourceTimer?

// --title narrows to the window showing that tab; Chrome titles a window by its front tab, so when no window has
// the title, fail explicitly rather than recording a different window.
func pickWindow(_ content: SCShareableContent) -> SCWindow? {
  return pickWindow(content, useTitle: true)
}
func pickWindow(_ content: SCShareableContent, useTitle: Bool) -> SCWindow? {
  let candidates = content.windows.filter { w in
    guard w.windowLayer == 0, w.frame.width > 200, w.frame.height > 150 else { return false }
    if let id = opts["window-id"] { return String(w.windowID) == id }
    if let pid = opts["pid"] { return String(w.owningApplication?.processID ?? -1) == pid }
    if let app = opts["app"]?.lowercased() {
      let title = useTitle ? opts["title"]?.lowercased() : nil
      return (w.owningApplication?.applicationName.lowercased() ?? "").contains(app) && (title == nil || (w.title ?? "").lowercased().contains(title!))
    }
    return false
  }
  // Prefer the window on screen, then the biggest.
  return candidates.sorted {
    ($0.isOnScreen ? 1 : 0, $0.frame.width * $0.frame.height) > ($1.isOnScreen ? 1 : 0, $1.frame.width * $1.frame.height)
  }.first
}

func even(_ x: Double) -> Int { max(2, Int(x) / 2 * 2) }

// --hotkeys: the browser page only hears a shortcut while its window is in front; walkers press them while
// reading the terminal too. Hot keys reach this process from any app, and the app in front never sees them.
let hotNames = ["n", "m", "p"]
var hotRefs: [EventHotKeyRef?] = []
func runHotkeys() -> Never {
  var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
  InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
    var id = EventHotKeyID()
    GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
                      MemoryLayout<EventHotKeyID>.size, nil, &id)
    emit(["ev": "hotkey", "key": hotNames[Int(id.id) % 3], "chord": id.id < 3 ? "Option+Shift" : "Ctrl+Option",
          "front": NSWorkspace.shared.frontmostApplication?.localizedName ?? ""])
    return noErr
  }, 1, &spec, nil, nil)
  let codes = [kVK_ANSI_N, kVK_ANSI_M, kVK_ANSI_P]
  var failed: [String] = []
  for (j, mods) in [optionKey | shiftKey, controlKey | optionKey].enumerated() {
    for (i, code) in codes.enumerated() {
      var ref: EventHotKeyRef?
      let st = RegisterEventHotKey(UInt32(code), UInt32(mods), EventHotKeyID(signature: OSType(0x55585721), id: UInt32(j * 3 + i)),
                                   GetApplicationEventTarget(), 0, &ref)
      if st == noErr { hotRefs.append(ref) } else { failed.append("\(j == 0 ? "Option+Shift" : "Ctrl+Option")+\(hotNames[i].uppercased())") }
    }
  }
  if !failed.isEmpty { emit(["ev": "warn", "message": "shortcut taken by another app: \(failed.joined(separator: ", "))"]) }
  NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { n in
    let app = n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
    emit(["ev": "front", "pid": app?.processIdentifier ?? 0, "app": app?.localizedName ?? ""])
  }
  DispatchQueue.global().async { while readLine() != nil {}; exit(0) }  // the controller went away
  emit(["ev": "hotkeys", "registered": hotRefs.count])
  NSApplication.shared.setActivationPolicy(.prohibited)
  NSApplication.shared.run()
  exit(0)
}
if flags.contains("hotkeys") { runHotkeys() }

Task {
  if flags.contains("levels") { runLevels(); return }
  if flags.contains("sources") {
    let def = AVCaptureDevice.default(for: .audio)
    let mics = AVCaptureDevice.DiscoverySession(deviceTypes: [.microphone, .external], mediaType: .audio, position: .unspecified).devices
    // Virtual devices (ZoomAudioDevice, BlackHole, Teams Audio) are loopback drivers, not microphones.
    let real = mics.filter { $0.transportType != Int32(bitPattern: kAudioDeviceTransportTypeVirtual) && $0.transportType != Int32(bitPattern: kAudioDeviceTransportTypeAggregate) }
    for d in real.sorted(by: { ($0.uniqueID == def?.uniqueID ? 0 : 1) < ($1.uniqueID == def?.uniqueID ? 0 : 1) }) {
      emit(["ev": "mic", "name": d.localizedName, "default": d.uniqueID == def?.uniqueID])
    }
    for c in detectCalls() {
      emit(["ev": "callapp", "id": c.app.id, "name": c.app.name, "active": c.active, "window": c.app.window, "title": c.app.title ?? ""])
    }
    exit(0)
  }
  if flags.contains("calls") {
    for c in detectCalls() {
      emit(["ev": "callapp", "id": c.app.id, "name": c.app.name, "active": c.active, "window": c.app.window, "title": c.app.title ?? "",
            "processes": c.procs.map { "\($0.name) \($0.pid)\($0.input ? " mic" : "")\($0.output ? " out" : "")" }])
    }
    exit(0)
  }
  if flags.contains("list") {
    do {
      let c = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
      for w in c.windows where w.windowLayer == 0 && w.frame.width > 200 {
        emit(["windowId": w.windowID, "app": w.owningApplication?.applicationName ?? "", "pid": w.owningApplication?.processID ?? 0,
              "title": w.title ?? "", "w": Int(w.frame.width), "h": Int(w.frame.height)])
      }
      exit(0)
    } catch { fail("cannot list windows (Screen Recording permission?): \(error.localizedDescription)") }
  }
  guard let out = opts["out"] else { fail("--out is required") }
  guard opts["pid"] != nil || opts["app"] != nil || opts["window-id"] != nil || opts["display"] != nil else { fail("one of --pid, --app, --window-id, --display is required") }

  // Video mode: the whole display.
  var displayTarget: SCDisplay?
  if let d = opts["display"] {
    guard let c = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true) else {
      fail("Screen Recording is not allowed for ux-walk (or the terminal it runs in): System Settings > Privacy & Security > Screen & System Audio Recording")
    }
    let main = CGMainDisplayID()
    let sorted = c.displays.sorted { ($0.displayID == main ? 0 : 1, $0.frame.minX) < ($1.displayID == main ? 0 : 1, $1.frame.minX) }
    guard let pick = sorted.indices.contains(Int(d) ?? 0) ? sorted[Int(d) ?? 0] : sorted.first else { fail("no display to record") }
    displayTarget = pick
  }

  // The browser window can take a moment to appear.
  var window: SCWindow?
  for _ in 0..<(displayTarget == nil ? 40 : 0) {
    if let c = try? await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false), let w = pickWindow(c) {
      window = w; break
    }
    try? await Task.sleep(nanoseconds: 250_000_000)
  }
  if window == nil && displayTarget == nil {
    if !CGPreflightScreenCaptureAccess() {
      fail("Screen Recording is not allowed for ux-walk (or the terminal it runs in): System Settings > Privacy & Security > Screen & System Audio Recording")
    }
    fail("no \(opts["app"].map { "\($0) " } ?? "")window to record: is the app open with a window on screen?")
  }

  let frame = displayTarget?.frame ?? window!.frame
  var filter = displayTarget.map { SCContentFilter(display: $0, excludingApplications: [], exceptingWindows: []) } ?? SCContentFilter(desktopIndependentWindow: window!)
  // The window with the camera bubble over it: a display filter that draws only the two windows, cropped to the
  // window (sourceRect, in the display's points).
  var bubbleDisplay: SCDisplay?
  if let win = window, let bid = opts["bubble-window"].flatMap({ UInt32($0) }),
     let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false),
     let bubble = content.windows.first(where: { $0.windowID == bid }) {
    let center = CGPoint(x: win.frame.midX, y: win.frame.midY)
    if let d = content.displays.first(where: { $0.frame.contains(center) }) ?? content.displays.first {
      filter = SCContentFilter(display: d, including: [win, bubble])
      bubbleDisplay = d
      emit(["ev": "bubble", "status": "recording"])
    }
  } else if opts["bubble-window"] != nil {
    emit(["ev": "warn", "message": "camera bubble not found; recording the window without it"])
  }
  let scale = backingScale(of: frame)
  let maxW = Double(opts["max-width"] ?? (displayTarget == nil ? "1920" : "2560")) ?? 1920
  var w = frame.width * scale, h = frame.height * scale
  if w > maxW { h = h * maxW / w; w = maxW }
  let width = even(w), height = even(h)
  let fps = Int32(opts["fps"] ?? "15") ?? 15
  let withMic = !flags.contains("no-mic")

  let cfg = SCStreamConfiguration()
  cfg.width = width; cfg.height = height
  if let d = bubbleDisplay, let win = window {
    cfg.sourceRect = win.frame.offsetBy(dx: -d.frame.minX, dy: -d.frame.minY)
    cfg.preservesAspectRatio = true
  }
  cfg.minimumFrameInterval = CMTime(value: 1, timescale: fps)
  cfg.showsCursor = true
  cfg.queueDepth = 6
  cfg.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
  if withMic {
    cfg.captureMicrophone = true
    let devices = AVCaptureDevice.DiscoverySession(deviceTypes: [.microphone, .external], mediaType: .audio, position: .unspecified).devices
    let chosen = opts["mic"].flatMap { m in devices.first { $0.localizedName.lowercased().contains(m.lowercased()) } }
      ?? AVCaptureDevice.default(for: .audio)
    if let d = chosen { cfg.microphoneCaptureDeviceID = d.uniqueID }
    emit(["ev": "mic", "name": chosen?.localizedName ?? "default"])
  }

  let rec = Recorder(path: out, width: width, height: height, bitrate: Int(opts["bitrate"] ?? "2500000") ?? 2_500_000, withMic: withMic)
  rec.withCall = flags.contains("call-audio") || opts["call-app"] != nil
  do { try rec.makeWriter(out) } catch { fail("cannot open \(out): \(error)") }
  let stream = SCStream(filter: filter, configuration: cfg, delegate: rec)
  do {
    try stream.addStreamOutput(rec, type: .screen, sampleHandlerQueue: rec.queue)
    if withMic { try stream.addStreamOutput(rec, type: .microphone, sampleHandlerQueue: rec.queue) }
    try await stream.startCapture()
  } catch { fail("cannot start capture: \(error.localizedDescription)") }
  // Follow the window as it moves: the crop is in display coordinates, so it is updated from the window's bounds.
  if let d = bubbleDisplay, let win = window {
    var last = win.frame
    let t = DispatchSource.makeTimerSource(queue: .main)
    t.schedule(deadline: .now() + 0.25, repeating: .milliseconds(250))
    t.setEventHandler {
      guard let info = CGWindowListCopyWindowInfo([.optionIncludingWindow], win.windowID) as? [[String: Any]],
            let b = info.first?[kCGWindowBounds as String] as? NSDictionary,
            let r = CGRect(dictionaryRepresentation: b as CFDictionary), r != last, r.width > 0 else { return }
      last = r
      cfg.sourceRect = r.offsetBy(dx: -d.frame.minX, dy: -d.frame.minY)
      stream.updateConfiguration(cfg) { err in if let err { emit(["ev": "warn", "message": "following the window: \(err.localizedDescription)"]) } }
    }
    t.resume()
    windowFollower = t
  }
  // The call app's own sound when there is one (a process tap), else everything the Mac plays.
  if rec.withCall, let want = opts["call-app"] {
    let calls = detectCalls()
    // "pid:<n>" taps one process (for testing the tap without a call).
    let testPid = want.hasPrefix("pid:") ? pid_t(want.dropFirst(4)) : nil
    let pick = testPid.map { pid in (app: CallApp(id: "pid", name: "process \(pid)", bundles: [], procNames: [], window: "", title: nil),
                                     procs: audioProcs().filter { $0.pid == pid }, active: true) }.flatMap { $0.procs.isEmpty ? nil : $0 }
      ?? (want == "auto" ? calls.first(where: { $0.active }) : calls.first(where: { $0.app.id == want }))
    if let pick {
      let t = ProcessTap()
      do {
        try t.start(pick.procs.map(\.obj), rec: rec)
        processTap = t
        emit(["ev": "call", "status": "recording", "source": "tap", "app": pick.app.name])
        // All zeros for a while: macOS gave the tap silence (System Audio Recording not allowed) or nobody spoke yet.
        rec.queue.asyncAfter(deadline: .now() + 60) {
          if !t.heard && !rec.stopRequested {
            emit(["ev": "warn", "message": "no sound from \(pick.app.name) in the first minute. If people on the call were talking, allow ux-walk (or your terminal) under System Settings > Privacy & Security > Screen & System Audio Recording > System Audio Recording Only."])
          }
        }
      } catch {
        t.stop()
        emit(["ev": "warn", "message": "could not record only \(pick.app.name) (\(error.localizedDescription)); recording everything the Mac plays"])
      }
    }
  }
  if rec.withCall && processTap == nil {
    do {
      let c = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
      guard let display = c.displays.first else { throw NSError(domain: "uxw", code: 1, userInfo: [NSLocalizedDescriptionKey: "no display"]) }
      let cc = SCStreamConfiguration()
      cc.capturesAudio = true
      cc.excludesCurrentProcessAudio = true
      cc.sampleRate = 48000
      cc.channelCount = 1
      cc.width = 2; cc.height = 2
      cc.minimumFrameInterval = CMTime(value: 1, timescale: 1)
      let tap = CallTap(rec)
      let s2 = SCStream(filter: SCContentFilter(display: display, excludingApplications: [], exceptingWindows: []), configuration: cc, delegate: tap)
      try s2.addStreamOutput(tap, type: .screen, sampleHandlerQueue: rec.queue)
      try s2.addStreamOutput(tap, type: .audio, sampleHandlerQueue: rec.queue)
      try await s2.startCapture()
      callStream = s2; callTap = tap
      emit(["ev": "call", "status": "recording", "source": "system"])
    } catch {
      emit(["ev": "warn", "message": "call audio not recorded: \(error.localizedDescription)"])
    }
  }
  emit(["ev": "ready", "windowId": window?.windowID ?? 0, "app": window?.owningApplication?.applicationName ?? "Display",
        "title": window?.title ?? displayTarget.map { "display \($0.displayID)" } ?? "", "width": width, "height": height, "fps": fps])

  // Each checkpoint asks SCK for a new image. Never reuse Recorder.lastVideo (a static-window cache).
  let snapshot: ([String: Any]) async -> Void = { request in
    let requestId = request["requestId"] as? String ?? ""
    var boundsMetadata: [String: Any] = [:]
    do {
      guard let file = request["path"] as? String else { throw NSError(domain: "uxw", code: 1, userInfo: [NSLocalizedDescriptionKey: "snapshot path required"]) }
      let fresh = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
      let target: SCContentFilter
      let bounds: CGRect
      if let win = window {
        guard let found = fresh.windows.first(where: { $0.windowID == win.windowID }) else { throw NSError(domain: "uxw", code: 1, userInfo: [NSLocalizedDescriptionKey: "target window no longer exists"]) }
        target = SCContentFilter(desktopIndependentWindow: found); bounds = found.frame
      } else if let d = displayTarget, let found = fresh.displays.first(where: { $0.displayID == d.displayID }) {
        target = SCContentFilter(display: found, excludingApplications: [], exceptingWindows: []); bounds = found.frame
      } else { throw NSError(domain: "uxw", code: 1, userInfo: [NSLocalizedDescriptionKey: "snapshot target unavailable"]) }
      func rectJSON(_ r: CGRect) -> [String: Double] { ["x": r.minX, "y": r.minY, "width": r.width, "height": r.height] }
      let fullyWithinDisplay = fresh.displays.contains(where: { $0.frame.contains(bounds) })
      boundsMetadata = ["target": rectJSON(bounds), "displays": fresh.displays.map { rectJSON($0.frame) },
        "visible": fresh.displays.compactMap { d -> [String: Double]? in let overlap = d.frame.intersection(bounds); return overlap.isNull ? nil : rectJSON(overlap) },
        "fullyWithinDisplay": fullyWithinDisplay]
      // Some SCK versions still clip independent windows to the display despite ignoreClipping.
      // Refuse a success receipt rather than silently returning an incomplete window image.
      guard fullyWithinDisplay else { throw NSError(domain: "uxw", code: 1, userInfo: [NSLocalizedDescriptionKey: "target window extends beyond one display; resize or reposition that same window fully on one display before checkpointing"]) }
      let captureStartedAt = nowEpochMs()
      let image: CGImage
      // The screenshot API can otherwise clip an off-screen window to display bounds, leaving black
      // padding in a window-sized output. Bounds were checked above; also disable shadows/clipping on26+.
      if #available(macOS 26.0, *) {
        let settings = SCScreenshotConfiguration()
        settings.width = max(1, Int(target.contentRect.width * Double(target.pointPixelScale)))
        settings.height = max(1, Int(target.contentRect.height * Double(target.pointPixelScale)))
        settings.showsCursor = false; settings.ignoreClipping = true; settings.ignoreShadows = true
        let result = try await SCScreenshotManager.captureScreenshot(contentFilter: target, configuration: settings)
        guard let captured = result.sdrImage else { throw NSError(domain: "uxw", code: 1, userInfo: [NSLocalizedDescriptionKey: "screenshot did not produce an SDR image"]) }
        image = captured
      } else {
        let settings = SCStreamConfiguration()
        settings.width = max(1, Int(target.contentRect.width * Double(target.pointPixelScale)))
        settings.height = max(1, Int(target.contentRect.height * Double(target.pointPixelScale)))
        settings.showsCursor = false; settings.ignoreShadowsSingleWindow = true; settings.scalesToFit = true
        image = try await SCScreenshotManager.captureImage(contentFilter: target, configuration: settings)
      }
      let capturedAt = nowEpochMs()
      func savePNG(_ image: CGImage, _ destination: String) throws {
        guard let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else { throw NSError(domain: "uxw", code: 1, userInfo: [NSLocalizedDescriptionKey: "PNG encoding failed"]) }
        try data.write(to: URL(fileURLWithPath: destination), options: .atomic)
      }
      try savePNG(image, file)
      if let crop = request["crop"] as? [String: Any] {
        guard let x = crop["x"] as? Double, let y = crop["y"] as? Double, let w = crop["width"] as? Double, let h = crop["height"] as? Double, let out = crop["path"] as? String,
          x >= 0, y >= 0, w > 0, h > 0, x + w <= Double(image.width), y + h <= Double(image.height),
          let clipped = image.cropping(to: CGRect(x: x, y: y, width: w, height: h)) else { throw NSError(domain: "uxw", code: 1, userInfo: [NSLocalizedDescriptionKey: "crop outside screenshot pixel bounds"]) }
        try savePNG(clipped, out)
      }
      emit(["ev": "snapshot", "requestId": requestId, "path": file, "captureStartedAt": captureStartedAt, "capturedAt": capturedAt, "width": image.width, "height": image.height, "bounds": boundsMetadata])
    } catch { emit(["ev": "error", "requestId": requestId, "message": "snapshot failed: \(error.localizedDescription)", "bounds": boundsMetadata]) }
  }

  let stop: () -> Void = {
    rec.queue.async {
      rec.stopRequested = true
      rec.finishCurrent {
        processTap?.stop()
        Task { try? await callStream?.stopCapture(); try? await stream.stopCapture(); exit(0) }
      }
    }
  }
  signal(SIGINT, SIG_IGN); signal(SIGTERM, SIG_IGN)
  for sig in [SIGINT, SIGTERM] {
    let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    src.setEventHandler { stop() }
    src.resume()
    signalSources.append(src)
  }
  DispatchQueue.global().async {
    while let line = readLine() {
      let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
      switch parts.first {
      case "snapshot" where parts.count == 2:
        if let data = parts[1].data(using: .utf8), let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
          Task { await snapshot(request) }
        } else { emit(["ev": "error", "message": "invalid snapshot JSON"]) }
      case "rotate" where parts.count == 2:
        rec.queue.async { rec.rotate(to: parts[1]) }
      case "pause":
        rec.queue.async { rec.finishCurrent {} }  // "rotate <file>" resumes into a new file
      case "stop":
        stop(); return
      default:
        emit(["ev": "error", "message": "unknown command: \(line)"])
      }
    }
    stop() // stdin closed: the controller went away
  }
}

var signalSources: [DispatchSourceSignal] = []
var windowFollower: DispatchSourceTimer?

// Pixels per point of the display the window sits on (SCWindow frames are in points).
func backingScale(of frame: CGRect) -> Double {
  var id = CGMainDisplayID(), count: UInt32 = 0
  _ = CGGetDisplaysWithPoint(CGPoint(x: frame.midX, y: frame.midY), 1, &id, &count)
  guard let mode = CGDisplayCopyDisplayMode(count > 0 ? id : CGMainDisplayID()) else { return 2 }
  return Double(mode.pixelWidth) / Double(max(1, mode.width))
}

dispatchMain()
