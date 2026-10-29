import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { CheckpointWorker } from "./checkpoint-worker.mjs";
import { finishNativeWalk } from "./native-walk.mjs";
import { restoreRecovery } from "./restore-checkpoint.mjs";

for (const mismatch of [
	"journal",
	"sourceProject",
	"startedAtMs",
	"recordingId",
	"generation",
	"none",
])
	test(`finish and recovery only project the original Meet owner: ${mismatch}`, async (t) => {
		const root = fs.mkdtempSync("/tmp/cap-meet-projection-");
		t.after(() => fs.rmSync(root, { recursive: true, force: true }));
		const directory = path.join(root, "walk"),
			sourceProject = path.join(root, "source.cap"),
			file = path.join(directory, "native-walk.json");
		fs.mkdirSync(directory);
		fs.mkdirSync(sourceProject);
		fs.writeFileSync(
			path.join(sourceProject, "recording-meta.json"),
			JSON.stringify({ status: { status: "Complete" } }),
		);
		fs.writeFileSync(path.join(sourceProject, "source.mp4"), "synthetic media");
		const journal = {
			schemaVersion: 1,
			state: "complete",
			startedAtMs: 1000,
			durationMs: 10000,
			sourceProject,
			request: { directory, topic: "Owner projection", url: "", speakers: [] },
			events: [],
		};
		fs.writeFileSync(file, JSON.stringify(journal));
		const metadata = {
			schemaVersion: 1,
			captureId: "capture",
			recordingId: "recording",
			generation: "generation",
			windowId: "55",
			journal: file,
			sourceProject,
			startedAtMs: 1000,
			state: "complete",
			anchors: [{ wallMs: 1000, offsetMs: 0, paused: false }],
		};
		if (["journal", "sourceProject"].includes(mismatch))
			metadata[mismatch] = path.join(root, "foreign", mismatch);
		if (mismatch === "startedAtMs") metadata.startedAtMs = 999;
		const event = {
			ev: "meet-caption",
			source: "chrome-extension",
			observedAt: 2000,
			nativeOffsetMs: 1000,
			clockEpoch: 0,
			name: "Owner Name",
			text: "Owner caption",
			captionId: "turn",
			revision: 1,
			companion: {
				role: "meet",
				bindingId: "binding",
				recordingId: "recording",
				generation: "generation",
				clientId: "client",
				tabId: 4,
				documentId: "document",
				meeting: "/abc-defg-hij",
			},
		};
		if (["recordingId", "generation"].includes(mismatch))
			event.companion[mismatch] = "foreign";
		fs.writeFileSync(
			path.join(directory, "browser-evidence.json"),
			JSON.stringify(metadata),
		);
		const raw = `${JSON.stringify(event)}\n${JSON.stringify({ ...event, eventId: "late", captionId: "late", nativeOffsetMs: -500, timingUncertain: true })}\n`;
		fs.writeFileSync(path.join(directory, "browser-evidence.jsonl"), raw);
		fs.writeFileSync(
			path.join(directory, "checkpoint-heartbeat.json"),
			JSON.stringify({
				generation: 1,
				parentPid: process.pid,
				activeElapsedMs: 10000,
				wallMs: 11000,
				paused: true,
				expectedAudio: { microphone: false, systemAudio: false },
			}),
		);
		const worker = new CheckpointWorker(
			file,
			{ transcriber: "none" },
			{ backupEnabled: false, server: "" },
			{ sessionGeneration: 1 },
		);
		await worker.checkpoint({ force: true });
		const destination = path.join(root, "recovered"),
			recordingId = worker.store.options.recordingId;
		await restoreRecovery(
			{
				request: async (_method, resource, options) => {
					if (options?.output) {
						fs.copyFileSync(
							worker.store.objectPath(resource.split("/").at(-1)),
							options.output,
						);
						return {};
					}
					return {
						recordingId,
						writerGeneration: worker.store.options.generation,
						startedAtMs: 1000,
						checkpoints: worker.store.descriptors(),
					};
				},
			},
			recordingId,
			destination,
		);
		const restored = fs.readFileSync(
			path.join(destination, "meet.jsonl"),
			"utf8",
		);
		assert.equal(
			fs.readFileSync(path.join(destination, "browser-evidence.jsonl"), "utf8"),
			raw,
		);
		await finishNativeWalk(
			file,
			{ transcriber: "none", brief: false, glossary: "" },
			{
				client: {
					export: async (_project, output) => {
						fs.writeFileSync(output, "export");
						return { durationS: 10 };
					},
				},
				processChapter: async () => ({ transcript: false }),
				writeIndex: () => {},
				writeReport: () => {},
			},
		);
		const finished = fs.readFileSync(
			path.join(directory, "meet.jsonl"),
			"utf8",
		);
		for (const result of [restored, finished]) {
			if (mismatch !== "none") assert.equal(result, "");
			else {
				const captions = result
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line));
				assert.equal(captions.length, 2);
				assert.equal(captions[0].name, "Owner Name");
				assert.equal(captions[0].timingUncertain, false);
				assert.equal(captions[1].timingUncertain, true);
			}
		}
	});
