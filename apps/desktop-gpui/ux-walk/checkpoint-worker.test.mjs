import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { durableJson, sha256 } from "./checkpoint-store.mjs";
import { CheckpointWorker } from "./checkpoint-worker.mjs";
import { restoreRecovery } from "./restore-checkpoint.mjs";

test("local complete audio and log checkpoints advance while network is held; acknowledged sources restore and stop tail transcribes once", async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "uxw-worker-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const project = path.join(root, "source.cap");
	const segment = path.join(project, "content/segments/segment-0");
	fs.mkdirSync(segment, { recursive: true });
	const audio = path.join(segment, "audio-input.m4a");
	execFileSync("ffmpeg", [
		"-v",
		"error",
		"-f",
		"lavfi",
		"-i",
		"sine=frequency=660:duration=2.4",
		"-c:a",
		"aac",
		"-threads",
		"1",
		"-movflags",
		"frag_keyframe+empty_moov+default_base_moof",
		"-frag_duration",
		"1000000",
		audio,
	]);
	durableJson(path.join(segment, "start-times.json"), { mic: 0, display: 0 });
	const file = path.join(root, "native-walk.json");
	durableJson(file, {
		schemaVersion: 1,
		state: "recording",
		request: { directory: root, topic: "Synthetic", speakers: [] },
		sourceProject: project,
		startedAtMs: 1,
		events: [{ kind: "note", text: "recover me", offsetMs: 0 }],
		durationMs: null,
	});
	const heartbeat = (ms) =>
		durableJson(path.join(root, "checkpoint-heartbeat.json"), {
			activeElapsedMs: ms,
			wallMs: ms + 1,
			paused: false,
			parentPid: process.pid,
			generation: 1,
			expectedAudio: { microphone: true },
			noteDraft: "draft",
		});
	heartbeat(2500);
	fs.writeFileSync(
		path.join(root, "browser-evidence.jsonl"),
		' {"ev":"click"}\n{"partial":',
	);
	const settings = {
		backupEnabled: true,
		server: "https://backup.example",
		expiresInDays: 7,
	};
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const uploaded = new Map();
	const descriptors = [];
	let calls = 0;
	const transport = {
		status: async () => settings,
		request: async (method, resource, options = {}) => {
			if (method === "PUT") {
				await gate;
				const bytes = fs.readFileSync(options.input);
				if (resource.includes("/objects/")) {
					uploaded.set(resource.split("/").at(-1), bytes);
					return { sha256: sha256(bytes), size: bytes.length };
				}
				const value = JSON.parse(bytes);
				if (resource.includes("/checkpoints/")) {
					descriptors.push(value);
					return {
						acknowledged: true,
						sequence: value.sequence,
						sha256: sha256(bytes),
					};
				}
				return {
					...value,
					requestHash: sha256(Buffer.from(JSON.stringify(value))),
					expiresAt: Date.now() + 100000,
				};
			}
			if (options.output) {
				fs.writeFileSync(
					options.output,
					uploaded.get(resource.split("/").at(-1)),
				);
				return {};
			}
			return {
				recordingId: worker.store.options.recordingId,
				writerGeneration: worker.store.options.generation,
				checkpoints: descriptors,
				title: "Synthetic",
			};
		},
	};
	const worker = new CheckpointWorker(
		file,
		{ transcriber: "elevenlabs" },
		settings,
		{
			transport,
			sessionGeneration: 1,
			jobs: {
				words: async () => {
					calls++;
					return [{ start: 0.2, end: 0.4, text: "synthetic", speaker: 0 }];
				},
			},
		},
	);
	await worker.checkpoint({ force: true });
	assert.match(worker.status().transcription, /waiting/i);
	const firstEnd = worker.sources["segment-0:microphone"].sourceEndMs;
	assert.ok(firstEnd > 2000);
	assert.equal(worker.store.state.remoteSequence, 0);
	const uploading = worker.uploadNext();
	heartbeat(5000);
	await worker.checkpoint({ force: true });
	assert.equal(worker.store.state.sequence, 2);
	assert.equal(worker.store.state.remoteSequence, 0);
	assert.equal(worker.sources["segment-0:microphone"].sourceEndMs, firstEnd);
	release();
	await uploading;
	assert.equal(worker.store.state.remoteSequence, 1);
	assert.equal(worker.store.state.remoteClockThroughMs, 2500);
	const restored = path.join(root, "restored");
	await restoreRecovery(transport, worker.store.options.recordingId, restored);
	assert.match(
		fs.readFileSync(path.join(restored, "report.html"), "utf8"),
		/recover me/,
	);
	assert.match(
		fs.readFileSync(path.join(restored, "report.html"), "utf8"),
		/draft/,
	);
	const ready = JSON.parse(
		fs.readFileSync(path.join(restored, "recovery-ready.json")),
	);
	assert.equal(ready.audio.length, 1);
	execFileSync("ffprobe", [
		"-v",
		"error",
		path.join(restored, ready.audio[0].relative),
	]);
	worker.phase = "draining";
	worker.prepareJobs(true);
	await worker.jobs.runNext();
	await worker.jobs.runNext();
	assert.equal(calls, 1);
	const job = worker.jobs.all()[0];
	assert.equal(job.state, "complete");
	assert.match(
		JSON.parse(fs.readFileSync(worker.jobs.resultPath(job.jobId))).words[0]
			.speaker,
		/segment-0:microphone:/,
	);
	const resumed = new CheckpointWorker(
		file,
		{ transcriber: "elevenlabs" },
		settings,
		{ transport, sessionGeneration: 1 },
	);
	assert.equal(resumed.store.state.remoteSequence, 1);
	assert.equal(resumed.sources["segment-0:microphone"].sourceEndMs, firstEnd);
});

test("mismatched registration, object or checkpoint receipts never advance acknowledged coverage", async (t) => {
	for (const failedStage of ["registration", "object", "checkpoint"]) {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "uxw-receipt-"));
		t.after(() => fs.rmSync(root, { recursive: true, force: true }));
		const file = path.join(root, "native-walk.json");
		const project = path.join(root, "source.cap");
		fs.mkdirSync(project);
		durableJson(file, {
			state: "recording",
			request: { directory: root, topic: "Test" },
			sourceProject: project,
			startedAtMs: 1,
		});
		durableJson(path.join(root, "checkpoint-heartbeat.json"), {
			wallMs: 1000,
			activeElapsedMs: 1000,
			paused: false,
			parentPid: process.pid,
			generation: 1,
		});
		const settings = { backupEnabled: true, server: "https://backup.example" };
		const transport = {
			status: async () => settings,
			request: async (_method, resource, { input }) => {
				const bytes = fs.readFileSync(input);
				const { sha256 } = await import("./checkpoint-store.mjs");
				if (resource.includes("/objects/"))
					return failedStage === "object"
						? { sha256: "0".repeat(64), size: -1 }
						: { sha256: sha256(bytes), size: bytes.length };
				if (resource.includes("/checkpoints/"))
					return {
						acknowledged: failedStage !== "checkpoint",
						sequence: JSON.parse(bytes).sequence,
						sha256: sha256(bytes),
					};
				return failedStage === "registration"
					? { recordingId: "wrong" }
					: {
							...JSON.parse(bytes),
							expiresAt: Date.now() + 100000,
							requestHash: sha256(
								Buffer.from(JSON.stringify(JSON.parse(bytes))),
							),
						};
			},
		};
		const worker = new CheckpointWorker(
			file,
			{ transcriber: "none" },
			settings,
			{ transport },
		);
		await worker.checkpoint({ force: true });
		await worker.uploadNext();
		assert.equal(worker.store.state.remoteSequence, 0, failedStage);
		assert.match(worker.error, /acknowledg|identity|receipt|integrity/i);
	}
});

test("terminal drain backs up the final event and descriptor before a healthy worker exits", async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "uxw-drain-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const file = path.join(root, "native-walk.json"),
		sourceProject = path.join(root, "source.cap");
	fs.mkdirSync(sourceProject);
	const journal = {
		state: "recording",
		request: { directory: root, topic: "Test" },
		sourceProject,
		startedAtMs: 1,
	};
	durableJson(file, journal);
	durableJson(path.join(root, "checkpoint-heartbeat.json"), {
		activeElapsedMs: 100,
		wallMs: 100,
		parentPid: process.pid,
		generation: 1,
		paused: false,
	});
	const settings = { backupEnabled: true, server: "https://backup.example" };
	const blobs = [];
	const transport = {
		status: async () => settings,
		request: async (_method, resource, { input }) => {
			const bytes = fs.readFileSync(input);
			const { sha256 } = await import("./checkpoint-store.mjs");
			if (resource.includes("/objects/")) {
				blobs.push(bytes.toString());
				return { sha256: sha256(bytes), size: bytes.length };
			}
			const value = JSON.parse(bytes);
			if (resource.includes("/checkpoints/"))
				return {
					acknowledged: true,
					sequence: value.sequence,
					sha256: sha256(bytes),
				};
			return {
				...value,
				requestHash: sha256(Buffer.from(JSON.stringify(value))),
				expiresAt: Date.now() + 100000,
			};
		},
	};
	const worker = new CheckpointWorker(file, { transcriber: "none" }, settings, {
		transport,
		sessionGeneration: 1,
	});
	await worker.checkpoint({ force: true });
	durableJson(file, { ...journal, state: "aborted" });
	fs.writeFileSync(
		path.join(root, "browser-evidence.jsonl"),
		'{"ev":"pageerror","text":"final failure"}\n',
	);
	durableJson(path.join(root, "checkpoint-heartbeat.json"), {
		activeElapsedMs: 1000,
		wallMs: 1000,
		parentPid: process.pid,
		generation: 1,
		paused: true,
	});
	const { runCheckpointWorker } = await import("./checkpoint-worker.mjs");
	await runCheckpointWorker(file, { transcriber: "none" }, { transport });
	const resumed = new CheckpointWorker(
		file,
		{ transcriber: "none" },
		settings,
		{ transport },
	);
	assert.equal(
		resumed.store.state.remoteSequence,
		resumed.store.state.sequence,
	);
	assert.ok(blobs.some((text) => text.includes("final failure")));
});

test("modified full transcript metadata is never admitted to the durable backup outbox", async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "uxw-full-words-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const sourceProject = path.join(root, "source.cap");
	fs.mkdirSync(sourceProject);
	const file = path.join(root, "native-walk.json");
	durableJson(file, {
		state: "recording",
		request: { directory: root, topic: "Test" },
		sourceProject,
		startedAtMs: 1,
	});
	durableJson(path.join(root, "checkpoint-heartbeat.json"), {
		activeElapsedMs: 1000,
		wallMs: 1000,
		parentPid: process.pid,
		generation: 1,
		paused: false,
	});
	const worker = new CheckpointWorker(
		file,
		{ transcriber: "none" },
		{ backupEnabled: false, server: "" },
	);
	durableJson(path.join(root, "checkpoints/full-transcript.json"), {
		wordsHash: sha256(Buffer.from("original")),
	});
	durableJson(path.join(root, "checkpoints/full-transcript-words.json"), {
		source: "exported-session",
		words: [{ start: 0, end: 1, text: "UNVERIFIED" }],
	});
	await worker.checkpoint({ force: true });
	assert.equal(
		worker.store
			.descriptors()
			.flatMap((value) => value.objects)
			.filter((object) => object.kind === "transcriptWords").length,
		0,
	);
	assert.match(worker.error, /integrity|checksum|receipt/i);
});
