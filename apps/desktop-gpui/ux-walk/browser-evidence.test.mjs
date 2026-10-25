import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	projectBrowserEvidence,
	sanitizeBrowserEvent,
} from "./browser-evidence.mjs";

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
		{ ev: "http", observedAt: 104000, status: 400, method: "POST", url: "https://example.com/rest/v1/rpc/save" },
		{ ev: "pageerror", observedAt: 105000, text: "Error: broken\n at save (app.js:20)" },
		{ ev: "console", observedAt: 106100, level: "error", text: "After stop" },
	]);
	const result = projectBrowserEvidence(f.file, f.journal);
	assert.deepEqual(result.events.map((event) => event.t), [100500, 100800, 102000, 103000]);
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
	f.save([{ ev: "console", observedAt: 100500, level: "error", text: "Before crash" }]);
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

test("structured errors retain query failure meaning but omit credentials, bodies and form values", () => {
	const event = sanitizeBrowserEvent({
		ev: "write", t: 110, status: 400, method: "POST",
		url: "https://example.com/rest/v1/rpc/save?token=SECRET_SENTINEL#secret",
		reqBody: '{"password":"SECRET_SENTINEL"}',
		headers: { Authorization: "Bearer SECRET_SENTINEL" },
		resBody: '{"code":"23514","message":"Invalid window","token":"SECRET_SENTINEL","details":"Constraint conflict"}',
	}, 120);
	assert.equal(event.url, "https://example.com/rest/v1/rpc/save");
	assert.equal(event.reqBody, undefined);
	assert.equal(event.headers, undefined);
	assert.match(event.resBody, /23514/);
	assert.equal(JSON.stringify(event).includes("SECRET_SENTINEL"), false);
	assert.equal(sanitizeBrowserEvent({ ev: "change", value: "SECRET_SENTINEL" }, 120), null);
	assert.equal(sanitizeBrowserEvent({ ev: "key", key: "SECRET_SENTINEL" }, 120), null);
});

test("console stacks redact credentials and query values before persistence", () => {
	const event = sanitizeBrowserEvent({
		ev: "pageerror",
		text: "Error token=SECRET_SENTINEL at https://example.com/app.js?key=SECRET_SENTINEL:20:4 Authorization: Bearer SECRET_SENTINEL",
	}, 120);
	assert.equal(JSON.stringify(event).includes("SECRET_SENTINEL"), false);
	assert.match(event.text, /Error/);
});
