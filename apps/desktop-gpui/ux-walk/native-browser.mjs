import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	redactBrowserText,
	sanitizeBrowserEvent,
} from "./browser-evidence.mjs";
import { durableJson } from "./checkpoint-store.mjs";

const local = new URL("./src/config.mjs", import.meta.url);
const engine = process.env.CAP_UX_TEST_ENGINE_DIR
	? pathToFileURL(`${path.resolve(process.env.CAP_UX_TEST_ENGINE_DIR)}/src/`)
	: fs.existsSync(local)
		? new URL("./src/", import.meta.url)
		: new URL("../../../vendor/ux-walk/src/", import.meta.url);
const { CompanionSession, startCompanionServer } = await import(
	new URL("companion.mjs", engine)
);

function save(file, value) {
	durableJson(file, value);
}

const recent = (timestamp, now) =>
	Number.isSafeInteger(timestamp) &&
	timestamp >= 0 &&
	now - timestamp >= -1000 &&
	now - timestamp <= 15000;
function readOptional(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}
function audioBackupState(status, expected) {
	const kinds = ["microphone", "systemAudio"];
	if (!expected || kinds.some((kind) => typeof expected[kind] !== "boolean"))
		return "unconfirmed";
	if (
		!status.sources ||
		typeof status.sources !== "object" ||
		Array.isArray(status.sources) ||
		!Array.isArray(status.waitingSources) ||
		!status.sourceErrors ||
		typeof status.sourceErrors !== "object" ||
		Array.isArray(status.sourceErrors)
	)
		return "unconfirmed";
	const selected = kinds.filter((kind) => expected[kind]);
	if (!selected.length) return "not-selected";
	for (const kind of selected) {
		const sources = Object.entries(status.sources ?? {}).filter(([source]) =>
			source.endsWith(`:${kind}`),
		);
		if (
			Object.keys(status.sourceErrors ?? {}).some((source) =>
				source.endsWith(`:${kind}`),
			) ||
			sources.some(([, source]) => source?.unsupported)
		)
			return "attention";
		if (!sources.length || status.waitingSources?.includes(kind))
			return "waiting";
		for (const [, source] of sources) {
			if (
				![source?.durableSourceMs, source?.remoteSourceMs].every(
					(value) => Number.isFinite(value) && value >= 0,
				) ||
				source.remoteSourceMs > source.durableSourceMs
			)
				return "unconfirmed";
			if (
				source.durableSourceMs === 0 ||
				source.remoteSourceMs < source.durableSourceMs
			)
				return "waiting";
		}
	}
	return "current";
}

function captureStatus(directory, now) {
	const heartbeat = readOptional(
		path.join(directory, "checkpoint-heartbeat.json"),
	);
	const validHeartbeat =
		heartbeat?.schemaVersion === 1 &&
		heartbeat.parentPid === process.ppid &&
		recent(heartbeat.wallMs, now);
	const selected = validHeartbeat ? heartbeat.expectedAudio : null;
	const choice = (kind) =>
		typeof selected?.[kind] === "boolean"
			? selected[kind]
				? "on"
				: "off"
			: "unconfirmed";
	const audio = {
		microphone: choice("microphone"),
		systemAudio: choice("systemAudio"),
		updatedAt: validHeartbeat ? heartbeat.wallMs : undefined,
		scope:
			"All computer audio, separately from microphone; meeting video is off",
	};
	const status = readOptional(path.join(directory, "checkpoint-status.json"));
	const identity = readOptional(
		path.join(directory, "checkpoints/identity.json"),
	);
	const backup = { eventState: "unconfirmed", audioState: "unconfirmed" };
	if (
		status?.schemaVersion !== 1 ||
		!identity ||
		typeof identity.recordingId !== "string" ||
		!identity.recordingId ||
		typeof identity.generation !== "string" ||
		!identity.generation ||
		status.recordingId !== identity.recordingId ||
		status.generation !== identity.generation ||
		typeof status.backupEnabled !== "boolean" ||
		!recent(status.updatedAt, now)
	)
		return { audio, backup };
	Object.assign(backup, {
		enabled: status.backupEnabled,
		updatedAt: status.updatedAt,
		needsAttention: !!status.error,
	});
	if (!status.backupEnabled) return { audio, backup };
	if (
		Number.isSafeInteger(status.remoteClockThroughMs) &&
		status.remoteClockThroughMs > 0
	)
		backup.journalThroughMs = status.remoteClockThroughMs;
	const events = status.events;
	if (
		events &&
		[events.readableBytes, events.durableBytes, events.remoteBytes].every(
			(value) => Number.isSafeInteger(value) && value >= 0,
		) &&
		events.remoteBytes <= events.durableBytes &&
		events.durableBytes <= events.readableBytes
	)
		backup.eventState =
			events.readableBytes === 0
				? "none"
				: events.remoteBytes === events.readableBytes
					? "current"
					: "waiting";
	backup.audioState = audioBackupState(status, selected);
	return { audio, backup };
}

export class NativeBrowserEvidence {
	constructor(captureId, workDir, clock = Date.now) {
		this.captureId = captureId;
		this.workDir = workDir;
		this.clock = clock;
		this.monotonic = clock === Date.now ? () => performance.now() : clock;
		this.anchorMonotonic = this.monotonic();
		this.clockEpoch = 0;
		this.windowId = null;
		this.mode = "prepared";
		this.preRoll = [];
		this.preRollBytes = 0;
		this.bytes = 0;
		this.active = null;
		this.flushTimer = setInterval(() => {
			try {
				this.flush();
			} catch (error) {
				if (this.active)
					this.active.metadata.durabilityError = String(error.message).slice(
						0,
						200,
					);
			}
		}, 1000);
		this.flushTimer.unref();
		fs.mkdirSync(path.join(workDir, "notes"), { recursive: true, mode: 0o700 });
	}

	notesDir() {
		return path.join(this.active?.directory ?? this.workDir, "notes");
	}

	write(raw, receivedAt = this.clock(), companion = false) {
		if (
			!["prepared", "recording"].includes(this.mode) ||
			(!companion &&
				(raw?.source === "chrome-extension" ||
					String(raw?.ev).startsWith("meet-")))
		)
			return false;
		const event = sanitizeBrowserEvent(raw, receivedAt);
		if (!event) return false;
		if (this.mode === "prepared") {
			const line = `${JSON.stringify(event)}\n`;
			this.preRoll.push(line);
			this.preRollBytes += Buffer.byteLength(line);
			while (this.preRollBytes > 2 * 1024 * 1024)
				this.preRollBytes -= Buffer.byteLength(this.preRoll.shift());
			return false;
		}
		const latest = this.active.metadata.anchors.at(-1);
		if (latest.paused || this.active.metadata.state !== "recording")
			return false;
		if (
			companion &&
			this.active.metadata.browserMode !== "external" &&
			event.companion.role === "walkthrough" &&
			event.ev === "click"
		)
			return false;
		event.nativeOffsetMs = Math.round(
			Math.max(
				latest.offsetMs,
				latest.offsetMs +
					this.monotonic() -
					this.anchorMonotonic -
					(event.timingUncertain
						? 0
						: Math.max(0, Math.min(30000, receivedAt - event.observedAt))),
			),
		);
		event.receivedAt = receivedAt;
		event.clockEpoch = this.clockEpoch;
		const line = `${JSON.stringify(event)}\n`;
		if (event.observedAt < this.active.metadata.startedAtMs && !companion) {
			const file = path.join(this.active.directory, "browser-preroll.jsonl");
			if (fs.statSync(file).size + Buffer.byteLength(line) <= 2 * 1024 * 1024)
				fs.appendFileSync(file, line, { mode: 0o600 });
			else this.active.metadata.dropped++;
			return false;
		}
		const anchor = this.active.metadata.anchors.findLast(
			(entry) => entry.wallMs <= event.observedAt,
		);
		if ((!anchor || anchor.paused) && !companion) return false;
		if (this.bytes + Buffer.byteLength(line) > 100 * 1024 * 1024) {
			this.active.metadata.dropped++;
			return false;
		}
		this.bytes += Buffer.byteLength(line);
		fs.appendFileSync(
			path.join(this.active.directory, "browser-evidence.jsonl"),
			line,
			{ mode: 0o600 },
		);
		return true;
	}

	start(file, windowId, { mode = "owned" } = {}) {
		if (this.active || !this.windowId || windowId !== this.windowId)
			throw new Error("Browser window does not match the recording target");
		const journal = JSON.parse(fs.readFileSync(file, "utf8"));
		const directory = path.dirname(fs.realpathSync(file));
		if (
			journal.schemaVersion !== 1 ||
			journal.state !== "recording" ||
			fs.realpathSync(journal.request.directory) !== directory ||
			!path.isAbsolute(journal.sourceProject) ||
			!Number.isSafeInteger(journal.startedAtMs)
		)
			throw new Error("Browser collector requires its active native journal");
		if (fs.existsSync(path.join(directory, "browser-evidence.json")))
			throw new Error("This walk already has a browser collector");
		const metadata = {
			schemaVersion: 1,
			captureId: this.captureId,
			recordingId: randomUUID(),
			generation: randomUUID(),
			journal: fs.realpathSync(file),
			sourceProject: fs.realpathSync(journal.sourceProject),
			windowId,
			browserMode: mode,
			state: "recording",
			startedAtMs: journal.startedAtMs,
			dropped: 0,
			anchors: [{ wallMs: journal.startedAtMs, offsetMs: 0, paused: false }],
		};
		fs.mkdirSync(path.join(directory, "notes"), {
			recursive: true,
			mode: 0o700,
		});
		for (const name of fs.readdirSync(path.join(this.workDir, "notes"))) {
			if (/^[\w-]+\.png$/.test(name))
				fs.copyFileSync(
					path.join(this.workDir, "notes", name),
					path.join(directory, "notes", name),
				);
		}
		fs.writeFileSync(
			path.join(directory, "browser-preroll.jsonl"),
			this.preRoll.join(""),
			{ mode: 0o600 },
		);
		fs.writeFileSync(path.join(directory, "browser-evidence.jsonl"), "", {
			mode: 0o600,
			flag: "wx",
		});
		this.active = { directory, metadata };
		this.bytes = 0;
		this.preRoll = [];
		this.preRollBytes = 0;
		this.mode = "recording";
		this.anchorMonotonic = this.monotonic();
		this.clockEpoch = 0;
		this.save();
		return metadata;
	}

	companion() {
		if (!this.active) throw new Error("Native recording has not started");
		const { metadata, directory } = this.active;
		metadata.companion ??= {};
		return new CompanionSession({
			recordingId: metadata.recordingId,
			generation: metadata.generation,
			backend: "cap",
			mode: metadata.browserMode,
			metadata: metadata.companion,
			clock: this.clock,
			epoch: () => this.clockEpoch,
			state: () =>
				!this.active ||
				this.mode !== "recording" ||
				metadata.state !== "recording"
					? "finishing"
					: metadata.anchors.at(-1).paused
						? "paused"
						: "recording",
			write: async (event) => this.write(event, this.clock(), true),
			flush: async () => this.flush(),
			persist: async () => this.save(),
			details: () => captureStatus(directory, this.clock()),
		});
	}

	owned(file) {
		let actual;
		try {
			actual = fs.realpathSync(file);
		} catch {}
		if (!this.active || this.active.metadata.journal !== actual)
			throw new Error("Browser collector belongs to another walk");
		return this.active;
	}

	anchor(file, wallMs, offsetMs, paused) {
		const { metadata } = this.owned(file);
		const previous = metadata.anchors.at(-1);
		if (
			!Number.isSafeInteger(wallMs) ||
			!Number.isSafeInteger(offsetMs) ||
			wallMs < 0 ||
			offsetMs < previous.offsetMs ||
			typeof paused !== "boolean"
		)
			throw new Error("Invalid native recording clock anchor");
		metadata.anchors.push({ wallMs, offsetMs, paused });
		if (paused !== previous.paused) this.clockEpoch++;
		this.anchorMonotonic = this.monotonic();
		this.save();
	}

	save() {
		if (this.active)
			save(
				path.join(this.active.directory, "browser-evidence.json"),
				this.active.metadata,
			);
	}

	flush() {
		if (!this.active) return;
		const fd = fs.openSync(
			path.join(this.active.directory, "browser-evidence.jsonl"),
			"r",
		);
		try {
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		this.save();
	}

	finish(file, state = "complete", reason) {
		const { metadata, directory } = this.owned(file);
		metadata.state = state;
		if (reason) metadata.reason = redactBrowserText(reason, 500);
		const fd = fs.openSync(path.join(directory, "browser-evidence.jsonl"), "r");
		try {
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		this.save();
		this.active = null;
		this.mode = "stopped";
	}
}

export class OwnedWindowEvents {
	constructor(evidence) {
		this.evidence = evidence;
		this.sessions = new WeakMap();
		this.pending = new Set();
		this.initial = null;
	}

	async windowId(page) {
		let session = this.sessions.get(page);
		if (!session) {
			session = page.context().newCDPSession(page);
			this.sessions.set(page, session);
		}
		return (await (await session).send("Browser.getWindowForTarget")).windowId;
	}

	async accepts(page) {
		if (!page) return false;
		this.initial ??= this.windowId(page.context().pages()[0] ?? page);
		return (await this.initial) === (await this.windowId(page));
	}

	canCapturePage(page) {
		return (
			this.evidence.mode === "recording" &&
			!this.evidence.active?.metadata.anchors.at(-1)?.paused &&
			this.accepts(page)
		);
	}

	write(event, page) {
		if (this.pending.size >= 512) {
			if (this.evidence.active) this.evidence.active.metadata.dropped++;
			return Promise.resolve();
		}
		const receivedAt = Date.now();
		const task = this.accepts(page)
			.then((accepted) => {
				if (accepted) this.evidence.write(event, receivedAt);
			})
			.catch(() => {
				if (this.evidence.active) {
					this.evidence.active.metadata.reason =
						"Some browser events could not be matched to the recorded window";
					this.evidence.active.metadata.dropped++;
				}
			});
		this.pending.add(task);
		task.finally(() => this.pending.delete(task));
		return task;
	}

	async flush() {
		while (this.pending.size) await Promise.all([...this.pending]);
	}
}

export async function flushNativeNotes(browser, evidence, events, throughMs) {
	await browser.flushPendingNotes({
		fromMs: evidence.active.metadata.startedAtMs,
		throughMs,
		allowPage: (page) => events.accepts(page),
	});
	await events.flush();
}

export async function runNativeBrowser(captureId, workDir, external = false) {
	if (
		!/^[a-f\d-]{36}$/i.test(captureId) ||
		!path.isAbsolute(workDir) ||
		path.basename(workDir) !== captureId ||
		path.basename(path.dirname(workDir)) !== "walk-browser"
	)
		throw new Error("Invalid browser owner");
	const { loadConfig, CONFIG_DIR } = await import(
		new URL("config.mjs", engine)
	);
	const openBrowser = external
		? null
		: (await import(new URL("browser.mjs", engine))).openBrowser;
	const cfg = loadConfig();
	const evidence = new NativeBrowserEvidence(captureId, workDir);
	const events = new OwnedWindowEvents(evidence);
	const marker = `Cap UX walk ${captureId}`;
	const bootstrap = http.createServer((request, response) => {
		if (request.url !== `/walk/${captureId}`) {
			response.writeHead(404);
			response.end();
			return;
		}
		response.writeHead(200, {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
		});
		response.end(
			`<!doctype html><title>${marker}</title><body style="font:18px system-ui;padding:48px">Opening your UX Walk…`,
		);
	});
	if (!external)
		await new Promise((resolve) => bootstrap.listen(0, "127.0.0.1", resolve));
	const browser = external
		? {
				saveAuth: async () => {},
				close: async () => {},
				browser: { once: () => {} },
			}
		: await openBrowser({
				url: `http://127.0.0.1:${bootstrap.address().port}/walk/${captureId}`,
				metadataOnly: false,
				authFile: cfg.authFile,
				windowSize: cfg.windowSize,
				trace: false,
				ignoreWrites: cfg.ignoreWrites,
				write: (event, page) => events.write(event, page),
				notesDir: () => evidence.notesDir(),
				contextSelectors: cfg.contextSelectors,
				canCapturePage: (page) => events.canCapturePage(page),
				genericTestids: cfg.genericTestids,
				onCommand: () =>
					"Use Cap UX recording controls for notes, chapters and pause.",
			}).catch((error) => {
				bootstrap.closeAllConnections();
				bootstrap.close();
				throw error;
			});
	const saveAuth = browser.saveAuth.bind(browser);
	browser.saveAuth = () =>
		evidence.active && evidence.mode === "recording"
			? saveAuth()
			: Promise.resolve();
	let closing = false;
	let companionServer = null;
	const close = async () => {
		if (closing) return;
		closing = true;
		evidence.mode = "closing";
		if (companionServer) await companionServer.close();
		clearInterval(evidence.flushTimer);
		try {
			if (evidence.active) {
				await saveAuth();
				evidence.finish(
					evidence.active.metadata.journal,
					"failed",
					"The app or browser collector closed before collection completed",
				);
			}
		} finally {
			try {
				await browser.close();
			} finally {
				bootstrap.closeAllConnections();
				if (bootstrap.listening) bootstrap.close();
				fs.rmSync(workDir, { recursive: true, force: true });
			}
		}
	};
	const reply = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
	const input = readline.createInterface({ input: process.stdin });
	let commands = Promise.resolve();
	let noteFlush = Promise.resolve();
	input.on("line", (line) => {
		commands = commands
			.then(async () => {
				let message;
				try {
					if (line.length > 65536) throw new Error("Browser command too large");
					message = JSON.parse(line);
					if (message.captureId !== captureId)
						throw new Error("Browser owner mismatch");
					switch (message.op) {
						case "bind-external":
							if (!external || evidence.windowId)
								throw new Error(
									"External evidence owner is already bound or unavailable",
								);
							evidence.windowId = message.windowId || "external";
							break;
						case "bind":
							if (evidence.windowId || !/^\d+$/.test(message.windowId))
								throw new Error("Browser window is already bound or invalid");
							evidence.windowId = message.windowId;
							break;
						case "navigate": {
							if (external)
								throw new Error(
									"External evidence collection does not control a browser",
								);
							if (!evidence.windowId)
								throw new Error("Select the browser window before navigation");
							const url = new URL(message.url);
							if (!["http:", "https:"].includes(url.protocol))
								throw new Error("Use an http or https start page");
							await browser.context
								.pages()[0]
								.goto(url.href, {
									waitUntil: "domcontentloaded",
									timeout: 10000,
								})
								.catch((error) =>
									evidence.write({ ev: "pageerror", text: error.message }),
								);
							bootstrap.closeAllConnections();
							bootstrap.close();
							break;
						}
						case "start":
							evidence.start(message.file, message.windowId || "external", {
								mode: external ? "external" : "owned",
							});
							companionServer = await startCompanionServer({
								configDir: CONFIG_DIR,
								session: evidence.companion(),
								recorderPid: process.ppid,
								dispatch: (request) => {
									const result = commands.then(() =>
										evidence.companion().handle(request),
									);
									commands = result.catch(() => {});
									return result;
								},
							});
							break;
						case "finishing":
							evidence.anchor(
								message.file,
								message.wallMs,
								message.offsetMs,
								true,
							);
							evidence.active.metadata.state = "finishing";
							evidence.save();
							break;
						case "clock": {
							const wasPaused = evidence
								.owned(message.file)
								.metadata.anchors.at(-1).paused;
							evidence.anchor(
								message.file,
								message.wallMs,
								message.offsetMs,
								message.paused,
							);
							if (message.paused && !wasPaused && !external) {
								noteFlush = noteFlush
									.then(() =>
										flushNativeNotes(browser, evidence, events, message.wallMs),
									)
									.catch((error) => {
										if (evidence.active) {
											evidence.active.metadata.dropped++;
											evidence.active.metadata.reason = `Open browser note could not be saved: ${redactBrowserText(error.message, 300)}`;
											evidence.save();
										}
									});
							}
							break;
						}
						case "stop":
							evidence.owned(message.file);
							await noteFlush;
							if (!external)
								await new Promise((resolve) => setTimeout(resolve, 3200));
							await events.flush();
							await browser.saveAuth();
							if (companionServer) {
								await companionServer.close();
								companionServer = null;
							}
							evidence.finish(message.file);
							break;
						case "abort":
							if (companionServer) {
								await companionServer.close();
								companionServer = null;
							}
							evidence.finish(
								message.file,
								"failed",
								"Native capture was interrupted",
							);
							break;
						case "close":
							await close();
							input.close();
							break;
						default:
							throw new Error("Unknown browser command");
					}
					reply({ id: message.id, ok: true });
				} catch (error) {
					reply({
						id: message?.id,
						ok: false,
						error: redactBrowserText(error.message, 500),
					});
				}
			})
			.catch(() => {});
	});
	input.on("close", () => {
		commands.finally(close).finally(() => process.exit());
	});
	const parent = process.ppid;
	const guard = setInterval(() => {
		try {
			process.kill(parent, 0);
		} catch {
			input.close();
		}
	}, 1000);
	guard.unref();
	browser.browser.once("disconnected", () => input.close());
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
		process.once(signal, () => input.close());
	await events.flush();
	if (!events.initial && !external) {
		await close();
		throw new Error(
			"The bundled browser engine cannot identify the recorded page",
		);
	}
	reply({ ready: true, captureId, marker });
}

function isMainModule() {
	try {
		return (
			fs.realpathSync(process.argv[1]) ===
			fs.realpathSync(fileURLToPath(import.meta.url))
		);
	} catch {
		return false;
	}
}

if (isMainModule()) {
	runNativeBrowser(
		process.argv[2],
		process.argv[3],
		process.argv[4] === "--external",
	).catch((error) => {
		process.stdout.write(
			`${JSON.stringify({ ready: false, error: redactBrowserText(error.message, 500) })}\n`,
		);
		process.exitCode = 1;
	});
}
