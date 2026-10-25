---
name: cap-ux
description: Record or review Cap UX walkthroughs and prepare evidence-linked agent handoffs using local recordings, notes and transcripts. Use for Cap UX capture, local editing/export or its configurable sharing server; excludes the upstream Cap cloud account and billing APIs.
---

# Cap UX

Cap UX is an independent local-first recorder and UX walkthrough tool. It needs no Cap account, commercial license or subscription. Discover the installed CLI contract with `cap guide --json` and `cap <command> --help`; use the schemas returned by that version.

## Capture and review

Use the native app's UX Walk mode when the task needs its fresh browser window, semantic clicks, console errors and failed-request evidence. The ordinary `cap record` command records local video; do not describe it as collecting browser evidence unless the walk manifest confirms that capture.

For plain recording, the CLI exposes targets, doctor, record, project, recordings and export commands. Keep capture scoped to the requested window and audio sources. Use the existing app settings and transcription provider configuration. The CLI shim points to the installed app's bundled binary.

For an existing walk, start with its local journal, report and linked transcript/evidence files. Settings → Recordings → View walk notes and Copy agent prompt are the native handoff entry points. Keep the original recording intact and edit/export a copy when needed.

Produce a coherent handoff: observed problem, expected behavior, reproduction steps, recording timestamp, relevant route/frame/request or console evidence, and a concrete next action. Distinguish observations from inferred causes. Attribute quotes only when speaker identity is supported; retain uncertainty and corrections. An imported transcript may use another clock, so verify its offset before linking timestamps. Current recordings may mix microphone and system audio; do not assume separate participant tracks exist.

Beads or Linear filing follows the user's selected project and authorization. Link issue candidates to the evidence and existing app path they extend, deduplicate against existing work, and return created issue ids and unresolved questions with the summary. Reviewing a walk alone does not authorize publishing it or changing the application under review.

## Optional sharing

Cloud sharing is off until the user chooses a compatible server in Settings → Sharing. The CLI uses the same sharing preferences and system credential store:

```sh
cap sharing status
cap sharing configure --server https://your-sharing-server.example --enable
cap upload recording.mp4 --json
cap sharing revoke SHARE_ID
```

Use the configured destination and the actual returned link. Sharing publishes the selected video or composited screenshot; it does not upload raw walk traces, cookies, notes or provider credentials. Review sensitive screen content before sharing. Each new share has its own expiring link; revoke an older link by its id when needed.

Upload credentials are configured through the secure app field or `cap sharing configure --token-stdin` from a protected local source. CAP_UX_UPLOAD_TOKEN is an optional headless override. Never include credentials in prompts, recordings, logs, URLs or issues. The upstream `cap auth`, account, billing and cloud MCP commands are not part of Cap UX.
