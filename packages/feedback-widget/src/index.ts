import type {
	FeedbackWidget,
	FeedbackWidgetConfig,
	PostHogLike,
} from "./types";
import { mountWidget } from "./widget";

export type { FeedbackReporter, SendInput } from "./reporter";
export { createReporter } from "./reporter";
export type * from "./types";

let active: FeedbackWidget | null = null;

export function init(config: FeedbackWidgetConfig): FeedbackWidget {
	active?.destroy();
	const start = () => mountWidget(config);
	if (document.body) {
		active = start();
		return active;
	}
	let mounted: FeedbackWidget | null = null;
	const pending: FeedbackWidget = {
		open: () => mounted?.open(),
		close: () => mounted?.close(),
		destroy: () => {
			document.removeEventListener("DOMContentLoaded", ready);
			mounted?.destroy();
		},
	};
	const ready = () => {
		mounted = start();
	};
	document.addEventListener("DOMContentLoaded", ready, { once: true });
	active = pending;
	return pending;
}

export function autoInit(
	script: HTMLScriptElement | null,
): FeedbackWidget | null {
	const server = script?.dataset.server;
	const siteKey = script?.dataset.siteKey;
	if (!script || !server || !siteKey) return null;
	const posthog =
		script.dataset.posthog === "window"
			? (window as unknown as { posthog?: PostHogLike }).posthog
			: undefined;
	const minutes = Number(script.dataset.rewindMinutes);
	return init({
		server,
		siteKey,
		posthog,
		...(minutes ? { rewind: { minutes } } : {}),
		label: script.dataset.label,
		position:
			script.dataset.position === "bottom-left"
				? "bottom-left"
				: "bottom-right",
	});
}
