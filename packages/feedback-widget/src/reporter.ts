import { type Collector, createCollector } from "./evidence";
import { buildEvidence, MAX_NOTE, reportForm } from "./report";
import { compressRewind, rewindMinutes, startRewind } from "./rewind";
import { captureScreenshot } from "./screenshot";
import type { FeedbackReporterConfig } from "./types";
import {
	MAX_VOICE_MS,
	type VoiceMemo,
	VoiceRecorder,
	voiceSupported,
} from "./voice";

export function origin(server: string): string {
	const url = new URL(server);
	const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (url.protocol !== "https:" && !(local && url.protocol === "http:"))
		throw new Error("The feedback server must be an https origin.");
	return url.origin;
}

export interface SendInput {
	note: string;
	screenshot: Blob | null;
	voice: VoiceMemo | null;
	includeRewind: boolean;
}

export interface FeedbackReporter {
	/** Rewind window in minutes, or null when no rewind is configured. */
	readonly rewindMinutes: number | null;
	readonly voiceSupported: boolean;
	readonly maxNote: number;
	readonly maxVoiceMs: number;
	/**
	 * The host-drawn panel. It is left out of screenshots and its clicks are
	 * not logged as evidence. Any element marked `data-worm-exclude` gets the
	 * same treatment.
	 */
	setPanel(element: Element | null): void;
	captureScreenshot(): Promise<Blob>;
	startVoice(onAutoStop: () => void): Promise<void>;
	stopVoice(): Promise<VoiceMemo>;
	cancelVoice(): void;
	send(input: SendInput): Promise<{ replaySent: boolean }>;
	destroy(): void;
}

export function createReporter(
	config: FeedbackReporterConfig,
): FeedbackReporter {
	const server = origin(config.server);
	if (!config.siteKey) throw new Error("The feedback widget needs a site key.");
	const post = window.fetch.bind(window);
	let panel: Element | null = null;
	const collector: Collector = createCollector({
		host: () => panel,
		ignoreOrigin: server,
		routeRules: config.routeRules,
		requestIdHeaders: config.requestIdHeaders,
		genericTestids: config.genericTestids,
	});
	const minutes = rewindMinutes(config.rewind);
	const rewind = minutes ? startRewind(minutes, config.routeRules) : null;
	let recorder: VoiceRecorder | null = null;

	return {
		rewindMinutes: rewind ? minutes : null,
		voiceSupported: voiceSupported(),
		maxNote: MAX_NOTE,
		maxVoiceMs: MAX_VOICE_MS,
		setPanel: (element) => {
			panel = element;
		},
		captureScreenshot: () => captureScreenshot(panel),
		startVoice: async (onAutoStop) => {
			recorder?.cancel();
			const next = new VoiceRecorder(onAutoStop);
			recorder = next;
			try {
				await next.start();
			} catch (error) {
				if (recorder === next) recorder = null;
				throw error;
			}
			// cancelVoice() ran while the microphone prompt was open.
			if (recorder !== next) {
				next.cancel();
				throw new Error("Recording was cancelled.");
			}
		},
		stopVoice: async () => {
			const active = recorder;
			if (!active) throw new Error("Not recording.");
			try {
				return await active.stop();
			} finally {
				if (recorder === active) recorder = null;
			}
		},
		cancelVoice: () => {
			recorder?.cancel();
			recorder = null;
		},
		send: async ({ note, screenshot, voice, includeRewind }) => {
			const evidence = await buildEvidence(collector, {
				getContext: config.getContext,
				posthog: config.posthog,
				voice,
			});
			const recording = rewind && includeRewind ? rewind.snapshot() : null;
			const rewindPart = recording ? await compressRewind(recording) : null;
			const submit = (part: Blob | null) =>
				post(`${server}/api/v1/feedback`, {
					method: "POST",
					body: reportForm({
						siteKey: config.siteKey,
						note,
						evidence,
						screenshot,
						voice,
						rewind: part,
					}),
					credentials: "omit",
					mode: "cors",
					referrerPolicy: "no-referrer",
				});
			let response = await submit(rewindPart);
			let replaySent = !!rewindPart;
			if (rewindPart && (response.status === 413 || response.status === 415)) {
				response = await submit(null);
				replaySent = false;
			}
			if (!response.ok) throw new Error(String(response.status));
			return { replaySent };
		},
		destroy: () => {
			recorder?.cancel();
			recorder = null;
			collector.stop();
			rewind?.stop();
			panel = null;
		},
	};
}
