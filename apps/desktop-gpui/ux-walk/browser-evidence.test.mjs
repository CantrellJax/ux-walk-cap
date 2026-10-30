import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	projectBrowserEvidence,
	sanitizeBrowserEvent,
} from "./browser-evidence.mjs";
import {
	flushNativeNotes,
	NativeBrowserEvidence,
	OwnedWindowEvents,
} from "./native-browser.mjs";

function fixture(t) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cap-ux-browser-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const file = path.join(directory, "native-walk.json");
	const journal = {
		request: { directory },
		sourceProject: path.join(directory, "original.cap"),
		startedAtMs: 100000,
		durationMs: 4000,
	};
	fs.writeFileSync(file, JSON.stringify(journal));
	fs.mkdirSync(journal.sourceProject);
	const metadata = {
		schemaVersion: 1,
		captureId: "owned-browser",
		journal: file,
		sourceProject: journal.sourceProject,
		windowId: "17",
		state: "complete",
		startedAtMs: journal.startedAtMs,
		anchors: [
			{ wallMs: 100000, offsetMs: 0, paused: false },
			{ wallMs: 101000, offsetMs: 1000, paused: true },
			{ wallMs: 103000, offsetMs: 1000, paused: false },
			{ wallMs: 106000, offsetMs: 4000, paused: true },
		],
	};
	const save = (events) => {
		fs.writeFileSync(
			path.join(directory, "browser-evidence.json"),
			JSON.stringify(metadata),
		);
		fs.writeFileSync(
			path.join(directory, "browser-evidence.jsonl"),
			events.map((event) => JSON.stringify(event)).join("\n"),
		);
	};
	return { file, journal, metadata, save };
}

test("projects browser errors and element clicks onto the native clock, excluding pauses", (t) => {
	const f = fixture(t);
	f.save([
		{ ev: "click", observedAt: 100500, el: { tag: "button", text: "Save" } },
		{ ev: "console", observedAt: 100800, level: "error", text: "Failed save" },
		{ ev: "click", observedAt: 102000, el: { text: "Paused private action" } },
		{
			ev: "http",
			observedAt: 104000,
			status: 400,
			method: "POST",
			url: "https://example.com/rest/v1/rpc/save",
		},
		{
			ev: "pageerror",
			observedAt: 105000,
			text: "Error: broken\n at save (app.js:20)",
		},
		{ ev: "console", observedAt: 106100, level: "error", text: "After stop" },
	]);
	const result = projectBrowserEvidence(f.file, f.journal);
	assert.deepEqual(
		result.events.map((event) => event.t),
		[100500, 100800, 102000, 103000],
	);
	assert.equal(result.events[0].el.text, "Save");
	assert.match(result.events[3].text, /app.js:20/);
	assert.match(result.coverage.console, /captured/);
	assert.equal(JSON.stringify(result).includes("Paused private action"), false);
});

test("never associates another recording's browser evidence", (t) => {
	const f = fixture(t);
	f.metadata.sourceProject = path.join(path.dirname(f.file), "another.cap");
	f.save([{ ev: "console", observedAt: 100500, text: "Other walk" }]);
	const result = projectBrowserEvidence(f.file, f.journal);
	assert.deepEqual(result.events, []);
	assert.match(result.coverage.console, /unavailable|mismatch/i);
});

test("a dead or unflushed collector keeps partial evidence and its failure visible", (t) => {
	const f = fixture(t);
	f.metadata.state = "recording";
	f.save([
		{ ev: "console", observedAt: 100500, level: "error", text: "Before crash" },
	]);
	const result = projectBrowserEvidence(f.file, f.journal);
	assert.equal(result.events.length, 1);
	assert.match(result.coverage.console, /partial|unconfirmed/i);
});

test("old native walks never claim browser coverage", (t) => {
	const f = fixture(t);
	const result = projectBrowserEvidence(f.file, f.journal);
	assert.deepEqual(result.events, []);
	assert.equal(result.coverage.console, "not captured");
});

test("canonical path aliases preserve browser identity while foreign or missing files fail closed", (t) => {
	const f = fixture(t);
	const alias = `${path.dirname(f.file)}-alias`;
	fs.symlinkSync(path.dirname(f.file), alias, "dir");
	t.after(() => fs.unlinkSync(alias));
	f.metadata.journal = path.join(alias, "native-walk.json");
	f.metadata.sourceProject = path.join(alias, "original.cap");
	f.save([{ ev: "console", observedAt: 100500, text: "Owned error" }]);
	assert.equal(
		projectBrowserEvidence(fs.realpathSync(f.file), f.journal).events.length,
		1,
	);
	f.metadata.journal = path.join(alias, "missing-journal.json");
	f.save([]);
	assert.match(
		projectBrowserEvidence(f.file, f.journal).coverage.console,
		/unavailable/,
	);
	f.metadata.journal = f.file;
	f.save([]);
	fs.rmdirSync(f.journal.sourceProject);
	assert.match(
		projectBrowserEvidence(f.file, f.journal).coverage.console,
		/unavailable/,
	);
});

test("structured errors retain query failure meaning but omit credentials, bodies and form values", () => {
	const event = sanitizeBrowserEvent(
		{
			ev: "write",
			t: 110,
			status: 400,
			method: "POST",
			url: "https://example.com/rest/v1/rpc/save?token=SECRET_SENTINEL#secret",
			reqBody: '{"password":"SECRET_SENTINEL"}',
			headers: { Authorization: "Bearer SECRET_SENTINEL" },
			resBody:
				'{"code":"23514","message":"Invalid window","token":"SECRET_SENTINEL","details":"Constraint conflict"}',
		},
		120,
	);
	assert.equal(event.url, "https://example.com/rest/v1/rpc/save");
	assert.equal(event.reqBody, undefined);
	assert.equal(event.headers, undefined);
	assert.match(event.resBody, /23514/);
	assert.equal(JSON.stringify(event).includes("SECRET_SENTINEL"), false);
	assert.equal(
		sanitizeBrowserEvent({ ev: "change", value: "SECRET_SENTINEL" }, 120),
		null,
	);
	assert.equal(
		sanitizeBrowserEvent({ ev: "key", key: "SECRET_SENTINEL" }, 120),
		null,
	);
});

test("console stacks redact credentials and query values before persistence", () => {
	const event = sanitizeBrowserEvent(
		{
			ev: "pageerror",
			text: "Error token=SECRET_SENTINEL at https://example.com/app.js?key=SECRET_SENTINEL:20:4 Authorization: Bearer SECRET_SENTINEL",
		},
		120,
	);
	assert.equal(JSON.stringify(event).includes("SECRET_SENTINEL"), false);
	assert.match(event.text, /Error/);
});

test("collector binds one journal/window, stops raw logging while paused, and flushes a durable completion", (t) => {
	const f = fixture(t);
	Object.assign(f.journal, { schemaVersion: 1, state: "recording" });
	fs.writeFileSync(f.file, JSON.stringify(f.journal));
	let now = 99900;
	const collector = new NativeBrowserEvidence(
		"owned-browser",
		path.join(path.dirname(f.file), "prepared"),
		() => now,
	);
	collector.windowId = "17";
	collector.write({ ev: "pageerror", text: "First page load failed" });
	assert.throws(() => collector.start(f.file, "another-window"), /match/);
	collector.start(f.file, "17");
	assert.throws(() => collector.start(f.file, "17"), /match/);
	now = 100100;
	collector.write({
		ev: "http",
		t: 99950,
		status: 500,
		url: "https://example.com/first-load",
		resBody: '{"message":"Delayed first-load failure"}',
	});
	now = 100500;
	collector.write({ ev: "click", el: { text: "Save" } });
	collector.anchor(f.file, 101000, 1000, true);
	now = 102000;
	collector.write({
		ev: "console",
		level: "error",
		text: "Paused private content",
	});
	collector.anchor(f.file, 103000, 1000, false);
	now = 104000;
	collector.write({ ev: "console", level: "error", text: "Recorded failure" });
	assert.throws(
		() => collector.anchor(`${f.file}.other`, 104000, 2000, true),
		/another walk/,
	);
	collector.anchor(f.file, 106000, 4000, true);
	collector.finish(f.file);
	now = 106500;
	collector.write({ ev: "console", text: "After stop" });
	const raw = fs.readFileSync(
		path.join(path.dirname(f.file), "browser-evidence.jsonl"),
		"utf8",
	);
	assert.equal(raw.includes("Paused private content"), false);
	assert.equal(raw.includes("After stop"), false);
	assert.equal(
		JSON.parse(
			fs.readFileSync(path.join(path.dirname(f.file), "browser-evidence.json")),
		).state,
		"complete",
	);
	assert.equal(projectBrowserEvidence(f.file, f.journal).events.length, 2);
	assert.match(
		fs.readFileSync(
			path.join(path.dirname(f.file), "browser-preroll.jsonl"),
			"utf8",
		),
		/First page load failed/,
	);
	assert.match(
		fs.readFileSync(
			path.join(path.dirname(f.file), "browser-preroll.jsonl"),
			"utf8",
		),
		/Delayed first-load failure/,
	);
});

test("Stop drains an owned pre-boundary draft into raw evidence and its original active timeline", async (t) => {
	const f = fixture(t);
	Object.assign(f.journal, {
		schemaVersion: 1,
		state: "recording",
		durationMs: 1000,
	});
	fs.writeFileSync(f.file, JSON.stringify(f.journal));
	let now = 100000;
	const evidence = new NativeBrowserEvidence(
		"owned-browser",
		path.join(path.dirname(f.file), "prepared"),
		() => now,
	);
	t.after(() => clearInterval(evidence.flushTimer));
	evidence.windowId = "17";
	evidence.start(f.file, "17");
	const context = {
		pages: () => [page],
		newCDPSession: async () => ({ send: async () => ({ windowId: 17 }) }),
	};
	const page = { context: () => context };
	const events = new OwnedWindowEvents(evidence);
	now = 101000;
	evidence.anchor(f.file, now, 1000, true);
	evidence.active.metadata.state = "finishing";
	now = 101010;
	await flushNativeNotes(
		{
			async flushPendingNotes({ fromMs, throughMs, allowPage, writeNote }) {
				assert.equal(fromMs, 100000);
				assert.equal(throughMs, 101000);
				assert.equal(await allowPage(page), true);
				await writeNote(
					{
						ev: "note",
						id: 7,
						t: 100500,
						text: "Unsaved note before Stop",
						shot: "notes/07.png",
					},
					page,
				);
			},
		},
		evidence,
		events,
		101000,
	);
	evidence.finish(f.file);
	const raw = fs
		.readFileSync(
			path.join(path.dirname(f.file), "browser-evidence.jsonl"),
			"utf8",
		)
		.trim()
		.split("\n")
		.filter(Boolean)
		.map(JSON.parse);
	assert.equal(
		raw.length,
		1,
		"the Stop draft must reach the durable source log",
	);
	assert.equal(raw[0].text, "Unsaved note before Stop");
	assert.equal(raw[0].observedAt, 100500);
	assert.equal(
		raw[0].nativeOffsetMs,
		500,
		"use note creation time, excluding later pause/flush delay",
	);
	Object.assign(f.journal, { state: "complete" });
	const projected = projectBrowserEvidence(f.file, f.journal);
	assert.equal(projected.events.length, 1);
	assert.equal(projected.events[0].t, 100500);
	assert.equal(projected.events[0].text, "Unsaved note before Stop");
});

test("boundary note drains retain ownership and pause fences across asynchronous window checks", async (t) => {
	for (const scenario of [
		"ordinary",
		"foreign",
		"after-boundary",
		"previous-epoch",
		"resume",
		"generation",
		"abort",
		"duplicate-pause",
	]) {
		const f = fixture(t);
		Object.assign(f.journal, { schemaVersion: 1, state: "recording" });
		fs.writeFileSync(f.file, JSON.stringify(f.journal));
		let now = 100000;
		const evidence = new NativeBrowserEvidence(
			"owned-browser",
			path.join(path.dirname(f.file), "prepared"),
			() => now,
		);
		t.after(() => clearInterval(evidence.flushTimer));
		evidence.windowId = "17";
		evidence.start(f.file, "17");
		const context = {
			pages: () => [page],
			newCDPSession: async (candidate) => ({
				send: async () => ({ windowId: candidate.windowId }),
			}),
		};
		const page = { windowId: 17, context: () => context };
		const foreign = { windowId: 88, context: () => context };
		const events = new OwnedWindowEvents(evidence);
		if (scenario === "previous-epoch") {
			evidence.anchor(f.file, 101000, 1000, true);
			evidence.anchor(f.file, 103000, 1000, false);
		}
		const throughMs = scenario === "previous-epoch" ? 104000 : 101000;
		now = throughMs;
		evidence.anchor(f.file, throughMs, 2000, true);
		evidence.active.metadata.state = "finishing";
		now += 10;
		await flushNativeNotes(
			{
				async flushPendingNotes({ allowPage, writeNote }) {
					assert.equal(await allowPage(page), true, scenario);
					const raw = {
						ev: "note",
						id: 1,
						t: scenario === "after-boundary" ? throughMs + 1 : 100500,
						text: "Retain accepted draft",
					};
					if (scenario === "ordinary") {
						assert.equal(
							evidence.write(raw),
							false,
							"unscoped paused note remains refused",
						);
						await events.write(raw, page);
						return;
					}
					const pending = writeNote(
						raw,
						scenario === "foreign" ? foreign : page,
					);
					if (scenario === "resume")
						evidence.anchor(f.file, throughMs + 20, 2000, false);
					if (scenario === "generation")
						evidence.active.metadata.generation = "another-generation";
					if (scenario === "abort") evidence.finish(f.file, "failed");
					if (scenario === "duplicate-pause")
						evidence.anchor(f.file, throughMs + 20, 2000, true);
					await pending;
					await events.write(
						{ ev: "click", t: 100500, el: { text: "PAUSED_CLICK" } },
						page,
					);
				},
			},
			evidence,
			events,
			throughMs,
		);
		const raw = fs
			.readFileSync(
				path.join(path.dirname(f.file), "browser-evidence.jsonl"),
				"utf8",
			)
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(JSON.parse);
		assert.equal(raw.length, scenario === "duplicate-pause" ? 1 : 0, scenario);
		assert.equal(JSON.stringify(raw).includes("PAUSED_CLICK"), false, scenario);
	}
});
