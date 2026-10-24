# Cap media in the same walk

`ux-walk cap doctor` reports readiness; `ux-walk cap targets` lists exact screen/device IDs.
The menu bar app has one **Start a walk…** entry. **Agent instructions** is the default and needs no Cap. Choose **Shareable video with Cap** or **Log an existing Cap recording** only when wanted. These use the same `ux-walk start` command and JSON IPC as agents. Cap Studio is a recording mode, not a required model/assistant.

```
ux-walk start instructions https://example.test
ux-walk start demo --capture cap --no-browser --screen-id <id> --mic "<exact device name>" --camera <device-id> --ipc
ux-walk cap sessions
ux-walk start review --attach-cap <recording-id> --no-browser --screen-id <same-screen-id> --ipc --evidence-only
ux-walk import /path/to/recording.cap demo
ux-walk cap edit /path/to/walk/media/source.cap --no-open
ux-walk cap reconcile /path/to/walk
```

Cap window video is deliberately refused: the tested 0.6.1 video included overlapping app pixels while its still screenshot looked correct. Use native `--capture window --no-browser --window-id ID` for persona tests. Whole-screen Cap captures everything visible, including notifications. Do not use it to evade an existing browser/capture policy.

Cap Studio retains one continuous native project at `media/source.cap`, its full derivative at `media/video.mp4`, and source inventory/hashes/timing in `media/media.json`. Chapters are logical ranges; chapter derivatives are produced after recording ends, with source ranges in each chapter's `media.json`. **Pause pauses logging only: Cap continues capturing screen and enabled devices.** Chapter changes never stop/restart Cap. Native ux-walk retains its existing recording-pause semantics. Neither mode publishes automatically.

Owned Cap: JSON `{"cmd":"stop"}` ends recording and logging. JSON `{"cmd":"detach"}` ends logging and releases the recording, leaving Cap running. Attached Cap: stop/detach ends logging only and never changes devices or stops the external recording. `done.pendingMedia:true` means the log is ready but video awaits finalization; stop Cap through its own owner, then run `cap reconcile`. That command copies a completed external project before export and makes no model/cloud calls; run normal `ux-walk process <walk>` explicitly for later transcription. A missing/short video fails reconciliation rather than claiming complete coverage.

Attachment is supported only for **live detached CLI recordings**. GUI recording-start events do not expose the required identity/path/clock. The independently chosen screenshot screen is not automatically verified against the attached video; retain that coverage warning. Start acknowledgement is not a first-frame clock; the attached session clock has one-second resolution. Native offsets and timing uncertainty are preserved. Edited time is not original evidence time.

Mic/camera are off unless selected for a new recording. `--system-audio` is all system sound, not one call app. Cap also records global cursor/keyboard events locally. Enabled Cap automations are refused; the agent must not silently disable them. Normal configured transcription still sends audio to its provider. Evidence-only mode disables devices for a new recording and skips external processing. **Attaching never changes existing Cap devices**, so evidence-only attachment can still reference media containing the owner's camera/audio.

The Cap mode starts no browser and supplies no console/network telemetry. The existing extension can add selected-tab text/clicks; verify its mapping separately. Checkpoints are fresh Cap PNGs; inspect video frames separately, since the two paths can differ. Finish and verify `done.ok`, native project presence, playable export and evidence coverage.

**Edit recording in Cap** creates a draft copy beside the source under `edits/`. `cap edit --no-open` returns its JSON path for an agent without opening a GUI. Keep the evidence master and existing export unchanged. Import the edited `.cap` as a new session to render the new cut. For project configuration, render and explicitly authorized sharing, use the installed Cap CLI's own `guide --json`, project, export and upload commands; ux-walk does not implement a parallel editor/publisher. Do not treat a returned link, project or stored account credential as permission to publish.

`ux-walk cap compatibility --json` checks the installed command contract without recording. `ux-walk cap update --json` explicitly uses Cap's official updater and refuses live recorders or an open Cap app. Native Cap updates feed the adapter on its next invocation; weekly CI monitors the newest signed/notarized release. See `docs/cap-updates.md` for the route and its limits.

For complex editing, the source/runtime comparison is in `docs/editor-comparison.md` in the ux-walk repository. Neither optional editor has passed the full independent screen/camera/audio oracle yet; do not claim otherwise.
