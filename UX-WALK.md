# Cap UX

Cap UX is an independent AGPLv3 fork of [Cap](https://github.com/CapSoftware/Cap). It extends the shipping GPUI desktop app with a native UX Walk mode. Upstream copyrights and the MIT and third-party exceptions in [LICENSE](LICENSE) remain in place.

## Record a walk

1. Select **UX Walk** in the menu bar, main recorder or mode picker. A fresh Chrome window opens at your configured start page and is selected for recording. The menu bar switches to the footprint. Onboarding introduces the same mode alongside Instant, Studio and Screenshot.
2. Enter a topic and, when enabled, confirm speaker names in the recorder. The new browser window stays selected while you configure the walk, and **Start Recording** stays visible at the bottom. **New walk window** opens another fresh window. You can switch to any display, window, area or camera with the existing capture-source controls.
3. Choose a display, window, area or camera, then use the existing camera, microphone and system-audio controls. Start recording normally.
4. Open **Walk notes & chapters** from the recording bar. Add an observation or give the next chapter a title. Notes save immediately. Cap's existing Stop, Pause, Resume, Restart and Delete controls own the capture lifecycle.
5. Stop to save the Cap project and prepare the walk. The native review window shows progress, notes, the report and files. **Edit a copy** opens an independent editing project in the existing editor.

For a meeting plus a live demo, select the demo **Window**, enable **Record System Audio**, and select your **Microphone**. On macOS, computer audio uses its own ScreenCaptureKit stream, independent of the video window: a call in another app is included without recording that app's video. System Audio includes other apps and notifications; it is not a participant-only call feed. Microphone remains a separate source on the same recording timeline. Headphones help keep remote speech out of the microphone. ElevenLabs uses the audio that reaches the recording; diarization does not guarantee participant names.

To check this routing on a Mac, open a silent synthetic page in its own window, then run `python3 scripts/test-independent-audio.py --cap /path/to/cap-cli --window <native-window-id> --output /tmp/unique-audio-check`. This records only that window with the microphone disabled and plays a known tone and synthetic meeting speech through a different process. The test checks the saved audio for that tone. Repeat with `--mode studio` and with `--audio off` for the off control. It requires Screen Recording access and an audible output device; it never uploads the result.

UX Walk uses Cap's Studio recording pipeline and native controls. The notes window is created before capture and explicitly excluded. A unique local bootstrap title identifies the new owned Chrome window before navigation; unrelated personal Chrome windows are never selected or instrumented. Its browser collector starts before the start-page navigation, recording semantic clicks, bounded visible context, console warnings/errors, page exceptions and request-completion metadata. Failed JSON responses retain redacted error codes, messages, details and hints. Request bodies, auth headers, cookies, form values and raw automation-trace archives are excluded from reports.

The owned browser context uses the configured local `authFile` to retain sign-ins; it is separate from your personal Chrome profile. You may need to sign in there once. Browser creation does not start video recording. First-load context before Start is saved separately in `browser-preroll.jsonl`, outside the video timeline. Captured events and native notes use Cap's elapsed clock, excluding pauses; browser annotation screenshots stop while paused. First-frame alignment remains approximate. Events from separate popup windows are excluded; tabs in the selected window remain observable.

On macOS, window video uses ScreenCaptureKit's desktop-independent window filter, including after a capture-stream restart. It captures the selected window instead of cropping the display, so overlapping applications stay out of the video. A missing or excluded selected window fails without falling back to display capture. Display and area recording retain their existing behavior.

After confirmed recording finalization, the app snapshots the project into the walk folder before restoring normal completion UI. The processor exports and splits that copy into chapter clips and reuses UX Walk's screenshots, timelines, transcription and optional briefs. The original recording stays in Cap UX's library. A failed export retains source media and notes; reprocessing reuses the saved snapshot. Restart and Delete discard the current Cap capture through its existing controls and retain an aborted notes journal without processing it as a completed walk.

Saved journals are remembered across app launches. Settings → Recordings includes a **UX Walk** filter, **View notes** and **Copy agent prompt** for each associated recording. Saved notes can open the report/files, reprocess an interrupted preparation, or explicitly open a Claude session in cmux. The existing Shortcuts page offers **Open UX Walk** and **Open walk notes**. Walk folders retain the report, journal, browser evidence and media; handoff prompts describe the evidence actually available and treat recorded content as observations rather than instructions.

## Settings and providers

General contains your name, start page, speaker defaults, handoff preference, chapter briefs and product source folder. Recordings contains the walk output folder. Transcription contains ElevenLabs Scribe, AssemblyAI, Descript and None, plus language, glossary and screen-name preferences. Ordinary editor captions retain their existing local models.

Native settings share `~/.config/ux-walk/config.json` with the engine and CLI. Invalid or unsupported changes are refused; unrelated preferences are preserved. Provider secrets stay in login Keychain items, including configured custom item names. Secure key entry sends secrets to the security utility over stdin, never command arguments, JSON or logs.

Other capture sources retain Cap's normal flexibility. If the chosen window/display/area does not match an owned walk browser, its report explicitly marks browser evidence unavailable. Old walks remain video/manual-note recordings; missing telemetry cannot be recovered retroactively. Interrupted collectors report partial coverage. Browser-visible query failures do not provide server-side SQL traces. The separate CLI's trace preference remains preserved in shared settings.

Automatic walk windows require Google Chrome. The walkthrough processor requires FFmpeg. Optional briefs require the configured Claude CLI. Opening an agent workspace requires Claude and cmux; it is never automatic. Cloud transcription requires a provider key and sends audio to the selected provider. UX Walk does not automatically publish recordings.

## Build and preview

Use the existing Cap GPUI setup and packaging pipeline. Install pinned engine dependencies with `npm ci --ignore-scripts --prefix vendor/ux-walk`, then run `node scripts/bundle-ux-walk.mjs /path/to/Cap\ UX.app` after packaging. The bundle contains Node, the pinned engine and a fork-owned native lifecycle adapter in `Contents/Resources/ux-walk`. No separate UX Walk application is required.

The public engine snapshot contains selected source files, license, contract tests and per-file hashes in `SOURCE.json`. Refresh it with `scripts/sync-ux-walk.mjs` from a reviewed canonical revision; do not edit the snapshot directly. The lifecycle adapter is maintained under `apps/desktop-gpui/ux-walk`.

The **ux-walk native checks** workflow checks the desktop and CLI, runs scoped tests and packages an isolated macOS 15+ preview. Preview artifacts include the app, source revision, engine provenance, licenses and checksum. The app uses the Cap UX name and UX ring icon. Previews have a separate bundle identifier and per-revision temporary data, logs, recordings and UX Walk config. They claim no recording file association or URL scheme and do not copy your official Cap profile.

A signed public installer and fork-owned binary update feed are not available yet. The default `ux-walk` Cargo feature blocks official Cap installers from overwriting the fork. Do not distribute a build with `--no-default-features`, which restores the official updater.

CI previews use ad-hoc signatures. Their signing identity changes with the binary, so a permission entry from an older preview may remain enabled while the new app sees access denied. Use the same existing local signing identity for successive local builds with `CAP_UX_SIGNING_IDENTITY="your signing identity" node scripts/bundle-ux-walk.mjs "/path/to/Cap UX.app"`. This signs the preview; it does not grant permissions. In macOS Privacy & Security, refresh only the Cap UX entries with the exact installed app, then relaunch it. [Apple's screen recording guide](https://support.apple.com/guide/mac-help/control-access-screen-system-audio-recording-mchld6aa7d23/mac) and [accessibility guide](https://support.apple.com/en-mo/guide/mac-help/mh43185/mac) describe those controls.

## Upstream and distribution

Upstream changes arrive as reviewed update pull requests and are built before release. Keep customizations in fork-owned modules and extend Cap's recording and editor paths. Cap UX uses its own application identity, library and account state.

Commercial use and paid distribution are possible under the applicable open source licenses, with corresponding source and required notices available to recipients. Upstream cloud subscriptions, infrastructure and service terms remain separate. This fork does not deploy a cloud service or implement production session analytics.
