import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CheckpointWorker } from "./checkpoint-worker.mjs";
import { restoreRecovery } from "./restore-checkpoint.mjs";

test(
	"collector-only child and actual host frames share one durable recoverable session without browser or video",
	{ timeout: 15000 },
	async (t) => {
		const root = fs.mkdtempSync("/tmp/cap-companion-protocol-");
		t.after(() => fs.rmSync(root, { recursive: true, force: true }));
		const configDir = path.join(root, "config"),
			captureId = randomUUID(),
			work = path.join(root, "walk-browser", captureId),
			directory = path.join(root, "walk"),
			project = path.join(root, "source.cap");
		for (const folder of [configDir, work, directory, project])
			fs.mkdirSync(folder, { recursive: true });
		const file = path.join(directory, "native-walk.json"),
			startedAtMs = Date.now();
		fs.writeFileSync(
			file,
			JSON.stringify({
				schemaVersion: 1,
				state: "recording",
				startedAtMs,
				sourceProject: project,
				request: { directory, topic: "Synthetic Meet", speakers: [] },
				events: [],
				durationMs: null,
			}),
		);
		const env = { ...process.env, CAP_UX_WALK_CONFIG_DIR: configDir };
		const child = spawn(
			process.execPath,
			[
				fileURLToPath(new URL("./native-browser.mjs", import.meta.url)),
				captureId,
				work,
				"--external",
			],
			{ env, stdio: ["pipe", "pipe", "pipe"] },
		);
		t.after(() => {
			child.kill();
		});
		const pending = new Map();
		let readyResolve, readyReject;
		const ready = new Promise((resolve, reject) => {
			readyResolve = resolve;
			readyReject = reject;
		});
		let errors = "";
		child.stderr.on("data", (data) => {
			errors += data;
		});
		child.on("exit", (code) => {
			if (code) readyReject(new Error(errors || `Collector exited ${code}`));
		});
		readline.createInterface({ input: child.stdout }).on("line", (line) => {
			const response = JSON.parse(line);
			if (response.ready !== undefined) {
				if (response.ready) readyResolve(response);
				else readyReject(new Error(response.error));
			} else {
				const waiter = pending.get(response.id);
				pending.delete(response.id);
				if (response.ok) waiter?.resolve(response);
				else waiter?.reject(new Error(response.error));
			}
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
		await command("bind-external", { windowId: "55" });
		await command("start", { file, windowId: "55" });
		const engine =
			process.env.CAP_UX_TEST_ENGINE_DIR ||
			fileURLToPath(new URL("../../../vendor/ux-walk/", import.meta.url));
		const request = (message) => {
			const body = Buffer.from(
					JSON.stringify({ ...message, requestId: randomUUID() }),
				),
				header = Buffer.alloc(4);
			header.writeUInt32LE(body.length);
			const result = spawnSync(
				process.execPath,
				[
					path.join(engine, "bin/uxw-meet-host"),
					"chrome-extension://lcdckhfbhjchfjnnnkmcbjnefdnapelh/",
				],
				{ env, input: Buffer.concat([header, body]), timeout: 5000 },
			);
			assert.equal(result.status, 0, result.stderr.toString());
			assert.equal(result.stdout.readUInt32LE(0), result.stdout.length - 4);
			return JSON.parse(result.stdout.subarray(4));
		};
		const clientId = "synthetic-profile-123456",
			hello = request({ type: "companion-hello", clientId });
		assert.equal(hello.browserMode, "external");
		const bound = request({
			type: "companion-attach",
			clientId,
			recordingId: hello.recordingId,
			generation: hello.generation,
			role: "meet",
			tabId: 3,
			windowId: 5,
			documentId: "synthetic-doc",
			url: "https://meet.google.com/abc-defg-hij",
		}).result;
		const event = {
			eventId: "actual-host-caption",
			kind: "caption",
			observedAt: Date.now(),
			captionId: "turn-one",
			revision: 1,
			name: "Fixture Name",
			text: "Recover this meeting evidence",
		};
		const message = { type: "companion-events", ...bound, events: [event] };
		assert.equal(
			request({ ...message, documentId: "wrong-document" }).ok,
			false,
		);
		assert.equal(request(message).result.acknowledged, true);
		assert.equal(request(message).result.acknowledged, true);
		assert.equal(
			fs
				.readFileSync(path.join(directory, "browser-evidence.jsonl"), "utf8")
				.trim()
				.split("\n").length,
			1,
		);
		const delayed = {
			...event,
			eventId: "delayed-caption",
			captionId: "delayed-turn",
			observedAt: Date.now() - 45000,
			text: "Preserve late evidence",
		};
		assert.equal(
			request({ ...message, events: [delayed] }).result.acknowledged,
			true,
		);
		const savedLate = JSON.parse(
			fs
				.readFileSync(path.join(directory, "browser-evidence.jsonl"), "utf8")
				.trim()
				.split("\n")
				.at(-1),
		);
		assert.equal(savedLate.observedAt, delayed.observedAt);
		assert.equal(savedLate.timingUncertain, true);
		await command("clock", {
			file,
			wallMs: Date.now(),
			offsetMs: 1000,
			paused: true,
		});
		assert.equal(request(message).ok, false);
		await command("clock", {
			file,
			wallMs: Date.now(),
			offsetMs: 1000,
			paused: false,
		});
		assert.equal(request(message).ok, false);
		await command("finishing", { file, wallMs: Date.now(), offsetMs: 2000 });
		assert.equal(
			request({ type: "companion-hello", clientId }).state,
			"finishing",
		);
		fs.writeFileSync(
			path.join(directory, "checkpoint-heartbeat.json"),
			JSON.stringify({
				generation: 1,
				parentPid: process.pid,
				activeElapsedMs: 2000,
				wallMs: Date.now(),
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
		const destination = path.join(root, "restored"),
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
						startedAtMs,
						checkpoints: worker.store.descriptors(),
					};
				},
			},
			recordingId,
			destination,
		);
		assert.match(
			fs.readFileSync(path.join(destination, "meet.jsonl"), "utf8"),
			/Fixture Name/,
		);
		assert.ok(
			fs
				.readFileSync(path.join(destination, "meet.jsonl"), "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
				.some(
					(caption) =>
						caption.text === "Preserve late evidence" &&
						caption.timingUncertain,
				),
		);
		assert.match(
			fs.readFileSync(path.join(destination, "report.html"), "utf8"),
			/Recover this meeting evidence/,
		);
		assert.equal(fs.existsSync(path.join(destination, "video.mp4")), false);
		await command("stop", { file });
		assert.equal(
			fs.existsSync(path.join(configDir, "companion-session.json")),
			false,
		);
		child.stdin.end();
		await new Promise((resolve) => child.once("exit", resolve));
	},
);
