import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { finishNativeWalk, snapshotNativeWalk } from "./native-walk.mjs";

function fixture(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cap-ux-native-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const source = path.join(root, "original.cap");
	const directory = path.join(root, "walk");
	fs.mkdirSync(source);
	fs.mkdirSync(directory);
	fs.writeFileSync(path.join(source, "recording-meta.json"), JSON.stringify({ status: { status: "Complete" } }));
	fs.writeFileSync(path.join(source, "source.mp4"), "original media");
	const journal = { schemaVersion: 1, state: "complete", startedAtMs: 100000, durationMs: 10000, sourceProject: source, request: { directory, topic: "Checkout", url: "https://example.com", speakers: ["Tester"] }, events: [{ kind: "note", text: "Clipped button", offsetMs: 1500 }, { kind: "chapter", text: "Payment", offsetMs: 4000 }] };
	const file = path.join(directory, "native-walk.json");
	const save = () => fs.writeFileSync(file, JSON.stringify(journal));
	save();
	return { journal, file, save, directory, source };
}

test("refuses an active or aborted native capture before touching media", async (t) => {
	const f = fixture(t);
	for (const state of ["recording", "aborted"]) {
		f.journal.state = state; f.save();
		assert.throws(() => snapshotNativeWalk(f.file), /complete/);
	}
	assert.equal(fs.existsSync(path.join(f.directory, "media")), false);
});

test("snapshots once and preserves original project plus journal on export failure", async (t) => {
	const f = fixture(t);
	const snapshot = snapshotNativeWalk(f.file);
	fs.writeFileSync(path.join(f.source, "source.mp4"), "later editor change");
	assert.equal(snapshotNativeWalk(f.file), snapshot);
	assert.equal(fs.readFileSync(path.join(snapshot, "source.mp4"), "utf8"), "original media");
	await assert.rejects(finishNativeWalk(f.file, { transcriber: "none", brief: false }, { client: { export: async (project) => { assert.equal(project, snapshot); throw new Error("Export failed"); } } }), /Export failed/);
	assert.equal(fs.readFileSync(path.join(f.source, "source.mp4"), "utf8"), "later editor change");
	assert.equal(JSON.parse(fs.readFileSync(f.file)).events[0].text, "Clipped button");
	assert.equal(fs.existsSync(snapshot), true);
});

test("chapters and notes keep Cap elapsed offsets and retries reuse their saved snapshot", async (t) => {
	const f = fixture(t);
	const spans = [];
	let exports = 0;
	const deps = {
		client: { export: async (_project, output) => { exports++; fs.writeFileSync(output, "export"); return { durationS: 10 }; } },
		clip: async (_input, output, start, duration) => { spans.push([start, duration]); fs.writeFileSync(output, "clip"); },
		processChapter: async (directory, cfg, options) => { assert.equal(cfg.transcriber, "none"); assert.equal(options.brief, false); assert.ok(fs.existsSync(path.join(directory, "chapter.json"))); return {}; },
		writeIndex: () => {}, writeReport: () => {},
	};
	await finishNativeWalk(f.file, { transcriber: "none", brief: false }, deps);
	const session = JSON.parse(fs.readFileSync(path.join(f.directory, "session.json")));
	assert.deepEqual(spans, [[0, 4], [4, 6]]);
	assert.equal(session.chapters[1].name, "Payment");
	assert.equal(session.chapters[1].startMs, 104000);
	const actions = fs.readFileSync(path.join(f.directory, "actions.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
	assert.equal(actions[0].t, 101500);
	assert.equal(actions[0].text, "Clipped button");
	await finishNativeWalk(f.file, { transcriber: "none", brief: false }, deps);
	assert.equal(exports, 1);
	assert.equal(session.coverage.dom, "not captured");
});
