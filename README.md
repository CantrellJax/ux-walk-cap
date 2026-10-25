<p align="center">
  <img width="144" height="144" src="apps/desktop-gpui/assets/branding/cap-ux.svg" alt="Cap UX logo: blue Cap rings with UX in the center">
</p>

<h1 align="center">Cap UX</h1>

<p align="center">Record the walkthrough. Keep the evidence. Give your agent the context.</p>

<p align="center">
  <a href="https://github.com/CantrellJax/ux-walk-cap/releases">Releases</a> ·
  <a href="UX-WALK.md">How it works</a> ·
  <a href="https://github.com/CantrellJax/ux-walk-cap/issues">Feedback</a> ·
  <a href="https://github.com/CapSoftware/Cap">Built on Cap</a>
</p>

Cap UX combines [Cap](https://github.com/CapSoftware/Cap)'s screen recorder and editor with [UX Walk](vendor/ux-walk)'s chapters, notes, transcripts and agent-ready evidence. It is an independent open-source fork for product walkthroughs, bug reports and design reviews.

## What you get

- **UX Walk in every mode picker.** Open a fresh Chrome window from the menu, recorder or mode picker, already selected for capture. Onboarding introduces it alongside Instant, Studio and Screenshot.
- **One settings window.** Walk defaults live in General, the output folder in Recordings, and providers in Transcription. The CLI reads the same preferences.
- **Your transcription provider.** ElevenLabs Scribe, AssemblyAI, Descript, or no transcription. Existing Keychain entries are reused. Cap editor captions keep their local models.
- **Evidence an agent can read.** Video, screenshots, timestamped notes, chapters and a local report stay together. The walk's Chrome window adds semantic clicks, console warnings/errors, page exceptions and redacted failed-request diagnostics. Reports show when browser evidence is partial or unavailable.
- **Notes and handoff in your library.** Filter recordings by UX Walk, view a walk's notes or copy its agent prompt. Assign walk shortcuts in the existing Shortcuts settings.
- **Cap's editor.** Keep the original recording as evidence and edit a copy for sharing.

## Try it

Cap UX is currently a macOS 15+ developer preview. A signed public installer is not available yet. The native CI workflow can build an isolated **Cap UX Preview.app** with its own profile, the pinned UX Walk engine, a Node runtime and the native walk adapter.

Fresh walk windows use Google Chrome. The walkthrough processor currently needs FFmpeg on your Mac. Optional chapter briefs need your configured Claude CLI; agent handoffs to cmux need cmux. Cloud transcription needs your own provider key. UX Walk does not automatically publish recordings.

For a source build, clone the repository:

```sh
git clone https://github.com/CantrellJax/ux-walk-cap.git
cd ux-walk-cap
```

Use Xcode 26 or newer with the existing Cap setup/build pipeline below, install the engine dependencies with `npm ci --ignore-scripts --prefix vendor/ux-walk`, then run `node scripts/bundle-ux-walk.mjs /path/to/Cap\ UX.app` after packaging. The engine comes from the pinned source snapshot; a separate UX Walk installation is unnecessary.

## Contribute

Try a real workflow and tell us where the recording, notes or handoff lose context. Issues and small pull requests are welcome. If this helps your team, a GitHub star helps other people find it.

## License and attribution

Cap UX is distributed under AGPLv3 with the MIT and third-party exceptions in [LICENSE](LICENSE). The bundled UX Walk engine is also AGPLv3. The logo adapts Cap's ring mark with a UX monogram. Cap's team built the recording and editing foundation; this fork is independently maintained and is not an official Cap release.

Upstream changes are proposed as update pull requests, reviewed and built before release. Cap UX has its own application identity and library, and official Cap update installers are disabled for fork builds. Cap Cloud and other hosted services retain their own terms and costs.

## Upstream Cap development and self-hosting

The remaining documentation describes the underlying Cap platform. Its cloud features require the appropriate service or a self-hosted deployment.

## Self-Hosting

The fastest way to self-host Cap Web is Docker Compose:

```bash
git clone https://github.com/CapSoftware/Cap.git
cd Cap
docker compose up -d
```

Cap will be available at `http://localhost:3000`.

Login links appear in the service logs when email is not configured:

```bash
docker compose logs cap-web
```

### Deployment Options

| Method | Best for |
| --- | --- |
| Docker Compose | VPS, home servers, and any Docker-capable host |
| [Railway](https://railway.com/new/template/PwpGcf) | One-click managed hosting |
| Coolify | Self-hosted PaaS deployments with `docker-compose.coolify.yml` |

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/PwpGcf)

For production, configure public URLs and replace the default secrets before exposing the deployment to the internet:

```bash
CAP_URL=https://cap.yourdomain.com
S3_PUBLIC_URL=https://s3.yourdomain.com
```

See the [self-hosting guide](https://cap.so/docs/self-hosting) for email setup, AI providers, SSL, storage, production hardening, and troubleshooting.

## Local Development

Cap is a Turborepo monorepo with Rust, TypeScript, Tauri, SolidStart, Next.js, Drizzle, MySQL, Tailwind CSS, and shared media crates.

Requirements:

- Node.js 20 or newer
- Bun 1.4.0
- Rust 1.88 or newer
- Docker for MySQL, MinIO, and local services

Install and set up the repo:

```bash
bun install
bun run env-setup
bun run cap-setup
```

Common commands:

| Command | Purpose |
| --- | --- |
| `bun run dev` | Start the full local development stack |
| `bun run dev:web` | Start the web app without the desktop app |
| `bun run dev:desktop` | Start the desktop app |
| `bun run build` | Build the workspace |
| `bun run tauri:build` | Build the desktop release |
| `bun run lint` | Run Biome linting |
| `bun run format` | Format with Biome |
| `bun run typecheck` | Run TypeScript project references |
| `cargo test -p <crate>` | Run Rust tests for a crate |

Database commands:

| Command | Purpose |
| --- | --- |
| `bun run db:generate` | Generate database artifacts |
| `bun run db:push` | Push schema changes |
| `bun run db:studio` | Open Drizzle Studio |

## Repository Map

| Path | What lives there |
| --- | --- |
| `apps/desktop` | Tauri v2 desktop app with SolidStart UI and Rust backend |
| `apps/web` | Next.js web app for marketing, docs, dashboard, sharing, API routes, and auth |
| `apps/cli` | Rust CLI |
| `apps/media-server` | Media processing service used by the web app |
| `apps/discord-bot` | Discord integration |
| `packages/database` | Drizzle schema and database access |
| `packages/ui` | Shared React UI |
| `packages/ui-solid` | Shared Solid UI |
| `packages/web-backend` | Backend service layer |
| `packages/web-domain` | Web domain models and types |
| `packages/env` | Environment validation |
| `packages/sdk-embed` | Embed SDK |
| `packages/sdk-recorder` | Recorder SDK |
| `crates/*` | Recording, capture, camera, audio, encoding, rendering, muxing, export, and test crates |
| `scripts/*` | Setup, analytics, build, and maintenance tooling |
| `infra/*` | Infrastructure configuration |

The web API uses Effect and `@effect/platform` HTTP APIs. Desktop capture and export paths are backed by Rust crates for fast recording, rendering, and platform-specific media access.

## Analytics

Cap uses [Tinybird](https://www.tinybird.co) for viewer telemetry dashboards. Set `TINYBIRD_ADMIN_TOKEN` or `TINYBIRD_TOKEN` before running analytics commands.

| Command | Purpose |
| --- | --- |
| `bun run analytics:setup` | Deploy Tinybird datasources and pipes from `scripts/analytics/tinybird` |
| `bun run analytics:check` | Validate that the Tinybird workspace matches the app expectations |

`analytics:setup` can remove Tinybird resources outside the checked-in analytics configuration. Use it only against the workspace you intend to manage from this repo.

## Contributing

Cap is built in public. Issues, pull requests, design feedback, bug reports, docs fixes, and bounties are welcome.

- Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.
- Join the community on [Discord](https://cap.link/discord).
- Check open bounties on [Algora](https://console.algora.io/org/CapSoftware/bounties?status=open).

## License

Portions of this software are licensed as follows:

- Code in the `cap-camera*` and `scap-*` crate families is licensed under the MIT License. See [licenses/LICENSE-MIT](https://github.com/CapSoftware/Cap/blob/main/licenses/LICENSE-MIT).
- Third-party components are licensed under the original license provided by their owner.
- All other content not mentioned above is available under the AGPLv3 license as defined in [LICENSE](https://github.com/CapSoftware/Cap/blob/main/LICENSE).
