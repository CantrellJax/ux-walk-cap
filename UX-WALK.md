# Cap with ux-walk

This fork extends [Cap](https://github.com/CapSoftware/Cap) with a small macOS walkthrough entry point. Changes began on October 23, 2026. Cap's copyright notices and AGPLv3 license remain in [LICENSE](LICENSE); the MIT and third-party exceptions described there remain unchanged.

## First slice

**Select Mode → Walkthrough…** opens `ux-walk://start?capture=cap`. Install the [ux-walk companion](https://github.com/CantrellJax/ux-walk) first. The existing Start a walk dialog asks for a topic, display and optional devices. Opening a link never starts capture by itself.

Cap's Studio CLI owns the continuous screen recording and separate camera/audio assets. ux-walk owns notes, chapters, screenshots, observations and its report. The ux-walk floating bar controls this CLI recording. Cap's desktop recording controls do not mirror it. Studio, Instant and Screenshot remain Cap's three persisted capture modes; Walkthrough is a launch preset, indicated by its ellipsis.

Opening a second link focuses the existing setup or leaves the current walk intact. Stop ends a recording ux-walk started. Ending a log attached to another recording leaves that recording running. A log-only session can still use ux-walk's native instructions capture without Cap.

This does not yet attach to a recording started with Cap's GUI. Shipping GPUI needs a lifecycle contract containing recording identity, project path, target and bounded start/pause/stop clocks. Legacy Tauri automation hooks do not establish that contract.

## Updates

The default `ux-walk` Cargo feature in the desktop and CLI packages prevents official Cap update installers from overwriting this fork. Manual desktop update checks open this fork's releases. There is no fork signed binary update feed yet. Do not distribute a build with `--no-default-features`: that restores the official updater.

The fork-owned upstream workflow merges upstream main into an update PR and dispatches scoped native checks. Conflicts and failed checks require review; upstream code never replaces main automatically. The companion separately monitors compatibility with official Cap releases. Build and validate the native menu before installing this fork; source changes and a successful companion check alone do not prove that menu works.

## Local preview

Manually run **ux-walk native checks** with `preview=true` to build a debug app after the checks pass. This extends the existing GPUI/Tauri packaging pipeline. Debug previews use the native host target and genuine debug artifact paths; release packaging keeps its existing target and source checks.

The artifact contains **Cap Walkthrough Preview.app** in a zip, its source revision, checksum and license. The preview has its own bundle identifier and temporary data/log/recording directories per revision. It registers no Cap URL scheme or recording file association. It does not copy the installed Cap account, settings or library. Opening the preview still follows macOS's ordinary permission flow; a fresh profile can show onboarding until required permissions are granted. Native compile/tests alone do not count as a menu, URL-delivery or recording pass.

## Sharing

Cap's public source already includes S3-compatible and Google Drive storage integrations and its web viewer. The intended fork deployment makes owned-storage capabilities standard, using our own hosted service, storage and Google OAuth application. Cap Cloud subscriptions and infrastructure are separate. This first slice does not deploy a server, connect accounts, change cloud entitlements or upload a recording. AI processing, storage and hosting retain their service costs.

Keep the delta small: reuse Cap's upload/viewer paths and access checks. Do not build a second publisher or editor into ux-walk. Preserve licensing/source access for any distributed desktop build and hosted modifications. Our branding and signing identity must distinguish fork builds before public binary distribution.
