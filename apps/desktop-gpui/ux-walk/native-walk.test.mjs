import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	finishNativeWalk,
	nativeWalkPrompt,
	snapshotNativeWalk,
} from "./native-walk.mjs";

function fixture(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cap-ux-native-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const source = path.join(root, "original.cap");
	const directory = path.join(root, "walk");
	fs.mkdirSync(source);
	fs.mkdirSync(directory);
	fs.writeFileSync(
		path.join(source, "recording-meta.json"),
		JSON.stringify({ status: { status: "Complete" } }),
	);
	fs.writeFileSync(path.join(source, "source.mp4"), "original media");
	const journal = {
		schemaVersion: 1,
		state: "complete",
		startedAtMs: 100000,
		durationMs: 10000,
		sourceProject: source,
		request: {
			directory,
			topic: "Checkout",
			url: "https://example.com",
			speakers: ["Tester"],
		},
		events: [
			{ kind: "note", text: "Clipped button", offsetMs: 1500 },
			{ kind: "chapter", text: "Payment", offsetMs: 4000 },
		],
	};
	const file = path.join(directory, "native-walk.json");
	const save = () => fs.writeFileSync(file, JSON.stringify(journal));
	save();
	return { journal, file, save, directory, source };
}

test("prompt entrypoint runs through a directory alias while non-file argv imports stay inert", (t) => {
	const f = fixture(t);
	const alias = path.join(path.dirname(f.directory), "adapter alias");
	fs.symlinkSync(fileURLToPath(new URL(".", import.meta.url)), alias, "dir");
	const result = spawnSync(
		process.execPath,
		[path.join(alias, "native-walk.mjs"), "prompt", f.file],
		{ encoding: "utf8", timeout: 5000 },
	);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, `${nativeWalkPrompt(f.file)}\n`);
	const imported = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`process.argv[1] = "not-a-file"; await import(${JSON.stringify(new URL("./native-walk.mjs", import.meta.url).href)}); console.log("imported");`,
		],
		{ encoding: "utf8", timeout: 5000 },
	);
	assert.equal(imported.status, 0, imported.stderr);
	assert.equal(imported.stdout, "imported\n");
	assert.equal(imported.stderr, "");
});

test("refuses an active or aborted native capture before touching media", async (t) => {
	const f = fixture(t);
	for (const state of ["recording", "aborted"]) {
		f.journal.state = state;
		f.save();
		assert.throws(() => snapshotNativeWalk(f.file), /complete/);
	}
	assert.equal(fs.existsSync(path.join(f.directory, "media")), false);
});

test("snapshots once and preserves original project plus journal on export failure", async (t) => {
	const f = fixture(t);
	const snapshot = snapshotNativeWalk(f.file);
	fs.writeFileSync(path.join(f.source, "source.mp4"), "later editor change");
	assert.equal(snapshotNativeWalk(f.file), snapshot);
	assert.equal(
		fs.readFileSync(path.join(snapshot, "source.mp4"), "utf8"),
		"original media",
	);
	await assert.rejects(
		finishNativeWalk(
			f.file,
			{ transcriber: "none", brief: false },
			{
				client: {
					export: async (project) => {
						assert.equal(project, snapshot);
						throw new Error("Export failed");
					},
				},
			},
		),
		/Export failed/,
	);
	assert.equal(
		fs.readFileSync(path.join(f.source, "source.mp4"), "utf8"),
		"later editor change",
	);
	assert.equal(
		JSON.parse(fs.readFileSync(f.file)).events[0].text,
		"Clipped button",
	);
	assert.equal(fs.existsSync(snapshot), true);
});

test("chapters and notes keep Cap elapsed offsets and retries reuse their saved snapshot", async (t) => {
	const f = fixture(t);
	const spans = [];
	let exports = 0;
	const deps = {
		client: {
			export: async (_project, output) => {
				exports++;
				fs.writeFileSync(output, "export");
				return { durationS: 10 };
			},
		},
		clip: async (_input, output, start, duration) => {
			spans.push([start, duration]);
			fs.writeFileSync(output, "clip");
		},
		processChapter: async (directory, cfg, options) => {
			assert.equal(cfg.transcriber, "none");
			assert.equal(options.brief, false);
			assert.ok(fs.existsSync(path.join(directory, "chapter.json")));
			assert.match(nativeWalkPrompt(f.file), /preparation: processing/);
			return {};
		},
		writeIndex: () => {},
		writeReport: () => {},
	};
	await finishNativeWalk(f.file, { transcriber: "none", brief: false }, deps);
	const session = JSON.parse(
		fs.readFileSync(path.join(f.directory, "session.json")),
	);
	assert.deepEqual(spans, [
		[0, 4],
		[4, 6],
	]);
	assert.equal(session.chapters[1].name, "Payment");
	assert.equal(session.chapters[1].startMs, 104000);
	assert.match(
		fs.readFileSync(path.join(f.directory, "agent-prompt.txt"), "utf8"),
		/preparation: ready/,
	);
	const actions = fs
		.readFileSync(path.join(f.directory, "actions.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map(JSON.parse);
	assert.equal(actions[0].t, 101500);
	assert.equal(actions[0].text, "Clipped button");
	await finishNativeWalk(f.file, { transcriber: "none", brief: false }, deps);
	assert.equal(exports, 1);
	assert.equal(session.coverage.dom, "not captured");
});

test("a partial failed export cannot block a retry or replace the source", async (t) => {
	const f = fixture(t);
	let failed = false;
	const deps = {
		client: {
			export: async (_project, output) => {
				assert.equal(fs.existsSync(output), false);
				fs.writeFileSync(output, "derived movie");
				if (!failed) {
					failed = true;
					throw new Error("Interrupted export");
				}
				return { durationS: 10 };
			},
		},
		clip: async (_input, output) => fs.writeFileSync(output, "clip"),
		processChapter: async () => ({}),
		writeIndex: () => {},
		writeReport: () => {},
	};
	await assert.rejects(
		finishNativeWalk(f.file, { brief: false }, deps),
		/Interrupted export/,
	);
	await finishNativeWalk(f.file, { brief: false }, deps);
	assert.equal(
		fs.readFileSync(path.join(f.source, "source.mp4"), "utf8"),
		"original media",
	);
	const report = fs.readFileSync(path.join(f.directory, "report.html"), "utf8");
	assert.ok(report.includes("Clipped button"));
	assert.ok(report.includes("Payment"));
	assert.ok(report.includes("video.mp4"));
});

test("reprocessing recovers a lock left by a process that no longer exists", async (t) => {
	const f = fixture(t);
	const lock = path.join(f.directory, ".processing-lock");
	fs.mkdirSync(lock);
	fs.writeFileSync(
		path.join(lock, "owner.json"),
		JSON.stringify({ pid: 2147483647 }),
	);
	await finishNativeWalk(
		f.file,
		{ transcriber: "none", brief: false },
		{
			client: {
				export: async (_project, output) => {
					fs.writeFileSync(output, "export");
					return { durationS: 10 };
				},
			},
			clip: async (_input, output) => fs.writeFileSync(output, "clip"),
			processChapter: async () => ({}),
			writeIndex: () => {},
			writeReport: () => {},
		},
	);
	assert.equal(fs.existsSync(lock), false);
	assert.equal(fs.existsSync(path.join(f.directory, "report.html")), true);
});

test("processing and reprocessing retain owned browser evidence alongside native notes", async (t) => {
	const f = fixture(t);
	fs.writeFileSync(
		path.join(f.directory, "browser-evidence.json"),
		JSON.stringify({
			schemaVersion: 1,
			captureId: "owned-browser",
			journal: f.file,
			sourceProject: f.source,
			windowId: "17",
			startedAtMs: f.journal.startedAtMs,
			state: "complete",
			anchors: [
				{ wallMs: 100000, offsetMs: 0, paused: false },
				{ wallMs: 110000, offsetMs: 10000, paused: true },
			],
		}),
	);
	fs.writeFileSync(
		path.join(f.directory, "browser-evidence.jsonl"),
		[
			{ ev: "click", observedAt: 100500, el: { tag: "button", text: "Save" } },
			{
				ev: "http",
				observedAt: 102000,
				method: "POST",
				status: 400,
				url: "https://example.com/rest/v1/rpc/save?token=SECRET_SENTINEL",
				resBody: '{"code":"23514","message":"Invalid window"}',
			},
		]
			.map(JSON.stringify)
			.join("\n"),
	);
	const deps = {
		client: {
			export: async (_project, output) => {
				fs.writeFileSync(output, "export");
				return { durationS: 10 };
			},
		},
		clip: async (_input, output) => fs.writeFileSync(output, "clip"),
		processChapter: async () => ({}),
		writeIndex: () => {},
		writeReport: () => {},
	};
	for (let attempt = 0; attempt < 2; attempt++) {
		await finishNativeWalk(f.file, { transcriber: "none", brief: false }, deps);
		const actions = fs
			.readFileSync(path.join(f.directory, "actions.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map(JSON.parse);
		assert.deepEqual(
			actions.map((event) => event.ev),
			["click", "note", "http"],
		);
		assert.deepEqual(
			actions.map((event) => event.t),
			[100500, 101500, 102000],
		);
		assert.equal(JSON.stringify(actions).includes("SECRET_SENTINEL"), false);
		assert.match(
			JSON.parse(fs.readFileSync(path.join(f.directory, "session.json")))
				.coverage.network,
			/captured/,
		);
		assert.match(
			fs.readFileSync(path.join(f.directory, "report.html"), "utf8"),
			/Browser evidence/,
		);
	}
});

test("canonical saved-journal paths accept directory aliases and reject copied journals", (t) => {
	const f = fixture(t);
	const alias = path.join(path.dirname(f.directory), "walk-alias");
	fs.symlinkSync(f.directory, alias, "dir");
	f.journal.request.directory = alias;
	f.save();
	assert.doesNotThrow(() => snapshotNativeWalk(fs.realpathSync(f.file)));
	const copy = path.join(path.dirname(f.directory), "other-walk");
	fs.mkdirSync(copy);
	const copied = path.join(copy, "native-walk.json");
	fs.copyFileSync(f.file, copied);
	assert.throws(() => snapshotNativeWalk(copied), /does not match/);
	assert.equal(fs.existsSync(path.join(copy, "media")), false);
});

test("copying an agent prompt describes recording, aborted and unprocessed walks honestly", (t) => {
	const f = fixture(t);
	for (const state of ["recording", "aborted"]) {
		f.journal.state = state;
		f.journal.durationMs = null;
		f.save();
		const prompt = nativeWalkPrompt(f.file);
		assert.match(prompt, new RegExp(state));
		assert.match(prompt, /not finalized|incomplete|in progress/i);
		assert.equal(fs.existsSync(path.join(f.directory, "media")), false);
	}
	f.journal.state = "complete";
	f.journal.durationMs = 10000;
	f.save();
	assert.match(nativeWalkPrompt(f.file), /not started|not prepared/);
});
