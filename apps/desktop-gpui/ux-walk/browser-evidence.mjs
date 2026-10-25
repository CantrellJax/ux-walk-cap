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
	coverage: { dom: reason, network: reason, console: reason },
});

function sameFile(first, second) {
	try {
		return fs.realpathSync(first) === fs.realpathSync(second);
	} catch {
		return false;
	}
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
	if (
		metadata.schemaVersion !== 1 ||
		!metadata.captureId ||
		!metadata.windowId ||
		!sameFile(String(metadata.journal || ""), file) ||
		!sameFile(String(metadata.sourceProject || ""), journal.sourceProject) ||
		metadata.startedAtMs !== journal.startedAtMs ||
		!Array.isArray(metadata.anchors)
	)
		return unavailable(
			"unavailable: browser evidence recording identity mismatch",
		);
	const anchors = metadata.anchors;
	let previousWall = -1;
	let previousOffset = -1;
	for (const anchor of anchors) {
		if (
			!Number.isSafeInteger(anchor.wallMs) ||
			!Number.isSafeInteger(anchor.offsetMs) ||
			anchor.wallMs < previousWall ||
			anchor.offsetMs < previousOffset ||
			anchor.offsetMs > journal.durationMs ||
			typeof anchor.paused !== "boolean"
		)
			return unavailable("unavailable: browser evidence clock is invalid");
		previousWall = anchor.wallMs;
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
	let malformed = 0;
	try {
		for (const line of fs
			.readFileSync(path.join(directory, "browser-evidence.jsonl"), "utf8")
			.split("\n")) {
			if (!line.trim()) continue;
			try {
				const raw = JSON.parse(line);
				if (!Number.isSafeInteger(raw.observedAt))
					throw new Error("Invalid observedAt");
				const offset = offsetAt(raw.observedAt);
				if (offset === null) continue;
				const safe = sanitizeBrowserEvent(raw, raw.observedAt);
				if (!safe) continue;
				events.push({
					...safe,
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
	return {
		events,
		coverage: {
			dom: `${status}; semantic clicks and bounded visible context; form values excluded`,
			network: `${status}; request metadata and redacted failed responses; no server-side query trace`,
			console: `${status}; console warnings/errors and page exceptions`,
		},
		preRoll: fs.existsSync(path.join(directory, "browser-preroll.jsonl")),
	};
}
