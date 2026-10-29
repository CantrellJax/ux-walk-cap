import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sha256 } from "./checkpoint-store.mjs";
import { runCheckpointWorker } from "./checkpoint-worker.mjs";
import { finishNativeWalk } from "./native-walk.mjs";
import { acquireWalkLock } from "./walk-lock.mjs";

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
for (const timing of [
	"before",
	"during",
	"after",
	"ambiguous",
	"rejected",
	"handoff",
	"video-failed",
])
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
				exportCalls = 0,
				networkCalls = 0,
				worker,
				resumedLease,
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
				await resumedLease?.release();
				global.fetch = previous;
				fs.rmSync(root, { recursive: true, force: true });
			});
			worker = runCheckpointWorker(file, cfg, {
				...(timing === "handoff"
					? {
							reconcileReport: async () => {
								resumedLease = await acquireWalkLock(directory, "checkpoint");
								save(path.join(directory, "checkpoint-status.json"), {
									resumedOwner: true,
								});
								throw Error("Refresh unavailable while another owner resumes");
							},
						}
					: {}),
				transport: {
					status: async () => ({ backupEnabled: false, server: "" }),
				},
				jobs: {
					words: async () => {
						providerCalls++;
						entered.release();
						await words.promise;
						if (timing === "ambiguous") throw Error("Provider response lost");
						if (timing === "rejected")
							throw Error("400 provider rejected mock tail");
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
				assert.equal(
					fs.existsSync(path.join(directory, "processing.json")),
					false,
				);
			}
			preparation = finishNativeWalk(file, cfg, {
				client: {
					export: async (_project, output) => {
						exportCalls++;
						exportEntered.release();
						if (timing === "video-failed") throw Error("Video refused");
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
			if (timing === "video-failed")
				await assert.rejects(preparation, /Video refused/);
			else await preparation;
			if (["after", "ambiguous", "rejected", "handoff"].includes(timing)) {
				assert.equal(
					JSON.parse(fs.readFileSync(path.join(directory, "processing.json")))
						.transcript,
					"partial",
				);
				words.release();
			}
			if (timing === "video-failed") words.release();
			await worker;
			const state = JSON.parse(
				fs.readFileSync(path.join(directory, "processing.json")),
			);
			if (timing === "video-failed") {
				assert.equal(state.state, "failed");
				assert.match(state.error, /Video refused/);
			} else
				assert.equal(
					state.transcript,
					["ambiguous", "rejected", "handoff"].includes(timing)
						? "partial"
						: "ready",
				);
			if (
				!["ambiguous", "rejected", "handoff", "video-failed"].includes(timing)
			) {
				assert.match(
					fs.readFileSync(path.join(chapter, "transcript.srt"), "utf8"),
					/Healthy stop tail/,
				);
				assert.match(
					fs.readFileSync(path.join(chapter, "timeline.md"), "utf8"),
					/Healthy stop tail/,
				);
			}
			if (timing === "after") {
				const lease = await acquireWalkLock(directory, "processing"),
					processingFile = path.join(directory, "processing.json"),
					before = fs.readFileSync(processingFile);
				const began = Date.now();
				try {
					await assert.rejects(
						finishNativeWalk(file, cfg, {
							reconcileStopTail: true,
							reconcileWaitMs: 20,
						}),
						/being processed|ownership socket/,
					);
				} finally {
					await lease.release();
				}
				assert.ok(Date.now() - began < 1000);
				assert.deepEqual(fs.readFileSync(processingFile), before);
			}
			if (timing === "handoff") {
				assert.deepEqual(
					JSON.parse(
						fs.readFileSync(path.join(directory, "checkpoint-status.json")),
					),
					{ resumedOwner: true },
				);
				assert.equal(
					fs
						.readdirSync(directory)
						.filter((name) => /^report-refresh-.*\.json$/.test(name)).length,
					1,
				);
			}
			assert.equal(providerCalls, 1);
			assert.equal(exportCalls, 1);
			assert.equal(networkCalls, 0);
		},
	);

for (const slowVideo of [false, true])
	test(
		`unsupported zero-job tail uses one verified fallback (${slowVideo ? "video outlives refresh wait" : "report already partial"})`,
		{ timeout: 15000 },
		async (t) => {
			const root = fs.mkdtempSync(
					path.join(os.tmpdir(), "cap-fallback-report-"),
				),
				directory = path.join(root, "walk"),
				project = path.join(root, "source.cap"),
				segment = path.join(project, "content/segments/segment-0");
			fs.mkdirSync(segment, { recursive: true });
			fs.mkdirSync(directory);
			const save = (file, value) =>
					fs.writeFileSync(file, JSON.stringify(value)),
				file = path.join(directory, "native-walk.json");
			save(path.join(project, "recording-meta.json"), {
				status: { status: "Complete" },
			});
			fs.writeFileSync(
				path.join(segment, "audio-input.ogg"),
				"unsupported synthetic source",
			);
			save(file, {
				schemaVersion: 1,
				state: "complete",
				startedAtMs: 1000,
				durationMs: 2000,
				sourceProject: project,
				request: {
					directory,
					topic: "Unsupported tail",
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
			const upload = gate(),
				entered = gate(),
				exportEntered = gate(),
				exportGate = gate();
			let submissions = 0,
				exports = 0,
				worker,
				preparation;
			const previous = global.fetch;
			global.fetch = async () => {
				throw Error("Real network forbidden");
			};
			t.after(async () => {
				upload.release();
				exportGate.release();
				await Promise.allSettled([worker, preparation].filter(Boolean));
				global.fetch = previous;
				fs.rmSync(root, { recursive: true, force: true });
			});
			const cfg = {
				transcriber: "elevenlabs",
				glossary: "",
				brief: false,
				sections: false,
			};
			const dependencies = {
				client: {
					export: async (_project, output) => {
						exports++;
						exportEntered.release();
						if (slowVideo) await exportGate.promise;
						fs.writeFileSync(output, "export");
						return { durationS: 2 };
					},
				},
				prepareAudio: async () => null,
				processChapter: async (directory, config) => {
					const srt = path.join(directory, "transcript.srt");
					if (config.transcriber !== "none" && !fs.existsSync(srt)) {
						submissions++;
						fs.writeFileSync(
							srt,
							"1\n00:00:00,000 --> 00:00:01,000\nStop-time fallback\n",
						);
					}
					return { transcript: fs.existsSync(srt) };
				},
				writeIndex: () => {},
				writeReport: () => {},
			};
			worker = runCheckpointWorker(file, cfg, {
				reconcileWaitMs: slowVideo ? 20 : 150000,
				reconcileReport: (file, cfg, options) =>
					finishNativeWalk(file, cfg, { ...dependencies, ...options }),
				transport: {
					status: async () => ({
						backupEnabled: true,
						server: "https://synthetic.invalid",
					}),
					request: async (_method, resource, options) => {
						entered.release();
						await upload.promise;
						const bytes = fs.readFileSync(options.input);
						if (resource.includes("/objects/"))
							return { sha256: sha256(bytes), size: bytes.length };
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
							expiresAt: Date.now() + 60000,
						};
					},
				},
			});
			await entered.promise;
			preparation = finishNativeWalk(file, cfg, dependencies);
			await exportEntered.promise;
			if (slowVideo) {
				upload.release();
				await worker;
				exportGate.release();
				await preparation;
			} else {
				await preparation;
				assert.equal(
					JSON.parse(fs.readFileSync(path.join(directory, "processing.json")))
						.transcript,
					"partial",
				);
				assert.equal(submissions, 0);
				upload.release();
				await worker;
			}
			assert.equal(
				JSON.parse(fs.readFileSync(path.join(directory, "processing.json")))
					.transcript,
				"ready",
			);
			assert.equal(submissions, 1);
			assert.equal(exports, 1);
			await finishNativeWalk(file, cfg, dependencies);
			assert.equal(submissions, 1);
			assert.equal(exports, 1);
		},
	);
