import {
	EventType,
	type eventWithTime,
	IncrementalSource,
	record,
	type recordOptions,
} from "rrweb";
import { EDITABLE, MASKED } from "./evidence";
import { sanitizePath, sanitizeUrl } from "./route";
import type { RewindConfig, RouteRule } from "./types";

export const RRWEB_VERSION = "2.2.0";
export const REWIND_LIMITS = {
	minMinutes: 2,
	maxMinutes: 5,
	checkoutMs: 60_000,
	spanMs: 6 * 60_000,
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
	"datalist",
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
		private readonly limits: {
			events: number;
			chars: number;
			checkoutMs: number;
		} = REWIND_LIMITS,
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
		const oldest = now - this.windowMs - this.limits.checkoutMs;
		while ((this.segments[0]?.startedAt ?? oldest) < oldest)
			this.segments.shift();
		while (this.segments.length > 1 && this.over()) this.segments.shift();
		if (this.over() || !this.segments.length) this.clear();
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
	id?: number;
	type?: number;
	tagName?: string;
	attributes?: Record<string, unknown>;
	childNodes?: SerializedNode[];
};

const URL_ATTRIBUTES = [
	"href",
	"src",
	"action",
	"formaction",
	"poster",
	"data",
	"cite",
	"background",
	"xlink:href",
];

export interface PageAddress {
	href: string;
	rules?: RouteRule[];
}

export function cleanUrl(value: string, page: PageAddress): string {
	const trimmed = value.trim();
	if (!trimmed) return "";
	if (trimmed.startsWith("#"))
		return /^#[A-Za-z_-]{1,64}$/.test(trimmed) ? trimmed : "";
	try {
		const url = new URL(trimmed, page.href);
		if (url.protocol !== "http:" && url.protocol !== "https:") return "";
		return `${url.origin}${sanitizePath(url.pathname, page.rules)}`;
	} catch {
		return "";
	}
}

function cleanSrcset(value: string, page: PageAddress): string {
	if (/(^|[\s,])(data|blob):/i.test(value)) return "";
	return value
		.split(/,\s+/)
		.map((entry) => {
			const [url = "", ...descriptor] = entry.trim().split(/\s+/);
			return [cleanUrl(url, page), ...descriptor].join(" ");
		})
		.join(", ");
}

function cleanImageSets(value: string, page: PageAddress): string {
	let out = "";
	let rest = value;
	for (;;) {
		const match = /(?:-webkit-)?image-set\(/i.exec(rest);
		if (!match) return out + rest;
		const open = match.index + match[0].length;
		let depth = 1;
		let close = open;
		while (close < rest.length && depth > 0) {
			if (rest[close] === "(") depth++;
			else if (rest[close] === ")") depth--;
			close++;
		}
		const inner = rest
			.slice(open, depth ? rest.length : close - 1)
			.replace(
				/(['"])(.*?)\1/g,
				(_match, _quote, url: string) => `"${cleanUrl(url, page)}"`,
			);
		out += `${rest.slice(0, open)}${inner}${depth ? "" : ")"}`;
		rest = depth ? "" : rest.slice(close);
	}
}

function cleanStyle(value: string, page: PageAddress): string {
	return cleanImageSets(
		value.replace(
			/url\(\s*(['"]?)(.*?)\1\s*\)/gi,
			(_match, _quote, url: string) => `url("${cleanUrl(url, page)}")`,
		),
		page,
	);
}

function cleanStyleAttribute(value: unknown, page: PageAddress): unknown {
	if (typeof value === "string") return cleanStyle(value, page);
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const changes: Record<string, unknown> = {};
	for (const [property, change] of Object.entries(value)) {
		if (typeof change === "string")
			changes[property] = cleanStyle(change, page);
		else if (Array.isArray(change) && typeof change[0] === "string")
			changes[property] = [cleanStyle(change[0], page), ...change.slice(1)];
		else changes[property] = change;
	}
	return changes;
}

function scrubAttributes(
	tagName: string | undefined,
	attributes: Record<string, unknown>,
	page: PageAddress,
): void {
	if (tagName === "input" || tagName === "textarea")
		delete attributes.placeholder;
	delete attributes.srcdoc;
	for (const name of URL_ATTRIBUTES) {
		const value = attributes[name];
		if (typeof value === "string") attributes[name] = cleanUrl(value, page);
	}
	if (typeof attributes.ping === "string")
		attributes.ping = attributes.ping
			.split(/\s+/)
			.map((url) => cleanUrl(url, page))
			.filter(Boolean)
			.join(" ");
	for (const name of ["srcset", "imagesrcset"]) {
		const value = attributes[name];
		if (typeof value === "string") attributes[name] = cleanSrcset(value, page);
	}
	if ("style" in attributes)
		attributes.style = cleanStyleAttribute(attributes.style, page);
}

function scrubNode(node: SerializedNode | undefined, page: PageAddress): void {
	if (!node) return;
	if (node.attributes) scrubAttributes(node.tagName, node.attributes, page);
	for (const child of node.childNodes ?? []) scrubNode(child, page);
}

export function scrubEvent(
	event: { type: number; data?: unknown },
	page: PageAddress = { href: location.href },
): void {
	const data = event.data as
		| {
				href?: unknown;
				node?: SerializedNode;
				source?: number;
				adds?: Array<{ node?: SerializedNode }>;
				attributes?: Array<{
					id?: number;
					attributes?: Record<string, unknown>;
				}>;
		  }
		| undefined;
	if (!data) return;
	if (event.type === EventType.Meta && typeof data.href === "string") {
		const base = new URL(page.href);
		data.href = `${base.origin}${sanitizeUrl(data.href, page.href, page.rules).replace(/^(?!\/)/, "/")}`;
	}
	if (event.type === EventType.FullSnapshot) scrubNode(data.node, page);
	if (
		event.type === EventType.IncrementalSnapshot &&
		data.source === IncrementalSource.Mutation
	) {
		for (const add of data.adds ?? []) scrubNode(add.node, page);
		for (const change of data.attributes ?? [])
			if (change.attributes)
				scrubAttributes(undefined, change.attributes, page);
	}
}

interface MirrorLike {
	getNode(id: number): Node | null;
}

function parentOrHost(node: Node): Node | null {
	if (node instanceof ShadowRoot) return node.host;
	const parent = node.parentNode;
	return parent instanceof ShadowRoot ? parent.host : parent;
}

const BLOCKED = `${REWIND_BLOCK},.rr-block`;

const slotOf = (node: Node) =>
	(node as Partial<Pick<Element, "assignedSlot">>).assignedSlot ?? null;

function blockedAt(start: Node | null, depth: number): boolean {
	let current = start;
	while (current) {
		if (current instanceof Element && current.matches(BLOCKED)) return true;
		const slot = slotOf(current);
		if (slot && depth < 16 && blockedAt(slot, depth + 1)) return true;
		current = parentOrHost(current);
	}
	return false;
}

// A node is hidden when it sits in a blocked element, including through a
// shadow root (rrweb keeps observing shadow roots attached to a blocked host)
// or through a slot (light DOM projected into a masked part of a shadow tree
// renders there but is serialized as the host's child).
export function insideBlocked(
	node: Node | null,
	includeSelf: boolean,
): boolean {
	if (!node) return false;
	if (includeSelf) return blockedAt(node, 0);
	const slot = slotOf(node);
	if (slot && blockedAt(slot, 1)) return true;
	return blockedAt(parentOrHost(node), 0);
}

const isBlockedPlaceholder = (node: SerializedNode | undefined) =>
	!!node?.attributes && "rr_width" in node.attributes;

export class BlockFilter {
	private blocked = new Set<number>();
	private styles = new Set<number>();

	constructor(private readonly mirror: MirrorLike) {}

	private hidden(id: unknown, includeSelf: boolean): boolean {
		if (typeof id !== "number") return false;
		if (this.blocked.has(id)) return true;
		if (insideBlocked(this.mirror.getNode(id), includeSelf)) {
			this.blocked.add(id);
			return true;
		}
		return false;
	}

	private hide(node: SerializedNode): void {
		if (typeof node.id === "number") this.blocked.add(node.id);
		for (const child of node.childNodes ?? []) this.hide(child);
	}

	private collect(node: SerializedNode & { isShadowHost?: boolean }): void {
		if (isBlockedPlaceholder(node)) {
			if (typeof node.id === "number") this.blocked.add(node.id);
			for (const child of node.childNodes ?? []) this.hide(child);
			node.childNodes = [];
			return;
		}
		if (node.childNodes && node.isShadowHost)
			node.childNodes = node.childNodes.filter((child) => {
				const slotted =
					!(child as { isShadow?: boolean }).isShadow &&
					typeof child.id === "number" &&
					insideBlocked(this.mirror.getNode(child.id), false);
				if (slotted) this.hide(child);
				return !slotted;
			});
		for (const child of node.childNodes ?? []) this.collect(child);
	}

	keep(event: { type: number; data?: unknown }): boolean {
		const data = event.data as Record<string, unknown> | undefined;
		if (!data) return true;
		if (event.type === EventType.FullSnapshot) {
			this.blocked.clear();
			this.styles.clear();
			if (data.node) this.collect(data.node as SerializedNode);
			return true;
		}
		if (event.type !== EventType.IncrementalSnapshot) return true;
		const source = data.source;
		if (source === IncrementalSource.Mutation) {
			type Add = { parentId?: number; node?: SerializedNode };
			type Change = { id?: number };
			const kept: Add[] = [];
			for (const add of (data.adds as Add[] | undefined) ?? []) {
				if (
					(typeof add.parentId === "number" &&
						this.blocked.has(add.parentId)) ||
					this.hidden(add.node?.id, false)
				) {
					if (add.node) this.hide(add.node);
					continue;
				}
				if (add.node) this.collect(add.node);
				kept.push(add);
			}
			data.adds = kept.filter(
				(add) =>
					typeof add.parentId !== "number" || !this.blocked.has(add.parentId),
			);
			data.texts = ((data.texts as Change[] | undefined) ?? []).filter(
				(change) => !this.hidden(change.id, false),
			);
			data.attributes = (
				(data.attributes as Change[] | undefined) ?? []
			).filter((change) => !this.hidden(change.id, true));
			return true;
		}
		if (source === IncrementalSource.Selection) {
			const ranges =
				(data.ranges as Array<{ start?: number; end?: number }> | undefined) ??
				[];
			return !ranges.some(
				(range) =>
					this.hidden(range.start, true) || this.hidden(range.end, true),
			);
		}
		if (source === IncrementalSource.AdoptedStyleSheet) {
			if (!this.hidden(data.id, true)) return true;
			for (const id of (data.styleIds as number[] | undefined) ?? [])
				this.styles.add(id);
			return false;
		}
		if (
			(source === IncrementalSource.StyleSheetRule ||
				source === IncrementalSource.StyleDeclaration) &&
			typeof data.styleId === "number" &&
			this.styles.has(data.styleId)
		)
			return false;
		if (
			source === IncrementalSource.MouseInteraction ||
			source === IncrementalSource.MouseMove ||
			source === IncrementalSource.TouchMove ||
			source === IncrementalSource.Scroll ||
			source === IncrementalSource.ViewportResize ||
			source === IncrementalSource.Drag
		)
			return true;
		return !this.hidden(data.id, true);
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

export function startRewind(
	minutes: number,
	routeRules: RouteRule[] = [],
): Rewind | null {
	if (!rewindSupported()) return null;
	const buffer = new RewindBuffer(minutes * 60_000);
	const filter = new BlockFilter(record.mirror);
	let stopRecording: (() => void) | undefined;
	try {
		stopRecording = record(
			rewindRecordOptions((event) => {
				try {
					if (!filter.keep(event)) return;
					scrubEvent(event, { href: location.href, rules: routeRules });
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
		snapshot: () => {
			const current = buffer.snapshot();
			if (current) return current;
			try {
				record.takeFullSnapshot(true);
			} catch {}
			return buffer.snapshot();
		},
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
		const startedAt = snapshot.segments[first]?.startedAt ?? 0;
		if (snapshot.endedAt - startedAt > REWIND_LIMITS.spanMs) continue;
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
