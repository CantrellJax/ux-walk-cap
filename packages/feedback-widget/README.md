# Worm feedback button

A feedback button any web app can embed. A person types a note and can add a screenshot of the page and a voice memo of up to two minutes. Sites that turn on the rewind can also send a masked replay of the last few minutes of the page. The report also carries recent evidence: the route, viewport, browser, the last 50 clicks named the way Worm walks name them, console warnings and errors, uncaught exceptions, and failed requests. Everything is sent only to the site owner's own Worm server (`apps/cloud`). There is no Worm-run service.

The button and panel live in a Shadow DOM root, so the page's CSS cannot restyle them and theirs cannot leak out. Tap targets are at least 44 px, the panel becomes a bottom sheet on phones, respects safe-area insets and stays above the on-screen keyboard.

## Embed it

Script tag (the bundle is `dist/feedback-widget.js`; host it yourself, for example next to your app's assets):

```html
<script
	src="/vendor/feedback-widget.js"
	data-server="https://feedback.example.org"
	data-site-key="wf_pub_your_site_key"
	data-posthog="window"
	data-rewind-minutes="3"
></script>
```

Module (`dist/feedback-widget.mjs`):

```js
import { init } from "@cap-ux/feedback";

init({
	server: "https://feedback.example.org",
	siteKey: "wf_pub_your_site_key",
	getContext: () => ({ userId: user.id, orgId: org.id, release: BUILD_SHA }),
	posthog,
	routeRules: [{ pattern: /^\/reset\/[^/]+/, replace: "/reset/:token" }],
	rewind: { minutes: 3 },
});
```

| Option | Meaning |
| --- | --- |
| `server` | Your sharing server origin. HTTPS is required except for localhost. |
| `siteKey` | The publishable key for this site, configured on your server with the origins allowed to use it. It is not a secret. |
| `getContext` | Optional. Returns ids only: `userId`, `orgId`, `release`. Anything else, and any value that is not a short id (names, emails), is dropped. |
| `posthog` | Optional PostHog instance. Each report stores its session id and replay link so the report can be matched to PostHog's replay. `data-posthog="window"` uses `window.posthog`. |
| `routeRules` | Extra path rewrites applied after the defaults. Query strings and fragments are always removed; numeric ids, UUIDs, emails and long token-like segments become `:id`, `:email` or `:token`. |
| `requestIdHeaders` | Response headers read as a request id on failed requests (default `x-request-id`, `x-correlation-id`, `request-id`, `x-amzn-requestid`, `cf-ray`). Cross-origin APIs must expose the header. |
| `rewind` | Optional, off by default. `{ minutes: 2 }` to `{ minutes: 5 }` (`data-rewind-minutes` on the script tag) keeps a masked replay of the last minutes of the page in memory and offers it with each report. See [Rewind](#rewind). Turn it on only for the testers who should send it, for example from a feature flag. |
| `genericTestids` | Wrapper test ids that name no feature, skipped in click labels as in walks. |
| `position`, `label` | `bottom-right` (default) or `bottom-left`, and the button text. |

The page's Content Security Policy must allow `connect-src` to your sharing server, and `img-src blob:` and `media-src blob:` for the screenshot and voice previews. The rewind needs nothing more.

### Fitting it into your app's layers

Two CSS custom properties, set on the `feedback-widget` element from your own stylesheet, fit the widget under your app's chrome:

```css
/* Below your menus, sheets and popovers (default: the top of the page). */
feedback-widget { --wf-z: 45; }
/* No floating button, for example where a bottom tab bar owns that corner; open the panel from your own menu with the handle's open(). */
@media (max-width: 1023px) { feedback-widget { --wf-launcher-display: none; } }
```

## Rewind

With `rewind` set, the widget records the page with [rrweb](https://github.com/rrweb-io/rrweb) 2.2.0 (pinned, bundled into the widget, nothing loaded from a CDN) while the page is open. It keeps only the last N minutes in a ring buffer in the page's memory: a full snapshot of the page every minute, the changes, scrolls, clicks and pointer moves since, and it drops whole minutes as they age out. Nothing is written to storage and nothing is sent while recording. A full page load starts a new buffer; single-page app navigation keeps it.

When the tester opens the panel they see "Include the last N minutes of this page", checked. If they leave it checked, pressing Send adds the buffer to the same report as a gzip-compressed part (`rewind.json.gz`). Unchecking it sends the report without it. If they never press Send, the recording never leaves the browser.

**What it captures:** the page's layout and visible text as it changed, the page's CSS (inlined), scrolling, clicks, pointer movement and the viewport size, for the last N minutes up to Send (up to a minute more, because whole minutes are dropped).

**What is masked** (at least as strict as the screenshot):

- Every `input` and `textarea` value is replaced with `•••`, whatever its type, so neither the text nor its length is recorded. Placeholders are removed.
- Every element marked `data-worm-mask`, every editable region (`contenteditable`), every `select`, `datalist`, checkbox, radio, hidden and file input is blocked: the replay shows an empty box of the same size, and nothing inside it, typed into it or changed in it is recorded. That includes a shadow root attached to it later, for example a custom element defined after the widget loads, and page content placed into a masked part of a component through a `<slot>` (the content stays in the page's DOM but shows inside the masked area).
- The page address keeps only its sanitized path (the same rules as routes in the evidence: no query string or fragment, ids become `:id`, your `routeRules` apply). Every URL in `href`, `src`, `srcset`, `imagesrcset`, `action`, `formaction`, `poster`, `data`, `cite`, `ping`, `background`, and `url()` and `image-set()` in `style` attributes (including styles a script sets later) gets the same treatment. Only ids, emails and token-like segments are cut automatically: a path segment that is a name or other readable text (`/patients/jane-doe/chart`) stays unless one of your `routeRules` rewrites it; `data:`, `blob:`, `mailto:`, `tel:` and other non-web URLs are emptied (so a signature or scanned card drawn as a `data:` image is not recorded), and iframe `srcdoc` is dropped. The page's own stylesheets are inlined as they are, `data:` fonts and icons included.
- The widget itself (its shadow root, the note and the checkbox) is blocked.
- Canvas drawing, fonts, images (as pixels), and cross-origin iframes are not captured. Images appear only as their URLs, and the replay page does not load them.

A component with a closed shadow root cannot be looked into, so content it shows is recorded unless the component's host element itself has `data-worm-mask`; put it on the host of any closed component that can show patient data. Mark anything else that can show patient or personal data with `data-worm-mask`: outside masked areas, everything visible on the page is in the replay, and so are element attributes that are not shown on screen (`aria-label`, `title`, `alt`, `data-*` and the like), text that is in the page but not visible, and CSS, including generated `content`. For a healthcare app, mask record views, or turn the rewind on only for testers who use test data.

**Limits:** at most 20,000 events and about 8 million characters in memory (the oldest minute goes first; a single minute over the cap is dropped until the next snapshot), and at most 4 MB compressed and 24 MB uncompressed per upload (older minutes are dropped to fit; if even the last minute is too large, the report is sent without it and the tester is told). A rewind never spans more than the chosen minutes plus one: after a long idle stretch, only the time since the last activity is kept. If the server refuses the rewind (413 or 415), the widget sends the report again without it and tells the tester. The rewind needs `CompressionStream` (Chrome 80, Firefox 113, Safari 16.4); elsewhere the checkbox is not shown. rrweb is in the bundle even when the rewind is off: the script grows from 46 KB to 229 KB minified (77 KB gzip).

If the page already runs a session recorder (PostHog, Sentry replay), both record independently. The widget marks itself `rr-block`, so the page's own recorder does not capture the widget either.

The rewind is stored only on your Worm server, deleted with the report and kept as long as the report. The owner replays it at `https://YOUR_SERVER/rewind/REPORT_ID` with the owner credential, or saves it with `cap feedback pull`. See the [cloud README](../../apps/cloud/README.md#feedback-from-your-web-apps).

## Draw your own panel

`createReporter(config)` is the widget without its UI. `init` uses it too, so both send the same thing. The config is the one `init` takes, minus `position` and `label`. It returns `rewindMinutes`, `voiceSupported`, `maxNote`, `maxVoiceMs`, `setPanel(el)`, `captureScreenshot()`, `startVoice(onAutoStop)`, `stopVoice()`, `cancelVoice()`, `send({ note, screenshot, voice, includeRewind })` and `destroy()`.

Pass your panel element to `setPanel`. It is left out of screenshots and clicks inside it are not logged. Mark any other element of yours (a scrim, a toast) `data-worm-exclude` for the same treatment. Mark the panel `data-worm-mask` so the rewind hides it.

## What leaves the browser

Only the report, sent to your configured server: the note, the evidence JSON, an optional JPEG screenshot, an optional voice memo (WebM/Opus in Chrome and Firefox, MP4/AAC in Safari on iPhone and Mac) and, if the site turned it on and the tester left it checked, the rewind.

- Screenshots are drawn from the DOM. Every input, textarea, select, editable region and every element marked `data-worm-mask` (and everything inside it) has its contents removed from the copy before it is drawn, and its on-screen box is painted over afterwards, which also covers a marked canvas, video or iframe. Elements in open shadow roots are included. The page itself is never changed. Mark anything else that can show patient or personal data with `data-worm-mask`.
- Clicks use the walk recorder's label rules (`vendor/ux-walk/src/labels.mjs`): test ids, roles and visible labels, never field values. A click inside a `data-worm-mask` region or an editable region, or on a control that contains one, keeps only the element's tag, role and test ids, and a table row's label is dropped when that row has masked cells. Emails in labels become `[email]`.
- Console text and errors pass through the walk recorder's redaction (`vendor/ux-walk/src/redact.mjs`) plus key-based redaction of logged objects; query strings are cut from URLs.
- Failed requests record method, path, status, duration and a request id header. No bodies, headers or cookies.
- The widget marks itself for exclusion from session replay tools (`ph-no-capture`, `rr-block`, `sentry-block`, `fs-exclude`, `data-private`), so a note being typed is not recorded by the page's replay.
- Screenshots and PHI: a screenshot shows whatever is on screen outside the masked elements. For a healthcare app, mask record views, or leave screenshots to people who know what is on their screen.

## Develop

```sh
npm ci --ignore-scripts
npm run build      # dist/feedback-widget.js and .mjs
npm test           # unit tests: masking, redaction, ring buffers, rewind caps and opt-out
npm run test:e2e   # Playwright at desktop and phone size (Google Chrome)
```

`demo/index.html` loads the built bundle against a local Worm Worker on port 8787, with a two-minute rewind. The Playwright tests serve the demo themselves. The rewind test runs the real Worker from `apps/cloud` in Miniflare (no network, ephemeral R2): it records, sends, checks the stored part is masked, and replays it on the owner page. `npm run test:e2e` bundles the Worker first, so install `apps/cloud` too (`npm ci --ignore-scripts --prefix ../../apps/cloud`).
