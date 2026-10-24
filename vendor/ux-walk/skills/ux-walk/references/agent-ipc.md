# Agent recording and IPC

Use this path when an environment-provided browser controller already drives the UI. ux-walk observes one native window and accepts evidence annotations; it does not control that browser.

## Start

Create/select the intended test window using the allowed browser tools. Run `ux-walk windows`, match the unique title and dimensions, and use its exact native window ID. Keep the window within one display. A closed/missing explicit target must fail rather than fall back to another window.

```sh
ux-walk record provider-review https://example.test/schedule \
  --ipc --no-browser --window-id 12345 --evidence-only \
  --out /absolute/artifacts --speakers Chief
```

`--evidence-only` disables mic/call audio, transcription, model briefs, tracing, clipboard handoff and automatic agent startup. It preserves window recording, checkpoints and deterministic reports. Existing product writes still need the user's task authorization.

Keep stdin open for the live process. Send one JSON object per line and consume stdout JSON. If a terminal execution tool requires a persistent PTY, disable its input echo before launching so echoed input cannot interleave with responses. Do not send commands through an unrelated user's terminal.

After the recorder is ready, the optional ux-walk extension can collect visible text and clicks from an explicitly selected HTTP/HTTPS tab. Choose Collect this tab in its popup; Save visible text adds a bounded text/context checkpoint to the same notes/actions/report. Its tab and the recorder’s native window must be checked separately. This does not provide console/network/iframe coverage or alter the browser controller’s URL policy.

Wait for `ev: ready`; retain its session directory and coverage. Structured commands require a unique `requestId`; match the response by that ID:

```json
{"ev":"result","requestId":"shot-1","cmd":"checkpoint","ok":true,"result":{"path":"/actual/saved.png"}}
```

`ok: false` carries an error. Inspect the result; a timeout or missing PNG is not successful evidence. Send dependent commands after the required result. Legacy controls such as `{"cmd":"next","name":"Weekend replacement"}` and `{"cmd":"stop"}` remain available.

## Optional Cap through the same interface

Use `ux-walk start ... --capture cap --no-browser --screen-id ID --ipc` for Cap media, or `--attach-cap RECORDING_ID` for a live detached CLI recording. Internal `ux-walk start` remains native and needs no Cap. Read [Cap ownership and timing](cap.md) before attaching.

The same next/mark/step/observe/checkpoint/status/report commands work. Cap `pause` pauses logging only, leaving media recording. `detach` ends logging and leaves Cap alive. `stop` stops media only when this logger owns the recording; attached stop never does. State includes `mediaBackend`, `continuousMedia`, `ownsRecording` and `capRecording`. A pending-media done event establishes a completed log, not a finished video. Reconcile after Cap ends. Source clock/target uncertainty stays explicit. No additional model loop is launched.

## Baseline and lifecycle

A baseline checkpoint does not need a step. Optional crop coordinates are in full native screenshot pixels, including browser chrome, not CSS viewport coordinates.

```json
{"cmd":"checkpoint","requestId":"baseline-1","text":"Before request: no result loaded.","textObservedAt":1790000000000,"context":{"url":"https://example.test/schedule","title":"Schedule","viewport":{"width":1440,"height":900},"zoom":"100%","build":"known build"},"crop":{"x":20,"y":150,"width":900,"height":440}}
```

Replace example times with actual epoch milliseconds from the UI observation. Do not invent viewport, zoom, build, or displayed text. Context/text in passive mode is labeled supplied. Successful checkpoints return full PNG, crop when requested, text when supplied, metadata path, evidence ID, capture timestamps and coverage. Keep the returned evidence ID for findings.

Record lifecycle phases around the UI action:

```json
{"cmd":"step","requestId":"begin-1","stepId":"replace","phase":"begin","name":"Open replacement candidates","persona":"Chief","observedAt":1790000000100}
{"cmd":"step","requestId":"feedback-1","stepId":"replace","phase":"first-feedback","observedAt":1790000000400,"text":"Seat panel opened; candidates loading."}
{"cmd":"step","requestId":"ready-1","stepId":"replace","phase":"ready","observedAt":1790000002500,"text":"Five named candidates and their counts are visible."}
```

The controller can collect the actual before-click, after-feedback and after-ready timestamps, then submit these phases in order. `observedAt` is optional: without it timing uses recorder receipt time. Supplied timestamps retain `receivedAt` separately and must be monotonic and not in the future. For a path that cannot finish, use `blocked`, `failed`, or `not-tested` instead of ready.

Capture the ready result with another checkpoint and its actual `textObservedAt`. If the UI can change between the text observation and native capture, inspect both and describe the difference honestly.

## Observations, telemetry and findings

```json
{"cmd":"observe","requestId":"obs-1","stepId":"replace","level":"warn","text":"Browser console showed the exact warning…","evidence":["agent-returned-evidence-id"]}
{"cmd":"finding","requestId":"finding-1","stepId":"replace","persona":"Chief","title":"Replacement counts agree","expected":"Seat and Fairness show the same count","observed":"Both show 12 for the same provider/window","verdict":"pass","severity":"info","evidence":["agent-returned-evidence-id"]}
```

Other verdicts are `fail` and `not-tested`. Use the returned item ID with existing `ux-walk link/status/search`. Do not count an observed error as a product defect until the expected behavior and relevant state support that conclusion.

Optional `network` commands accept URL, method, numeric `startedAt`/`completedAt`, status/failure and stepId from an actually observed browser request. These rows are labeled supplied. Automatic collection occurs only in recorder-owned browser mode. Metadata strips arbitrary query values and bodies; numeric pagination and explicit long-poll wait are retained. Do not create invented requests to make missing coverage look complete.

## Finish

```json
{"cmd":"report","requestId":"report-1"}
{"cmd":"stop"}
```

Stop produces a `done` event and deterministic report in evidence-only mode, without end-of-walk questions or external model calls. Inspect `done.ok`, capture status and the process exit status. Uncorrelated native errors or nonzero helper exits persist a capture error, mark coverage interrupted, set `done.ok:false` and exit nonzero. Saved checkpoints may remain usable; the recording is incomplete. A request-correlated checkpoint failure is recoverable: correct the cause and retry with a new requestId.

The report can also be rebuilt with `ux-walk report /absolute/session`. Open it through permitted tools, inspect actual screenshots and missing-evidence labels, then link that file in the final handoff. State any preview restriction without bypassing it. Existing human recordings can keep their normal transcription/brief workflow.
