import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { projectBrowserEvidence } from "./browser-evidence.mjs";
import {
	flushNativeNotes,
	NativeBrowserEvidence,
	OwnedWindowEvents,
	prepareNativePause,
	resumeNativeNotes,
} from "./native-browser.mjs";
import { finishNativeWalk, nativeWalkPrompt } from "./native-walk.mjs";

test("browser entrypoint validates owners through a directory alias while non-file argv imports stay inert", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cap-ux-browser-entry-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const alias = path.join(root, "adapter alias");
	fs.symlinkSync(fileURLToPath(new URL(".", import.meta.url)), alias, "dir");
	const result = spawnSync(
		process.execPath,
		[path.join(alias, "native-browser.mjs"), "invalid", root],
		{ encoding: "utf8", timeout: 5000 },
	);
	assert.equal(result.status, 1, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), {
		ready: false,
		error: "Invalid browser owner",
	});
	const imported = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`process.argv[1] = "not-a-file"; await import(${JSON.stringify(new URL("./native-browser.mjs", import.meta.url).href)}); console.log("imported");`,
		],
		{ encoding: "utf8", timeout: 5000 },
	);
	assert.equal(imported.status, 0, imported.stderr);
	assert.equal(imported.stdout, "imported\n");
	assert.equal(imported.stderr, "");
});

test(
	"owned Chrome captures semantic clicks, stacks, failed API/query diagnostics and pause boundaries through handoff",
	{
		skip: process.env.CAP_UX_BROWSER_SMOKE !== "1",
		timeout: 30000,
	},
	async (t) => {
		const phase = (name) => console.error(`[owned Chrome smoke] ${name}`);
		const diagnostics = [];
		phase("import browser and timeline");
		const { openBrowser } = await import(
			process.env.CAP_UX_TEST_ENGINE_DIR
				? pathToFileURL(
						path.join(process.env.CAP_UX_TEST_ENGINE_DIR, "src/browser.mjs"),
					)
				: "../../../vendor/ux-walk/src/browser.mjs"
		);
		const { buildTimeline, renderTimeline, readActions } = await import(
			"../../../vendor/ux-walk/src/timeline.mjs"
		);
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "cap-ux-browser-smoke-"),
		);
		let browser;
		const server = http.createServer((request, response) => {
			if (request.url.startsWith("/disconnect")) {
				request.socket.destroy();
				return;
			}
			if (request.url.startsWith("/rest/v1/rpc/save")) {
				response.writeHead(400, { "content-type": "application/json" });
				response.end(
					JSON.stringify({
						code: "23514",
						message: "Invalid planning window",
						details: "Dates extend outside the draft",
						hint: "Review Generate dates",
						access_token: "SECRET_SENTINEL",
					}),
				);
				return;
			}
			if (request.url.startsWith("/api/down")) {
				response.writeHead(503);
				response.end("Unavailable");
				return;
			}
			response.writeHead(200, { "content-type": "text/html" });
			response.end(`<!doctype html><title>Synthetic Cap UX</title><button data-testid="save-window">Save window</button><script>
console.error("First-load synthetic error");
document.querySelector("button").onclick = () => {
 console.error("Synthetic console failure");
 fetch("/rest/v1/rpc/save?token=SECRET_SENTINEL", {method:"POST",body:JSON.stringify({password:"SECRET_SENTINEL"})});
 fetch("/api/down");
 fetch("/disconnect").catch(() => {});
 throw new Error("Synthetic uncaught failure");
};</script>`);
		});
		const bounded = async (name, action, timeoutMs) => {
			let timer;
			try {
				return await Promise.race([
					Promise.resolve().then(action),
					new Promise((_, reject) => {
						timer = setTimeout(
							() =>
								reject(new Error(`${name} timed out after ${timeoutMs} ms`)),
							timeoutMs,
						);
					}),
				]);
			} finally {
				clearTimeout(timer);
			}
		};
		t.after(
			async () => {
				const errors = [];
				if (browser) {
					phase("cleanup: close owned Chrome");
					let ownedPid;
					try {
						ownedPid = browser.chromePid();
						await bounded("browser.close", () => browser.close(), 5000);
					} catch (error) {
						console.error(error);
						errors.push(error);
						try {
							if (ownedPid && browser.chromePid() === ownedPid) {
								phase(`cleanup: terminate owned Chrome child ${ownedPid}`);
								process.kill(ownedPid, "SIGKILL");
							}
						} catch (error) {
							console.error(error);
							errors.push(error);
						}
					}
				}
				phase("cleanup: close synthetic HTTP connections");
				try {
					await bounded(
						"server.close",
						() =>
							new Promise((resolve, reject) => {
								server.close((error) =>
									error && error.code !== "ERR_SERVER_NOT_RUNNING"
										? reject(error)
										: resolve(),
								);
								server.closeAllConnections();
							}),
						2000,
					);
				} catch (error) {
					console.error(error);
					errors.push(error);
				} finally {
					phase("cleanup: remove synthetic files");
					fs.rmSync(root, { recursive: true, force: true });
				}
				phase("cleanup complete");
				if (errors.length)
					throw new AggregateError(errors, "Owned Chrome smoke cleanup failed");
			},
			{ timeout: 10000 },
		);
		phase("listen on synthetic HTTP server");
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		const url = `http://127.0.0.1:${server.address().port}`;
		const evidence = new NativeBrowserEvidence(
			"synthetic-browser",
			path.join(root, "prepared"),
		);
		const windowEvents = new OwnedWindowEvents(evidence);
		phase("launch owned Chrome");
		browser = await openBrowser({
			url,
			authFile: path.join(root, "auth.json"),
			windowSize: "960,720",
			trace: false,
			ignoreWrites: "$^",
			write: (event, page) => {
				if (event.ev === "note")
					diagnostics.push({
						phase: "ordinary note",
						id: event.id,
						chars: event.text?.length ?? 0,
						paused: evidence.active?.metadata.anchors.at(-1)?.paused,
					});
				return windowEvents.write(event, page);
			},
			notesDir: () => evidence.notesDir(),
			canCapturePage: (page, operation) => {
				if (operation?.op === "draft")
					diagnostics.push({
						phase: "draft ingress",
						host: operation.receivedAt,
						epoch: evidence.clockEpoch,
						paused: evidence.active?.metadata.anchors.at(-1)?.paused,
					});
				return windowEvents.canCapturePage(page, operation);
			},
		});
		phase("owned Chrome ready");
		const source = path.join(root, "source.cap");
		const directory = path.join(root, "walk");
		fs.mkdirSync(source);
		fs.mkdirSync(directory);
		fs.writeFileSync(
			path.join(source, "recording-meta.json"),
			JSON.stringify({ status: { status: "Complete" } }),
		);
		fs.writeFileSync(path.join(source, "source.mp4"), "synthetic media");
		const startedAtMs = Date.now();
		const journal = {
			schemaVersion: 1,
			state: "recording",
			startedAtMs,
			durationMs: null,
			sourceProject: source,
			request: {
				directory,
				topic: "Synthetic browser evidence",
				url,
				speakers: [],
			},
			events: [],
		};
		const file = path.join(directory, "native-walk.json");
		fs.writeFileSync(file, JSON.stringify(journal));
		evidence.windowId = "17";
		evidence.start(file, "17");
		phase("record synthetic click and diagnostics");
		const page = browser.context.pages()[0];
		await page.getByRole("button", { name: "Save window" }).click();
		const deadline = Date.now() + 8000;
		let captured = [];
		do {
			await new Promise((resolve) => setTimeout(resolve, 25));
			captured = fs
				.readFileSync(path.join(directory, "browser-evidence.jsonl"), "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map(JSON.parse);
			if (
				captured.some((event) => event.resBody?.includes("23514")) &&
				captured.some((event) => event.ev === "network" && event.failure) &&
				captured.some((event) => event.ev === "http" && event.status === 503) &&
				captured.some((event) => event.ev === "pageerror") &&
				captured.some((event) => event.ev === "click")
			)
				break;
		} while (Date.now() < deadline);
		phase(`assert captured diagnostics (${captured.length} events)`);
		assert.ok(
			captured.some(
				(event) => event.ev === "click" && event.el.testid === "save-window",
			),
		);
		assert.ok(
			captured.some(
				(event) =>
					event.ev === "pageerror" &&
					event.text.includes("Synthetic uncaught failure"),
			),
		);
		assert.ok(
			captured.some(
				(event) =>
					event.ev === "write" &&
					event.status === 400 &&
					event.resBody.includes("Review Generate dates"),
			),
		);
		assert.ok(
			captured.some((event) => event.ev === "http" && event.status === 503),
		);
		assert.ok(
			captured.some((event) => event.ev === "network" && event.failure),
		);
		phase("verify same-window tab and excluded popup");
		const sameTab = browser.context.waitForEvent("page");
		await page.evaluate((url) => {
			window.open(url, "_blank");
		}, `${url}/same-tab`);
		const same = await sameTab;
		await same.waitForLoadState("load");
		assert.ok(
			await windowEvents.accepts(same),
			"tabs in the captured Chrome window stay observable",
		);
		await same.evaluate(() => console.error("SAME_WINDOW_TAB_SENTINEL"));
		const popupTab = browser.context.waitForEvent("page");
		await page.evaluate((url) => {
			window.open(url, "auth-popup", "popup=yes,width=500,height=400");
		}, `${url}/popup`);
		const popup = await popupTab;
		await popup.waitForLoadState("load");
		assert.equal(
			await windowEvents.accepts(popup),
			false,
			"another Chrome window is outside the capture target",
		);
		await popup.evaluate(() => console.error("SEPARATE_WINDOW_SENTINEL"));
		const refusal = await popup.evaluate(() =>
			window.__uxwNote({ op: "new", box: { x: 0, y: 0, w: 20, h: 20 } }).then(
				() => "unexpected success",
				(error) => error.message,
			),
		);
		assert.match(refusal, /outside the recorded browser window/);
		await windowEvents.flush();
		phase("save annotation and verify pause boundaries");
		const noteId = await same.evaluate(async () => {
			const id = await window.__uxwNote({
				op: "new",
				box: { x: 0, y: 0, w: 20, h: 20 },
			});
			await window.__uxwNote({ op: "save", id, text: "Browser annotation" });
			return id;
		});
		const noteFiles = () =>
			fs
				.readdirSync(evidence.notesDir())
				.map((name) => [
					name,
					fs.readFileSync(path.join(evidence.notesDir(), name)).toString("hex"),
				]);
		const beforePauseFiles = noteFiles();
		await prepareNativePause(browser, evidence, windowEvents);
		const pausedAt = Date.now();
		evidence.anchor(file, pausedAt, pausedAt - startedAtMs, true);
		await page.evaluate(() => console.error("PAUSED_PRIVATE_SENTINEL"));
		for (const op of ["new", "save", "reshoot", "drop"]) {
			const pausedNote = await same.evaluate(
				({ op, id }) =>
					window
						.__uxwNote({
							op,
							id,
							edit: true,
							text: "PAUSED_EDIT_SENTINEL",
							box: { x: 10, y: 10, w: 40, h: 40 },
						})
						.then(
							() => "unexpected success",
							(error) => error.message,
						),
				{ op, id: noteId },
			);
			assert.match(pausedNote, /outside the recorded browser window/);
		}
		assert.deepEqual(noteFiles(), beforePauseFiles);
		await new Promise((resolve) => setTimeout(resolve, 40));
		const resumedAt = Date.now();
		evidence.anchor(file, resumedAt, pausedAt - startedAtMs, false);
		await resumeNativeNotes(browser, evidence, windowEvents);
		await page.evaluate(() => console.warn("Resumed synthetic warning"));
		await new Promise((resolve) => setTimeout(resolve, 40));
		phase("flush unsaved annotation at Stop");
		await same.bringToFront();
		await same
			.getByRole("button", { name: "Save window" })
			.click({ modifiers: ["Alt", "Shift"] });
		await same.waitForFunction(() =>
			Number.isInteger(window.__uxwOpenNote?.()?.id),
		);
		await same.locator("uxw-overlay input").fill("Unsaved note before Stop");
		await prepareNativePause(browser, evidence, windowEvents);
		const stoppedAt = Date.now();
		diagnostics.push({
			phase: "Stop boundary",
			host: stoppedAt,
			epoch: evidence.clockEpoch,
		});
		journal.durationMs = stoppedAt - startedAtMs - (resumedAt - pausedAt);
		evidence.anchor(file, stoppedAt, journal.durationMs, true);
		await flushNativeNotes(browser, evidence, windowEvents, stoppedAt);
		await windowEvents.flush();
		diagnostics.push({
			phase: "raw notes",
			notes: fs
				.readFileSync(path.join(directory, "browser-evidence.jsonl"), "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map(JSON.parse)
				.filter((event) => event.ev === "note")
				.map((event) => ({
					id: event.id,
					chars: event.text?.length ?? 0,
					observedAt: event.observedAt,
					receivedAt: event.receivedAt,
				})),
		});
		phase(`post-Stop diagnostics ${JSON.stringify(diagnostics)}`);
		evidence.finish(file);
		const stoppedNote = await same.evaluate(() =>
			window.__uxwNote({ op: "new", box: { x: 0, y: 0, w: 20, h: 20 } }).then(
				() => "unexpected success",
				(error) => error.message,
			),
		);
		assert.match(stoppedNote, /outside the recorded browser window/);
		journal.state = "complete";
		journal.events.push({
			kind: "note",
			text: "Investigate failed save",
			offsetMs: 1,
		});
		fs.writeFileSync(file, JSON.stringify(journal));
		assert.ok(projectBrowserEvidence(file, journal).events.length > 5);
		phase("finish native handoff and render synthetic report");
		await finishNativeWalk(
			file,
			{ transcriber: "none", brief: false },
			{
				client: {
					export: async (_project, output) => {
						fs.writeFileSync(output, "synthetic export");
						return { durationS: journal.durationMs / 1000 };
					},
				},
				clip: async (_video, output) =>
					fs.writeFileSync(output, "synthetic chapter"),
				processChapter: async (chapterDir) => {
					const chapter = JSON.parse(
						fs.readFileSync(path.join(chapterDir, "chapter.json")),
					);
					const actions = readActions(
						path.join(directory, "actions.jsonl"),
						chapter.startMs,
						chapter.endMs,
					);
					const rows = buildTimeline({
						actions,
						startMs: chapter.startMs,
						cues: [],
						appOrigin: url,
						ignoreWrites: "$^",
						ignoreConsole: "$^",
					});
					for (const short of [true, false]) {
						fs.writeFileSync(
							path.join(
								chapterDir,
								short ? "timeline-short.md" : "timeline.md",
							),
							renderTimeline(rows, {
								title: "Synthetic",
								startMs: chapter.startMs,
								short,
							}).text,
						);
					}
					return {};
				},
				writeIndex: () => {},
			},
		);
		phase("assert report evidence and privacy boundaries");
		for (const artifact of [
			"actions.jsonl",
			"01-walkthrough/timeline.md",
			"report.html",
			"agent-prompt.txt",
		]) {
			const text = fs.readFileSync(path.join(directory, artifact), "utf8");
			assert.match(text, /23514/, artifact);
			assert.match(text, /Review Generate dates/, artifact);
			assert.equal(text.includes("SECRET_SENTINEL"), false, artifact);
			assert.equal(text.includes("PAUSED_PRIVATE_SENTINEL"), false, artifact);
			assert.equal(text.includes("PAUSED_EDIT_SENTINEL"), false, artifact);
			assert.equal(text.includes("SEPARATE_WINDOW_SENTINEL"), false, artifact);
		}
		assert.match(
			fs.readFileSync(path.join(directory, "actions.jsonl"), "utf8"),
			/SAME_WINDOW_TAB_SENTINEL/,
		);
		assert.match(
			fs.readFileSync(path.join(directory, "report.html"), "utf8"),
			/Unsaved note before Stop/,
		);
		assert.match(nativeWalkPrompt(file), /no server-side query trace/);
		assert.match(nativeWalkPrompt(file), /browser-preroll/);
		phase("all smoke assertions passed");
	},
);

test(
	"owned helper finishing schedules its draft drain and Stop awaits one durable note",
	{ timeout: 10000 },
	async (t) => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "cap-ux-finish-draft-"));
		const captureId = randomUUID(),
			work = path.join(root, "walk-browser", captureId),
			directory = path.join(root, "walk"),
			source = path.join(root, "source.cap"),
			engine = path.join(root, "engine"),
			config = path.join(root, "config");
		for (const folder of [
			work,
			directory,
			source,
			path.join(engine, "src"),
			config,
		])
			fs.mkdirSync(folder, { recursive: true });
		const original =
			process.env.CAP_UX_TEST_ENGINE_DIR ||
			fileURLToPath(new URL("../../../vendor/ux-walk", import.meta.url));
		for (const name of fs.readdirSync(path.join(original, "src")))
			if (name !== "browser.mjs")
				fs.symlinkSync(
					path.join(original, "src", name),
					path.join(engine, "src", name),
				);
		const entered = path.join(root, "drain-entered"),
			release = path.join(root, "drain-release"),
			prefixEntered = path.join(root, "prefix-entered"),
			prefixRelease = path.join(root, "prefix-release");
		const file = path.join(directory, "native-walk.json"),
			startedAtMs = Date.now() - 5000;
		fs.writeFileSync(
			file,
			JSON.stringify({
				schemaVersion: 1,
				state: "recording",
				startedAtMs,
				sourceProject: source,
				request: { directory, topic: "Owned Stop draft", speakers: [] },
				events: [],
				durationMs: null,
			}),
		);
		fs.writeFileSync(
			path.join(engine, "src/browser.mjs"),
			`import fs from "node:fs";
export async function openBrowser(options) {
 let saved=false;
 const context={pages:()=>[page],newCDPSession:async()=>({send:async()=>({windowId:17})})};
 const page={context:()=>context};
 await options.write({ev:"nav",url:"https://example.com"},page);
 return {context,browser:{once(){}},saveAuth:async()=>{},close:async()=>{},async prepareNotePause({allowPage}) {
 fs.writeFileSync(${JSON.stringify(prefixEntered)},"entered");
 while(!fs.existsSync(${JSON.stringify(prefixRelease)})) await new Promise(resolve=>setTimeout(resolve,10));
 if(!await allowPage(page)) throw new Error("Prefix owner changed");
},resumeNoteInput:async()=>{},async flushPendingNotes({allowPage,writeNote}) {
  fs.writeFileSync(${JSON.stringify(entered)},"entered");
  while(!fs.existsSync(${JSON.stringify(release)})) await new Promise(resolve=>setTimeout(resolve,10));
  if(!saved && await allowPage(page)) {
   saved=true;
   await writeNote({ev:"note",id:1,t:${startedAtMs + 500},text:"Accepted draft at real finishing",shot:"notes/01.png"},page);
  }
 }};
}`,
		);
		const child = spawn(
			process.execPath,
			[
				fileURLToPath(new URL("./native-browser.mjs", import.meta.url)),
				captureId,
				work,
			],
			{
				env: {
					...process.env,
					CAP_UX_TEST_ENGINE_DIR: engine,
					CAP_UX_WALK_CONFIG_DIR: config,
				},
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		t.after(() => {
			child.kill("SIGKILL");
			fs.rmSync(root, { recursive: true, force: true });
		});
		let stderr = "",
			readyResolve,
			readyReject;
		child.stderr.on("data", (data) => {
			stderr += data;
		});
		const ready = new Promise((resolve, reject) => {
			readyResolve = resolve;
			readyReject = reject;
		});
		const pending = new Map();
		child.once("exit", (code) => {
			if (code) {
				const error = new Error(stderr || `helper exited ${code}`);
				readyReject(error);
				for (const waiter of pending.values()) waiter.reject(error);
			}
		});
		readline.createInterface({ input: child.stdout }).on("line", (line) => {
			const result = JSON.parse(line);
			if (result.ready !== undefined)
				return result.ready
					? readyResolve(result)
					: readyReject(new Error(result.error));
			const waiter = pending.get(result.id);
			pending.delete(result.id);
			if (result.ok) waiter?.resolve(result);
			else waiter?.reject(new Error(result.error));
		});
		const command = (op, more = {}) =>
			new Promise((resolve, reject) => {
				const id = randomUUID();
				pending.set(id, { resolve, reject });
				child.stdin.write(
					`${JSON.stringify({ op, id, captureId, ...more })}\n`,
				);
			});
		await ready;
		await command("bind", { windowId: "17" });
		await command("start", { file, windowId: "17" });
		let prefixAcked = false;
		const preparing = command("prepare-pause", { file }).then(() => {
			prefixAcked = true;
		});
		const prefixDeadline = Date.now() + 1500;
		while (!fs.existsSync(prefixEntered) && Date.now() < prefixDeadline)
			await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(
			fs.existsSync(prefixEntered),
			true,
			"owned preflight must start the source prefix fence",
		);
		assert.equal(prefixAcked, false);
		const live = JSON.parse(
			fs.readFileSync(path.join(directory, "browser-evidence.json"), "utf8"),
		);
		assert.equal(live.state, "recording");
		assert.equal(live.anchors.at(-1).paused, false);
		fs.writeFileSync(prefixRelease, "ACK");
		await preparing;
		await command("finishing", {
			file,
			wallMs: startedAtMs + 2000,
			offsetMs: 2000,
		});
		const deadline = Date.now() + 1500;
		while (!fs.existsSync(entered) && Date.now() < deadline)
			await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(
			fs.existsSync(entered),
			true,
			"finishing must schedule the owned draft drain",
		);
		await command("finishing", {
			file,
			wallMs: startedAtMs + 2100,
			offsetMs: 2000,
		});
		let stopped = false;
		const stop = command("stop", { file }).then(() => {
			stopped = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(stopped, false, "Stop must await the existing pending drain");
		fs.writeFileSync(release, "release");
		await stop;
		const raw = fs
			.readFileSync(path.join(directory, "browser-evidence.jsonl"), "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(JSON.parse);
		assert.equal(
			raw.length,
			1,
			"duplicate finishing anchors must not duplicate the accepted note",
		);
		assert.equal(raw[0].text, "Accepted draft at real finishing");
		assert.equal(raw[0].observedAt, startedAtMs + 500);
		assert.equal(raw[0].nativeOffsetMs, 500);
		assert.equal(
			JSON.parse(
				fs.readFileSync(path.join(directory, "browser-evidence.json"), "utf8"),
			).state,
			"complete",
		);
		await command("close");
		child.stdin.end();
	},
);
