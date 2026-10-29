import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCheckpointWorker } from "./checkpoint-worker.mjs";
import { finishNativeWalk } from "./native-walk.mjs";

const { processChapter } = await import(
	new URL("../../../vendor/ux-walk/src/process.mjs", import.meta.url)
);
const gate = () => {
	let release;
	const promise = new Promise((resolve) => {
		release = resolve;
	});
	return { promise, release };
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
for (const timing of ["before", "during", "after", "failed"])
	test(
		`stop-tail completion ${timing} the first report uses existing processing without another submission`,
		{ timeout: 15000 },
		async (t) => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "cap-tail-report-")),
				directory = path.join(root, "walk"),
				project = path.join(root, "source.cap"),
				segment = path.join(project, "content/segments/segment-0");
			fs.mkdirSync(segment, { recursive: true });
			fs.mkdirSync(directory);
			const save = (file, value) =>
				fs.writeFileSync(file, JSON.stringify(value));
			const display = path.join(segment, "display.mp4");
			execFileSync("ffmpeg", [
				"-v",
				"error",
				"-f",
				"lavfi",
				"-i",
				"color=s=16x16:r=2:d=2",
				"-c:v",
				"libx264",
				"-threads",
				"1",
				display,
			]);
			execFileSync("ffmpeg", [
				"-v",
				"error",
				"-f",
				"lavfi",
				"-i",
				"sine=frequency=440:duration=2",
				"-c:a",
				"aac",
				"-threads",
				"1",
				"-movflags",
				"frag_keyframe+empty_moov+default_base_moof",
				"-frag_duration",
				"1000000",
				path.join(segment, "audio-input.m4a"),
			]);
			save(path.join(segment, "start-times.json"), { display: 0, mic: 0 });
			save(path.join(project, "recording-meta.json"), {
				status: { status: "Complete" },
				segments: [
					{
						display: {
							path: "content/segments/segment-0/display.mp4",
							start_time: 0,
						},
						mic: {
							path: "content/segments/segment-0/audio-input.m4a",
							start_time: 0,
						},
					},
				],
			});
			const file = path.join(directory, "native-walk.json");
			save(file, {
				schemaVersion: 1,
				state: "complete",
				startedAtMs: 1000,
				durationMs: 2000,
				sourceProject: project,
				request: {
					directory,
					topic: "Healthy stop tail",
					url: "",
					speakers: [],
				},
				events: [],
			});
			save(path.join(directory, "checkpoint-heartbeat.json"), {
				schemaVersion: 1,
				generation: 1,
				parentPid: process.pid,
				activeElapsedMs: 2000,
				wallMs: Date.now(),
				paused: true,
				captureEnded: true,
				expectedAudio: { microphone: true, systemAudio: false },
			});
			const chapter = path.join(directory, "01-walkthrough");
			fs.mkdirSync(path.join(chapter, "shots"), { recursive: true });
			fs.writeFileSync(path.join(chapter, "shots/skip.txt"), "fixture");
			const cfg = {
				transcriber: "elevenlabs",
				liveTranscription: true,
				glossary: "",
				brief: false,
				sections: false,
				screenNames: false,
				sourceRoot: "",
				me: "Synthetic",
			};
			const words = gate(),
				entered = gate(),
				exportEntered = gate(),
				exportGate = gate();
			let providerCalls = 0,
				networkCalls = 0,
				worker,
				preparation;
			const previous = global.fetch;
			global.fetch = async () => {
				networkCalls++;
				throw Error("Real network forbidden");
			};
			t.after(async () => {
				words.release();
				exportGate.release();
				await Promise.allSettled([worker, preparation].filter(Boolean));
				global.fetch = previous;
				fs.rmSync(root, { recursive: true, force: true });
			});
			worker = runCheckpointWorker(file, cfg, {
				transport: {
					status: async () => ({ backupEnabled: false, server: "" }),
				},
				jobs: {
					words: async () => {
						providerCalls++;
						entered.release();
						await words.promise;
						if (timing === "failed") throw Error("Provider rejected mock tail");
						return [
							{ start: 0.4, end: 0.9, text: "Healthy stop tail", speaker: 0 },
						];
					},
				},
			});
			await entered.promise;
			if (timing === "before") {
				words.release();
				await worker;
			}
			preparation = finishNativeWalk(file, cfg, {
				client: {
					export: async (_project, output) => {
						exportEntered.release();
						if (timing === "during") await exportGate.promise;
						fs.copyFileSync(display, output);
						return { durationS: 2 };
					},
				},
				processChapter: (dir, config, options) =>
					processChapter(dir, config, {
						...options,
						quiet: true,
						log: () => {},
					}),
			});
			await exportEntered.promise;
			if (timing === "during") {
				words.release();
				const deadline = Date.now() + 5000;
				while (!fs.existsSync(path.join(directory, "checkpoints/seal.json"))) {
					assert.ok(
						Date.now() < deadline,
						"Worker must seal without waiting for video preparation",
					);
					await sleep(20);
				}
				exportGate.release();
			}
			await preparation;
			if (["after", "failed"].includes(timing)) {
				assert.equal(
					JSON.parse(fs.readFileSync(path.join(directory, "processing.json")))
						.transcript,
					"partial",
				);
				words.release();
			}
			await worker;
			const state = JSON.parse(
				fs.readFileSync(path.join(directory, "processing.json")),
			);
			assert.equal(state.transcript, timing === "failed" ? "partial" : "ready");
			if (timing !== "failed") {
				assert.match(
					fs.readFileSync(path.join(chapter, "transcript.srt"), "utf8"),
					/Healthy stop tail/,
				);
				assert.match(
					fs.readFileSync(path.join(chapter, "timeline.md"), "utf8"),
					/Healthy stop tail/,
				);
			}
			assert.equal(providerCalls, 1);
			assert.equal(networkCalls, 0);
		},
	);
