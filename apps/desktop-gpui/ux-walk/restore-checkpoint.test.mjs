import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CheckpointStore, durableWrite } from "./checkpoint-store.mjs";
import { restoreRecovery } from "./restore-checkpoint.mjs";

test("restore recreates critical evidence without video and cannot follow recorded absolute paths", async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ux-walk-restore-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const recordingId = "11111111-1111-4111-8111-111111111111";
	const generation = "22222222-2222-4222-8222-222222222222";
	const original = new CheckpointStore(path.join(root, "original"), {
		recordingId,
		generation,
		endpoint: "https://synthetic.example",
	});
	const note = original.put(
		"journal",
		Buffer.from(
			JSON.stringify({
				request: {
					directory: "/private/old",
					topic: "Recovered",
					speakers: [],
				},
				sourceProject: "/private/recording.cap",
				startedAtMs: 1000,
				events: [{ kind: "note", text: "Critical note", offsetMs: 100 }],
				state: "recording",
			}),
		),
		{ activeStartMs: 0, activeEndMs: 1000 },
	);
	const events = original.put(
		"events",
		Buffer.from('{"ev":"click","observedAt":1100}\n'),
		{
			activeStartMs: 0,
			activeEndMs: 1000,
			byteStart: 0,
			byteEnd: Buffer.byteLength('{"ev":"click","observedAt":1100}\n'),
		},
	);
	original.commit([note, events], {
		wallMs: 2000,
		activeElapsedMs: 1000,
		paused: false,
	});
	const transport = {
		async request(_method, resource, options) {
			if (options?.output) {
				const hash = resource.split("/").at(-1);
				durableWrite(
					options.output,
					fs.readFileSync(original.objectPath(hash)),
				);
				return {};
			}
			return {
				recordingId,
				writerGeneration: generation,
				title: "Recovered",
				startedAtMs: 1000,
				checkpoints: original.descriptors(),
			};
		},
	};
	const destination = path.join(root, "restored");
	await restoreRecovery(transport, recordingId, destination);
	const journal = JSON.parse(
		fs.readFileSync(path.join(destination, "native-walk.json")),
	);
	assert.equal(journal.state, "aborted");
	assert.equal(journal.request.directory, destination);
	assert.ok(journal.sourceProject.startsWith(destination));
	assert.equal(journal.events[0].text, "Critical note");
	assert.match(
		fs.readFileSync(path.join(destination, "report.html"), "utf8"),
		/interrupted/i,
	);
	assert.match(
		fs.readFileSync(path.join(destination, "browser-evidence.jsonl"), "utf8"),
		/click/,
	);
	await assert.rejects(
		restoreRecovery(transport, recordingId, destination),
		/exist|new/,
	);
});

test("corrupt downloaded evidence is rejected before any ready recovery receipt", async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ux-walk-bad-restore-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const recordingId = "11111111-1111-4111-8111-111111111111";
	const descriptor = {
		sequence: 1,
		previousSequence: 0,
		recordingId,
		writerGeneration: "22222222-2222-4222-8222-222222222222",
		clock: { wallMs: 1000, activeElapsedMs: 1000, paused: false },
		objects: [
			{
				kind: "journal",
				sha256: "a".repeat(64),
				size: 2,
				activeStartMs: 0,
				activeEndMs: 1000,
			},
		],
	};
	const transport = {
		async request(_method, _resource, options) {
			if (options?.output) durableWrite(options.output, "{}");
			return {
				recordingId,
				writerGeneration: descriptor.writerGeneration,
				checkpoints: [descriptor],
			};
		},
	};
	const destination = path.join(root, "restored");
	await assert.rejects(
		restoreRecovery(transport, recordingId, destination),
		/checksum|integrity/,
	);
	assert.equal(
		fs.existsSync(path.join(destination, "recovery-ready.json")),
		false,
	);
});

test("restore refuses missing bytes between valid event chunks before issuing a ready receipt", async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "uxw-gap-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const recordingId = "11111111-1111-4111-8111-111111111111",
		generation = "22222222-2222-4222-8222-222222222222";
	const store = new CheckpointStore(path.join(root, "original"), {
		recordingId,
		generation,
		endpoint: "",
	});
	let start = 0;
	for (const text of ['{"ev":"click"}\n', '{"ev":"error"}\n']) {
		const bytes = Buffer.from(text);
		store.commit(
			[
				store.put("events", bytes, {
					activeStartMs: 0,
					activeEndMs: 1000,
					byteStart: start,
					byteEnd: start + bytes.length,
				}),
			],
			{ wallMs: 1000, activeElapsedMs: 1000, paused: false },
		);
		start += bytes.length + 500;
	}
	const transport = {
		request: async (_method, resource, options) => {
			if (options?.output) {
				fs.writeFileSync(
					options.output,
					fs.readFileSync(store.objectPath(resource.split("/").at(-1))),
				);
				return {};
			}
			return {
				recordingId,
				writerGeneration: generation,
				checkpoints: store.descriptors(),
			};
		},
	};
	const destination = path.join(root, "restored");
	await assert.rejects(
		restoreRecovery(transport, recordingId, destination),
		/event.*(gap|contigu|byte)/i,
	);
	assert.equal(
		fs.existsSync(path.join(destination, "recovery-ready.json")),
		false,
	);
});

test("identical standalone audio bytes retain distinct source placements and exact repeated references deduplicate", async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "uxw-audio-placement-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const recordingId = "11111111-1111-4111-8111-111111111111",
		generation = "22222222-2222-4222-8222-222222222222";
	const store = new CheckpointStore(path.join(root, "original"), {
		recordingId,
		generation,
		endpoint: "",
	});
	const audio = Buffer.alloc(32044);
	audio.write("RIFF", 0);
	audio.writeUInt32LE(32036, 4);
	audio.write("WAVEfmt ", 8);
	audio.writeUInt32LE(16, 16);
	audio.writeUInt16LE(1, 20);
	audio.writeUInt16LE(1, 22);
	audio.writeUInt32LE(16000, 24);
	audio.writeUInt32LE(32000, 28);
	audio.writeUInt16LE(2, 32);
	audio.writeUInt16LE(16, 34);
	audio.write("data", 36);
	audio.writeUInt32LE(32000, 40);
	const first = store.put("microphone", audio, {
		source: "segment-0:microphone",
		encoding: "standalone",
		container: "wav",
		sourceStartMs: 0,
		sourceEndMs: 1000,
		activeStartMs: 0,
		activeEndMs: 1000,
	});
	const second = store.put("microphone", audio, {
		source: "segment-0:microphone",
		encoding: "standalone",
		container: "wav",
		sourceStartMs: 1000,
		sourceEndMs: 2000,
		activeStartMs: 0,
		activeEndMs: 2000,
	});
	store.commit([first], { wallMs: 1000, activeElapsedMs: 1000, paused: false });
	store.commit([first, second], {
		wallMs: 2000,
		activeElapsedMs: 2000,
		paused: false,
	});
	let downloads = 0;
	const transport = {
		request: async (_method, resource, options) => {
			if (options?.output) {
				downloads++;
				fs.writeFileSync(
					options.output,
					fs.readFileSync(store.objectPath(resource.split("/").at(-1))),
				);
				return {};
			}
			return {
				recordingId,
				writerGeneration: generation,
				checkpoints: store.descriptors(),
			};
		},
	};
	const destination = path.join(root, "restored");
	await restoreRecovery(transport, recordingId, destination);
	const receipt = JSON.parse(
		fs.readFileSync(path.join(destination, "recovery-ready.json")),
	);
	assert.equal(downloads, 1);
	assert.equal(receipt.audio.length, 2);
	assert.deepEqual(
		receipt.audio.map((item) => [
			item.sourceStartMs,
			item.sourceEndMs,
			item.activeStartMs,
			item.activeEndMs,
		]),
		[
			[0, 1000, 0, 1000],
			[1000, 2000, 0, 2000],
		],
	);
	assert.equal(new Set(receipt.audio.map((item) => item.relative)).size, 1);
	const report = fs.readFileSync(path.join(destination, "report.html"), "utf8");
	assert.equal((report.match(/<audio controls/g) || []).length, 2);
	assert.match(report, /0\.000s–1\.000s/);
	assert.match(report, /1\.000s–2\.000s/);
});
