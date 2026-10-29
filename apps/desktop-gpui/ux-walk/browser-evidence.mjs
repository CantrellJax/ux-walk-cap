import fs from "node:fs";
import path from "node:path";

const allowed = new Set([
	"click",
	"rightclick",
	"nav",
	"view",
	"text",
	"dialog",
	"console",
	"pageerror",
	"http",
	"write",
	"network",
	"slow",
	"load",
	"env",
	"note",
	"mark",
	"meet-caption",
	"meet-participants",
	"meet-health",
]);

export function safeBrowserUrl(value) {
	try {
		const relative = String(value).startsWith("/");
		const url = new URL(value, "https://relative.invalid");
		if (!["http:", "https:"].includes(url.protocol)) return "";
		return relative
			? url.pathname
			: `${url.protocol}//${url.host}${url.pathname}`;
	} catch {
		return "";
	}
}

export function redactBrowserText(value, limit = 4000) {
	return String(value ?? "")
		.replace(/https?:\/\/[^\s"'<>)]*/gi, (url) => safeBrowserUrl(url))
		.replace(
			/(?:authorization|cookie|set-cookie)\s*[:=]\s*[^\n\r]+/gi,
			"[credential redacted]",
		)
		.replace(/\bBearer\s+[\w.+/=-]+/gi, "Bearer [redacted]")
		.replace(
			/(["']?(?:password|passwd|token|access_token|refresh_token|secret|api[_-]?key|otp)[\w-]*["']?\s*[:=]\s*)["']?[^\s,;&"'}]+["']?/gi,
			"$1[redacted]",
		)
		.replace(/[^\s@"'<>,;:()=&]+@[^\s@"'<>,;:()]+\.[a-z]{2,}/gi, "[email]")
		.slice(0, limit);
}

function element(value) {
	if (!value || typeof value !== "object") return undefined;
	const result = {};
	for (const key of [
		"tag",
		"role",
		"testid",
		"text",
		"aria",
		"label",
		"ctx",
		"row",
	]) {
		if (typeof value[key] === "string")
			result[key] = redactBrowserText(value[key], 200);
	}
	for (const key of ["control", "editable", "on", "area"]) {
		if (typeof value[key] === "boolean") result[key] = value[key];
	}
	return result;
}

function responseError(body) {
	if (!body) return undefined;
	try {
		const value = JSON.parse(body);
		const result = {};
		for (const key of [
			"code",
			"message",
			"details",
			"hint",
			"error",
			"error_description",
		]) {
			if (["string", "number"].includes(typeof value?.[key]))
				result[key] = redactBrowserText(value[key], 600);
		}
		return Object.keys(result).length ? JSON.stringify(result) : undefined;
	} catch {
		return undefined;
	}
}

export function sanitizeBrowserEvent(raw, receivedAt = Date.now()) {
	if (!raw || !allowed.has(raw.ev)) return null;
	const result = { ev: raw.ev, observedAt: receivedAt };
	if (Number.isSafeInteger(raw.t) && raw.t >= 0 && raw.t <= receivedAt)
		result.observedAt = raw.t;
	for (const key of [
		"text",
		"title",
		"why",
		"failure",
		"viewport",
		"ua",
		"lang",
		"tz",
	]) {
		if (typeof raw[key] === "string") result[key] = redactBrowserText(raw[key]);
	}
	for (const key of [
		"status",
		"ms",
		"startedAt",
		"completedAt",
		"durationMs",
		"waitMs",
		"ttfb",
		"dcl",
		"load",
		"dpr",
	]) {
		if (Number.isFinite(raw[key])) result[key] = raw[key];
	}
	if (typeof raw.url === "string") result.url = safeBrowserUrl(raw.url);
	if (typeof raw.method === "string") result.method = raw.method.slice(0, 12);
	if (["warning", "error"].includes(raw.level)) result.level = raw.level;
	if (typeof raw.requestId === "string")
		result.requestId = raw.requestId.slice(0, 80);
	if (typeof raw.intentionalLongPoll === "boolean")
		result.intentionalLongPoll = raw.intentionalLongPoll;
	if (typeof raw.open === "boolean") result.open = raw.open;
	if (
		raw.source === "chrome-extension" &&
		raw.companion &&
		["walkthrough", "meet"].includes(raw.companion.role)
	) {
		result.source = "chrome-extension";
		if (Number.isSafeInteger(raw.observedAt) && raw.observedAt >= 0)
			result.observedAt = raw.observedAt;
		result.timingUncertain = raw.timingUncertain === true;
		result.companion = {};
		for (const key of [
			"role",
			"bindingId",
			"clientId",
			"documentId",
			"recordingId",
			"generation",
			"meeting",
		])
			if (typeof raw.companion[key] === "string")
				result.companion[key] = raw.companion[key].slice(0, 200);
		if (Number.isSafeInteger(raw.companion.tabId))
			result.companion.tabId = raw.companion.tabId;
		if (typeof raw.eventId === "string")
			result.eventId = raw.eventId.slice(0, 160);
		if (raw.ev === "meet-caption") {
			result.name = String(raw.name ?? "").slice(0, 128);
			result.text = String(raw.text ?? "").slice(0, 8000);
			result.captionId = String(raw.captionId ?? "").slice(0, 160);
			result.revision = raw.revision;
			result.localSpeaker = raw.localSpeaker === true;
			result.identity = "Meet caption display name; unconfirmed";
		}
		if (raw.ev === "meet-participants" && Array.isArray(raw.names))
			result.names = raw.names
				.slice(0, 64)
				.map((name) => String(name).slice(0, 128));
		if (
			raw.ev === "meet-health" &&
			["on", "off", "unknown"].includes(raw.captions)
		) {
			result.captions = raw.captions;
			result.visible = raw.visible === true;
		}
		result.truncated = raw.truncated === true;
		if (
			raw.viewport &&
			[raw.viewport.width, raw.viewport.height].every(
				(value) => Number.isFinite(value) && value > 0 && value <= 50000,
			)
		)
			result.viewport = {
				width: raw.viewport.width,
				height: raw.viewport.height,
			};
	} else if (raw.ev.startsWith("meet-")) return null;
	if (Array.isArray(raw.lines))
		result.lines = raw.lines
			.slice(0, 8)
			.map((line) => redactBrowserText(line, 200));
	if (raw.el) result.el = element(raw.el);
	if (["http", "write"].includes(raw.ev) && raw.status >= 400) {
		const error = responseError(raw.resBody);
		if (error) result.resBody = error;
	}
	if (raw.ev === "note") {
		if (typeof raw.id === "string" && /^browser-\d+$/.test(raw.id))
			result.id = raw.id;
		else if (Number.isSafeInteger(raw.id) && raw.id > 0)
			result.id = `browser-${raw.id}`;
		else return null;
		if (["box", "pin"].includes(raw.mode)) result.mode = raw.mode;
		if (raw.edit === true) result.edit = true;
		for (const key of ["shot", "full"]) {
			if (/^notes\/[\w-]+\.png$/.test(raw[key])) result[key] = raw[key];
		}
		if (
			raw.box &&
			["x", "y", "w", "h"].every((key) => Number.isFinite(raw.box[key]))
		) {
			result.box = Object.fromEntries(
				["x", "y", "w", "h"].map((key) => [key, raw.box[key]]),
			);
		}
	}
	return result;
}

const unavailable = (reason = "not captured") => ({
	events: [],
	meetEvents: [],
	coverage: { dom: reason, network: reason, console: reason },
});

function sameFile(first, second) {
	try {
		return fs.realpathSync(first) === fs.realpathSync(second);
	} catch {
		return false;
	}
}

export function browserEvidenceMatches(
	metadata,
	journal,
	file,
	compare = sameFile,
) {
	return !!(
		metadata?.schemaVersion === 1 &&
		metadata.captureId &&
		metadata.windowId &&
		metadata.state !== "unavailable" &&
		compare(String(metadata.journal || ""), file) &&
		compare(String(metadata.sourceProject || ""), journal.sourceProject) &&
		metadata.startedAtMs === journal.startedAtMs &&
		Array.isArray(metadata.anchors)
	);
}

function companionEventMatches(event, owner) {
	return (
		typeof owner?.recordingId === "string" &&
		typeof owner.generation === "string" &&
		event.companion?.recordingId === owner.recordingId &&
		event.companion?.generation === owner.generation
	);
}

export function projectBrowserEvidence(file, journal) {
	const directory = path.dirname(path.resolve(file));
	const metadataFile = path.join(directory, "browser-evidence.json");
	if (!fs.existsSync(metadataFile)) return unavailable();
	let metadata;
	try {
		metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
	} catch {
		return unavailable("unavailable: browser collector metadata is unreadable");
	}
	if (metadata.state === "unavailable")
		return unavailable(
			`not captured: ${metadata.reason || "browser collector unavailable"}`,
		);
	if (!browserEvidenceMatches(metadata, journal, file))
		return unavailable(
			"unavailable: browser evidence recording identity mismatch",
		);
	const anchors = metadata.anchors;
	let previousOffset = -1;
	for (const anchor of anchors) {
		if (
			!Number.isSafeInteger(anchor.wallMs) ||
			!Number.isSafeInteger(anchor.offsetMs) ||
			anchor.wallMs < 0 ||
			anchor.offsetMs < previousOffset ||
			anchor.offsetMs > journal.durationMs ||
			typeof anchor.paused !== "boolean"
		)
			return unavailable("unavailable: browser evidence clock is invalid");
		previousOffset = anchor.offsetMs;
	}
	if (
		!anchors.length ||
		anchors[0].wallMs !== journal.startedAtMs ||
		anchors[0].offsetMs !== 0
	)
		return unavailable("unavailable: browser evidence clock is unbound");
	const offsetAt = (wall) => {
		const anchor = anchors.findLast((entry) => entry.wallMs <= wall);
		if (!anchor || anchor.paused) return null;
		const offset = anchor.offsetMs + wall - anchor.wallMs;
		return offset >= 0 && offset <= journal.durationMs ? offset : null;
	};
	const events = [];
	const meetEvents = [];
	let malformed = 0;
	try {
		for (const line of fs
			.readFileSync(path.join(directory, "browser-evidence.jsonl"), "utf8")
			.split("\n")) {
			if (!line.trim()) continue;
			try {
				const raw = JSON.parse(line);
				if (
					raw.source === "chrome-extension" &&
					!companionEventMatches(raw, metadata)
				)
					throw new Error("Browser event recording identity mismatch");
				if (!Number.isSafeInteger(raw.observedAt))
					throw new Error("Invalid observedAt");
				if (raw.ev === "meet-caption") meetEvents.push(raw);
				const offset =
					Number.isSafeInteger(raw.nativeOffsetMs) &&
					raw.nativeOffsetMs >= 0 &&
					raw.nativeOffsetMs <= journal.durationMs
						? raw.nativeOffsetMs
						: offsetAt(raw.observedAt);
				if (offset === null) continue;
				const safe = sanitizeBrowserEvent(raw, raw.observedAt);
				if (!safe) continue;
				events.push({
					...safe,
					...(Number.isSafeInteger(raw.nativeOffsetMs)
						? {
								nativeOffsetMs: raw.nativeOffsetMs,
								receivedAt: raw.receivedAt,
								clockEpoch: raw.clockEpoch,
							}
						: {}),
					t: journal.startedAtMs + offset,
					timingSource: "Cap elapsed clock; excludes pauses",
				});
			} catch {
				malformed++;
			}
		}
	} catch {
		malformed++;
	}
	events.sort((a, b) => a.t - b.t);
	const partial =
		metadata.state !== "complete" || malformed > 0 || metadata.dropped > 0;
	const status = partial
		? `partial: ${metadata.reason || "collector completion unconfirmed or evidence omitted"}`
		: "captured from the owned browser window";
	const external = metadata.browserMode === "external";
	return {
		events,
		meetEvents,
		owner: {
			recordingId: metadata.recordingId,
			generation: metadata.generation,
		},
		coverage: {
			dom: external
				? events.some((event) => event.companion?.role === "walkthrough")
					? `${partial ? "partial" : "captured"} selected extension tab; bounded text/clicks; native video target mapping unverified`
					: "not captured: no walkthrough tab evidence was saved"
				: `${status}; semantic clicks and bounded visible context; form values excluded`,
			network: external
				? "not captured: external extension tab has no network collector"
				: `${status}; request metadata and redacted failed responses; no server-side query trace`,
			console: external
				? "not captured: external extension tab has no console collector"
				: `${status}; console warnings/errors and page exceptions`,
			meet: events.some((event) => event.ev === "meet-caption")
				? "Selected Meet caption/name evidence; approximate timing and unconfirmed identity; caption gaps are possible"
				: "not captured: no selected Meet captions were saved",
		},
		preRoll: fs.existsSync(path.join(directory, "browser-preroll.jsonl")),
	};
}

export function projectMeetCaptions(
	events,
	startedAtMs = 0,
	durationMs = Number.MAX_SAFE_INTEGER,
	owner,
) {
	return events.flatMap((raw) => {
		const event = sanitizeBrowserEvent(raw, raw.observedAt);
		if (
			event?.ev !== "meet-caption" ||
			!companionEventMatches(event, owner) ||
			!event.name ||
			!event.text ||
			event.companion?.role !== "meet"
		)
			return [];
		const offset = Number.isSafeInteger(raw.nativeOffsetMs)
			? raw.nativeOffsetMs
			: Number.isSafeInteger(raw.t)
				? raw.t - startedAtMs
				: null;
		if (offset === null) return [];
		const timingUncertain =
			event.timingUncertain || offset < 0 || offset > durationMs;
		return [
			{
				t: startedAtMs + Math.max(0, Math.min(durationMs, offset)),
				kind: "caption",
				name: event.name,
				text: event.text,
				id: `${event.companion.bindingId}:${raw.clockEpoch ?? 0}:${event.captionId}`,
				meeting: event.companion.meeting,
				revision: event.revision,
				localSpeaker: event.localSpeaker,
				timingUncertain,
				observedAt: event.observedAt,
				receivedAt: raw.receivedAt,
				nativeOffsetMs: offset,
				clockEpoch: raw.clockEpoch,
				identity: event.identity,
				timingSource: "Native active clock; caption arrival/lag is approximate",
			},
		];
	});
}
