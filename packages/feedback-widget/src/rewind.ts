import {
	EventType,
	type eventWithTime,
	IncrementalSource,
	record,
	type recordOptions,
} from "rrweb";
import { EDITABLE, MASKED } from "./evidence";
import type { RewindConfig } from "./types";

export const RRWEB_VERSION = "2.2.0";
export const REWIND_LIMITS = {
	minMinutes: 2,
	maxMinutes: 5,
	checkoutMs: 60_000,
	events: 20_000,
	chars: 8_000_000,
	gzipBytes: 4 * 1024 * 1024,
	jsonBytes: 24 * 1024 * 1024,
};

export const REWIND_BLOCK = [
	MASKED,
	EDITABLE,
	"select",
	"input[type=checkbox]",
	"input[type=radio]",
	"input[type=hidden]",
	"input[type=file]",
	"feedback-widget",
].join(",");

type MaskInputs = NonNullable<recordOptions<eventWithTime>["maskInputOptions"]>;

// rrweb's maskAllInputs lists input types, so an input with type=hidden or a
// type it does not know keeps its value; keying on the tag masks every input.
export const MASK_INPUTS = {
	input: true,
	textarea: true,
	select: true,
	password: true,
} as MaskInputs;
export const MASK_VALUE = "•••";

export function rewindMinutes(config: RewindConfig | undefined): number | null {
	const minutes = config?.minutes;
	if (typeof minutes !== "number" || !Number.isFinite(minutes)) return null;
	return Math.min(
		REWIND_LIMITS.maxMinutes,
		Math.max(REWIND_LIMITS.minMinutes, Math.round(minutes)),
	);
}

export function rewindSupported(): boolean {
	return (
		typeof CompressionStream === "function" &&
		typeof MutationObserver === "function"
	);
}

interface Segment {
	startedAt: number;
	events: string[];
	chars: number;
	full: boolean;
}

export interface RewindSnapshot {
	endedAt: number;
	segments: Array<{ startedAt: number; events: string[] }>;
}

export class RewindBuffer {
	private segments: Segment[] = [];
	private dropping = true;

	constructor(
		private readonly windowMs: number,
		private readonly limits: { events: number; chars: number } = REWIND_LIMITS,
	) {}

	push(event: { type: number; timestamp: number }, json: string): void {
		if (event.type === EventType.Meta) {
			this.segments.push({
				startedAt: event.timestamp,
				events: [],
				chars: 0,
				full: false,
			});
			this.dropping = false;
		}
		const current = this.segments.at(-1);
		if (this.dropping || !current) return;
		current.events.push(json);
		current.chars += json.length;
		if (event.type === EventType.FullSnapshot) current.full = true;
		this.trim(event.timestamp);
	}

	private trim(now: number): void {
		while (
			this.segments.length > 1 &&
			(this.segments[1]?.startedAt ?? now) <= now - this.windowMs
		)
			this.segments.shift();
		while (this.segments.length > 1 && this.over()) this.segments.shift();
		if (this.over()) this.clear();
	}

	private over(): boolean {
		const { events, chars } = this.size;
		return events > this.limits.events || chars > this.limits.chars;
	}

	get size(): { events: number; chars: number } {
		let events = 0;
		let chars = 0;
		for (const segment of this.segments) {
			events += segment.events.length;
			chars += segment.chars;
		}
		return { events, chars };
	}

	snapshot(now = Date.now()): RewindSnapshot | null {
		this.trim(now);
		const segments = this.segments
			.filter((segment) => segment.full)
			.map(({ startedAt, events }) => ({ startedAt, events: [...events] }));
		return segments.length ? { endedAt: now, segments } : null;
	}

	clear(): void {
		this.segments = [];
		this.dropping = true;
	}
}

type SerializedNode = {
	tagName?: string;
	attributes?: Record<string, unknown>;
	childNodes?: SerializedNode[];
};

function scrubNode(node: SerializedNode | undefined): void {
	if (!node) return;
	if (
		node.attributes &&
		(node.tagName === "input" || node.tagName === "textarea")
	)
		delete node.attributes.placeholder;
	for (const child of node.childNodes ?? []) scrubNode(child);
}

export function scrubEvent(event: { type: number; data?: unknown }): void {
	const data = event.data as
		| {
				node?: SerializedNode;
				source?: number;
				adds?: Array<{ node?: SerializedNode }>;
				attributes?: Array<{ attributes?: Record<string, unknown> }>;
		  }
		| undefined;
	if (!data) return;
	if (event.type === EventType.FullSnapshot) scrubNode(data.node);
	if (
		event.type === EventType.IncrementalSnapshot &&
		data.source === IncrementalSource.Mutation
	) {
		for (const add of data.adds ?? []) scrubNode(add.node);
		for (const change of data.attributes ?? [])
			if (change.attributes) delete change.attributes.placeholder;
	}
}

export function rewindRecordOptions(
	emit: (event: eventWithTime) => void,
): recordOptions<eventWithTime> {
	return {
		emit,
		checkoutEveryNms: REWIND_LIMITS.checkoutMs,
		blockClass: "rr-block",
		blockSelector: REWIND_BLOCK,
		maskTextSelector: `${MASKED},${EDITABLE}`,
		maskAllInputs: false,
		maskInputOptions: MASK_INPUTS,
		maskInputFn: () => MASK_VALUE,
		slimDOMOptions: "all",
		inlineStylesheet: true,
		inlineImages: false,
		collectFonts: false,
		recordCanvas: false,
		recordCrossOriginIframes: false,
		sampling: { mousemove: 100, scroll: 150, media: 800, input: "last" },
		errorHandler: () => true,
	};
}

export interface Rewind {
	readonly minutes: number;
	snapshot(): RewindSnapshot | null;
	stop(): void;
}

export function startRewind(minutes: number): Rewind | null {
	if (!rewindSupported()) return null;
	const buffer = new RewindBuffer(minutes * 60_000);
	let stopRecording: (() => void) | undefined;
	try {
		stopRecording = record(
			rewindRecordOptions((event) => {
				try {
					scrubEvent(event);
					buffer.push(event, JSON.stringify(event));
				} catch {}
			}),
		);
	} catch {
		return null;
	}
	if (!stopRecording) return null;
	return {
		minutes,
		snapshot: () => buffer.snapshot(),
		stop: () => {
			stopRecording?.();
			buffer.clear();
		},
	};
}

export function rewindJson(snapshot: RewindSnapshot): string {
	const startedAt = snapshot.segments[0]?.startedAt ?? snapshot.endedAt;
	const events = snapshot.segments
		.map((segment) => segment.events.join(","))
		.join(",");
	return `{"schemaVersion":1,"kind":"rrweb","rrweb":"${RRWEB_VERSION}","startedAt":${startedAt},"endedAt":${snapshot.endedAt},"events":[${events}]}`;
}

async function gzip(bytes: Uint8Array): Promise<ArrayBuffer> {
	const body = new Response(bytes as BodyInit).body;
	if (!body) throw new Error("Compression is unavailable.");
	return new Response(
		body.pipeThrough(new CompressionStream("gzip")),
	).arrayBuffer();
}

export async function compressRewind(
	snapshot: RewindSnapshot,
	limits: { gzipBytes: number; jsonBytes: number } = REWIND_LIMITS,
): Promise<Blob | null> {
	const encoder = new TextEncoder();
	for (let first = 0; first < snapshot.segments.length; first++) {
		const bytes = encoder.encode(
			rewindJson({ ...snapshot, segments: snapshot.segments.slice(first) }),
		);
		if (bytes.byteLength > limits.jsonBytes) continue;
		const compressed = await gzip(bytes);
		if (compressed.byteLength <= limits.gzipBytes)
			return new Blob([compressed], { type: "application/gzip" });
	}
	return null;
}
