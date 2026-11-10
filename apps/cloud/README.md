# Worm sharing server

A standalone Cloudflare Worker, private R2 bucket and static viewer. No Cap account, billing API, subscription or upstream web application is required. This first release is an owner-managed sharing service; public user signup is not implemented yet.

## Deploy your own

Use Node 22 or newer and your own Cloudflare account. The Jacks Unlimited instance is `capux.jaxtrell.workers.dev`; its resources are isolated from onCall.

```sh
cd apps/cloud
npm ci --ignore-scripts
npm run check
export CLOUDFLARE_ACCOUNT_ID=YOUR_ACCOUNT_ID
npx wrangler whoami
npx wrangler r2 bucket create capux-media --update-config=false
npx wrangler r2 bucket lifecycle add capux-media capux-retention '' --expire-days 31 --abort-multipart-days 1 --force
npm run deploy
npx wrangler secret put UPLOAD_TOKEN
```

At the secret prompt, supply a randomly generated credential of at least 32 characters. Save the same credential in Worm Settings → Sharing. Keep it in your password manager or system credential store; do not paste it into source, a recording, a URL or an issue. Requests to create shares return 503 until the secret is configured. Rotate it with the same secret command; existing links remain revocable with the new owner credential.

Change the Worker and bucket names in `wrangler.jsonc` for another instance. Set the deployment's returned HTTPS origin in the app. A custom domain can route to this same Worker later; API and viewer must share an origin so scoped playback cookies work. Never make the R2 bucket public. The 31-day retention rule applies only to this sharing bucket; it leaves source recordings on the user's computer untouched.

For local simulation, use the same config without remote bindings and a local `.dev.vars` containing only a synthetic UPLOAD_TOKEN. Tests run real workerd with ephemeral local R2 and assets; they do not call Cloudflare or upload personal recordings.

## Desktop and CLI

Sharing is off by default. Settings → Sharing controls the server, upload credential and expiry (1, 7 or 30 days). A recording's Share video action publishes only its finished video and copies the link. Studio recordings without an export need to be exported in the editor first. Screenshot Share publishes the composited PNG or JPEG. Revoke link stops access through that server; it does not delete the local recording.

```sh
cap sharing configure --server https://YOUR_WORKER.workers.dev --enable
cap sharing configure --token-stdin < /path/to/protected-credential
cap upload recording.mp4 --json
cap sharing status
cap sharing revoke SHARE_ID
```

Desktop and CLI read `~/.config/cap-ux/sharing.json`. Credentials are keyed by server origin in the system credential store. CAP_UX_UPLOAD_TOKEN supplies a headless credential; CAP_UX_SHARING_CONFIG selects an isolated configuration for testing. HTTPS is required except for localhost development. Redirects are refused so upload credentials cannot move to another endpoint. There is no Cap service fallback.

## Protocol v1

All JSON is bounded. Writes require `Authorization: Bearer <owner-upload-credential>`, except feedback reports from configured sites. All routes return private/no-store responses. Only the feedback submission route grants CORS, and only to configured origins.

| Method and path | Result |
| --- | --- |
| GET /healthz | Product and protocol version |
| POST /api/v1/shares | Accept title, contentType, size and expiresInDays; return id, partSize, sharePath and expiresAt |
| PUT /api/v1/shares/ID/parts/N | Upload exactly the declared part size (final part can be smaller); return partNumber and etag |
| POST /api/v1/shares/ID/complete | Accept ordered parts; validate final size before publishing |
| DELETE /api/v1/shares/ID | Revoke access and remove the published media or abort an incomplete upload |
| GET /api/v1/shares/ID/metadata | Read title, size, content type and expiry with a read capability |
| GET or HEAD /api/v1/shares/ID/media | Authorized media; single byte ranges supported |
| POST /api/v1/shares/ID/access | Exchange the read capability for a scoped HttpOnly playback cookie bounded by link expiry |
| GET /s/ID#READ_CAPABILITY | Viewer; the fragment is exchanged for playback access and never sent in the HTTP URL |
| POST /api/v1/feedback | Multipart report (`key`, `note`, `evidence`, optional `screenshot` and `voice`) from a configured origin; returns its id |
| GET /api/v1/feedback | Owner: list reports, newest first (`cursor` pages) |
| GET /api/v1/feedback/ID | Owner: the report with its evidence |
| GET /api/v1/feedback/ID/screenshot, /voice or /rewind | Owner: the attachment, with its SHA-256 in `X-Content-SHA256` (the rewind is `application/gzip`) |
| GET /rewind/ID | Replay page for a report's rewind. The page holds no report data; it asks for the owner credential and reads the rewind with it |
| DELETE /api/v1/feedback/ID | Owner: delete the report and its attachments |

The create response's link is not readable until completion. The viewer capability is distinct from the upload credential and stored as a hash. Possessing a viewing link never authorizes uploads or revocation. Revocation has an independent tombstone so a concurrent completion cannot restore access. Expiry is enforced on every read; the bucket lifecycle later removes stored objects. Clients verify the final media's size before reporting success, revoke incomplete/failed attempts, and keep local files.

Supported media: video/mp4, image/png and image/jpeg. Maximum media size: 20 GB. Multipart size: 8 MiB. Link expiry: 1–30 days. Raw traces, cookies, local configuration, API keys, notes and reports are not accepted as upload media. The current service has one administrative upload credential, not tenant accounts or a public upload form.

## Feedback from your web apps

The same Worker receives reports from the Worm feedback button (`packages/feedback-widget`) embedded in your own web apps. Each site owner runs their own server, so reports stay in that owner's Cloudflare account; there is no shared Worm service. Reports can contain health or other personal information: treat the bucket and the owner credential accordingly.

Configure the sites allowed to send reports as a Worker secret holding JSON. Each publishable key (`wf_pub_` plus 12–64 letters, digits, `_` or `-`) is bound to the exact origins that may use it, with a retention of 1–30 days (default 30):

```sh
npx wrangler secret put FEEDBACK_SITES
{"wf_pub_your_site_key":{"name":"Your app","origins":["https://app.example.org"],"retentionDays":30}}
```

Without this secret every report is refused. The key is not a secret; it is visible in the page. Origin checks stop other websites' browsers, not scripts that forge an Origin header, so the Worker also rate limits reports per origin and IP address (about 10 a minute) and per origin (about 120 a minute) through the `FEEDBACK_LIMIT` and `FEEDBACK_SITE_LIMIT` bindings in `wrangler.jsonc`. Cloudflare counts these per location, so they are approximate. The per-origin limit slows what a flood can write to your bucket (about 120 reports a minute for each configured origin in each Cloudflare location); the trade-off is that someone forging your origin, with or without your site key, can use it up and block real reports for that minute. Reports are limited to 16 MB: a note of 4,000 characters, 256 KB of evidence, a 4 MB screenshot (JPEG, PNG or WebP), a 6 MB voice memo (WebM, MP4/AAC, Ogg, AAC or MP3), each checked against its file signature, and a 4 MB rewind. The limit was 12 MB before the rewind; it rose only by the rewind's 4 MB. A rewind must be gzip (`application/gzip`, checked by its signature) and is decompressed as a stream without being kept: it must inflate to at most 24 MB, start with the widget's envelope (`schemaVersion` 1, `kind` `rrweb`, the rrweb version, start and end times no more than 15 minutes apart, and a first Meta event) and end the JSON array. Anything else is refused with 413 or 415.

Reports are stored in the private bucket under `feedback/` (report, screenshot, voice memo and rewind), with a list entry under `feedback-index/` holding the site, route and the first 160 characters of the note, and a tombstone under `feedback-tombstones/` after deletion. The API denies access after the retention ends. The whole-bucket 31-day lifecycle rule from [Deploy your own](#deploy-your-own) then removes all three; a rule limited to one prefix would leave the others. There is no public read. Listing, reading and deleting require the owner credential:

```sh
cap feedback list
cap feedback pull REPORT_ID --out ~/Movies/ux-walk
cap feedback delete REPORT_ID
```

`pull` verifies each attachment's checksum and writes a new walk-shaped folder: `session.json`, and a `01-feedback` chapter with `chapter.json`, `feedback.md` (the note and evidence for a person or agent), `feedback.json`, `actions.jsonl`, the screenshot, the voice memo and the rewind as `rewind.json.gz` (gzip JSON: the widget's envelope with the rrweb events; `chapter.json` names it under `rewind`). With a voice memo, `ux-walk process <chapter>` transcribes it with your configured provider; nothing is transcribed unless you run it. The chapter's clock starts when the memo started, so the processed timeline shows the speech; clicks, errors and requests from before the memo stay in `feedback.md` and `actions.jsonl`.

### Rewind

Sites that turn on the widget's rewind send a masked replay of the last two to five minutes of the page with a report, only when the tester presses Send and leaves the rewind checked. The widget README lists [what it captures and what is masked](../../packages/feedback-widget/README.md#rewind). It can still show anything visible on the page that was not marked `data-worm-mask`, including patient data, so treat it like the report: it is stored only in this private bucket, has the same retention and is removed by the same delete.

To watch one, open `https://YOUR_SERVER/rewind/REPORT_ID` and enter the owner credential. The page and its player ([rrweb-player](https://github.com/rrweb-io/rrweb) 2.2.0, copied from `node_modules` into `public/vendor/` by the Wrangler build step, never from a CDN) are static and hold no report data. The credential stays in the tab's memory, is sent only as an `Authorization` header to this server, and is never stored or turned into a cookie; reload the page and it is gone. The page's Content Security Policy allows only this server's scripts and connections, and inline styles so the recorded page's CSS can be drawn in the player's sandboxed frame; images from the recorded site and `data:` images are not loaded (the player's own cursor icon is copied out of its CSS into `public/vendor/` for that reason).

## Checks

`npm run check` regenerates binding types, typechecks, tests real R2 multipart/range/authorization/revocation behavior and the feedback API's origin, size, rate-limit, owner-access and delete rules, the rewind's size, format, owner-only read, delete and replay-page rules, and packages a deployment dry run. `worker-configuration.d.ts` is generated, never edited manually. Native CI checks the shared Rust client, desktop and CLI and builds an isolated macOS preview.

The platform roadmap and capture handoff contract are in [CLOUD-PLATFORM.md](../../CLOUD-PLATFORM.md). Source remains available under the repository's [license](../../LICENSE).
