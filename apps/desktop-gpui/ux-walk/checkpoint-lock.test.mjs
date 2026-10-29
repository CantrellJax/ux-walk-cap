import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

async function childMain() {
	const fs = (await import("node:fs")).default;
	const path = (await import("node:path")).default;
	const { pathToFileURL } = await import("node:url");
	const [role, kind, directory, source, scope = "checkpoint", alias = ""] =
		process.argv.slice(2);
	const walk = path.join(directory, "walk");
	const read = fs.readFileSync.bind(fs),
		write = fs.writeFileSync.bind(fs),
		rename = fs.renameSync.bind(fs);
	const marker = (name) => path.join(directory, name + ".json");
	const mark = (name, value = {}) =>
		write(marker(name), JSON.stringify({ ...value, pid: process.pid }));
	const wait = (name) => {
		const deadline = Date.now() + 10000;
		while (!fs.existsSync(marker(name))) {
			if (Date.now() > deadline) throw new Error("Barrier timed out: " + name);
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
		}
	};
	const target = path.join(
		walk,
		kind === "process"
			? ".processing-lock/owner.json"
			: ".checkpoint-worker/owner.json",
	);
	let sawStale = false;
	fs.readFileSync = (file, ...args) => {
		const bytes = read(file, ...args);
		if (
			process.env.LOCK_RACE === "1" &&
			typeof file === "string" &&
			path.resolve(file) === target &&
			!sawStale
		) {
			let owner;
			try {
				owner = JSON.parse(bytes);
			} catch {}
			if (owner?.pid === Number(process.env.LOCK_DEAD_PID)) {
				sawStale = true;
				mark("read-" + role);
				if (role === "A") {
					const end = Date.now() + 10000;
					while (
						!fs.existsSync(marker("read-B")) &&
						!fs.existsSync(marker("done-B"))
					) {
						if (Date.now() > end) throw new Error("Contender did not decide");
						Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
					}
				} else wait("entered-A");
			}
		}
		return bytes;
	};
	const ownerWritten = (to) => {
		if (path.resolve(String(to)) === target && kind === "full") {
			mark("entered-" + role);
			wait("release-" + role);
		}
	};
	fs.renameSync = (from, to, ...args) => {
		const result = rename(from, to, ...args);
		ownerWritten(to);
		return result;
	};
	fs.writeFileSync = (file, ...args) => {
		const result = write(file, ...args);
		if (typeof file === "string") ownerWritten(file);
		return result;
	};
	try {
		if (kind === "lease") {
			const { acquireWalkLock } = await import(
				pathToFileURL(path.join(source, "walk-lock.mjs"))
			);
			const lease = await acquireWalkLock(alias || walk, scope);
			mark("entered-" + role);
			wait("release-" + role);
			await lease.release();
		} else if (kind === "worker") {
			const { CheckpointStore } = await import(
				pathToFileURL(path.join(source, "checkpoint-store.mjs"))
			);
			const commit = CheckpointStore.prototype.commit;
			CheckpointStore.prototype.commit = function (...args) {
				const result = commit.apply(this, args);
				mark("committed-" + role, { sequence: result.sequence });
				return result;
			};
			const { runCheckpointWorker } = await import(
				pathToFileURL(path.join(source, "checkpoint-worker.mjs"))
			);
			await runCheckpointWorker(
				path.join(walk, "native-walk.json"),
				{ transcriber: "none" },
				{
					transport: {
						status: async () => {
							mark("entered-" + role);
							wait("release-" + role);
							return { backupEnabled: false, server: "" };
						},
					},
				},
			);
		} else {
			const { finishNativeWalk } = await import(
				pathToFileURL(path.join(source, "native-walk.mjs"))
			);
			await finishNativeWalk(
				path.join(walk, "native-walk.json"),
				{ transcriber: "none", brief: false },
				{
					fullTranscription: kind === "full",
					client: {
						export: async () => {
							mark("entered-" + role);
							wait("release-" + role);
							throw new Error("Synthetic exporter stop");
						},
					},
					writeIndex: () => {},
					writeReport: () => {},
				},
			);
		}
		mark("done-" + role, { ok: true });
	} catch (error) {
		mark("done-" + role, { ok: false, error: error.message, code: error.code });
	}
}

const source = fileURLToPath(new URL(".", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function fixture(t) {
	const directory = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "uxw-exclusive-")),
	);
	const walk = path.join(directory, "walk"),
		project = path.join(directory, "source.cap");
	fs.mkdirSync(walk);
	fs.mkdirSync(project);
	fs.writeFileSync(
		path.join(project, "recording-meta.json"),
		JSON.stringify({ status: { status: "Complete" } }),
	);
	fs.writeFileSync(path.join(project, "source.mp4"), "synthetic non-media");
	fs.writeFileSync(
		path.join(walk, "native-walk.json"),
		JSON.stringify({
			schemaVersion: 1,
			state: "complete",
			request: { directory: walk, topic: "Synthetic", url: "", speakers: [] },
			sourceProject: project,
			startedAtMs: 100000,
			durationMs: 1000,
			events: [],
		}),
	);
	fs.writeFileSync(
		path.join(walk, "checkpoint-heartbeat.json"),
		JSON.stringify({
			activeElapsedMs: 1000,
			wallMs: 101000,
			paused: true,
			captureEnded: true,
			parentPid: process.pid,
			generation: 1,
			expectedAudio: { microphone: false, systemAudio: false },
		}),
	);
	const child = path.join(directory, "child.mjs");
	fs.writeFileSync(child, `(${childMain.toString()})()`);
	const processes = [];
	const file = (name) => path.join(directory, name + ".json");
	const read = (name) => JSON.parse(fs.readFileSync(file(name), "utf8"));
	const release = (role) => fs.writeFileSync(file("release-" + role), "{}");
	t.after(async () => {
		for (const role of ["A", "B"]) release(role);
		for (const item of processes)
			if (item.exitCode == null && !item.signalCode) item.kill("SIGKILL");
		await Promise.all(
			processes.map((item) =>
				item.exitCode != null || item.signalCode
					? null
					: new Promise((resolve) => item.once("exit", resolve)),
			),
		);
		fs.rmSync(directory, { recursive: true, force: true });
	});
	return {
		directory,
		walk,
		file,
		read,
		release,
		async wait(name) {
			const end = Date.now() + 10000;
			while (!fs.existsSync(file(name))) {
				if (Date.now() > end) throw new Error("Missing child event: " + name);
				await sleep(5);
			}
			return read(name);
		},
		async decide(role) {
			const end = Date.now() + 10000;
			while (
				!fs.existsSync(file("entered-" + role)) &&
				!fs.existsSync(file("done-" + role))
			) {
				if (Date.now() > end) throw new Error("Missing decision");
				await sleep(5);
			}
			return fs.existsSync(file("entered-" + role))
				? { entered: true }
				: { ...read("done-" + role), entered: false };
		},
		start(
			role,
			kind,
			{ race = false, deadPid = 0, scope = "checkpoint", alias = "" } = {},
		) {
			const output = fs.openSync(path.join(directory, role + ".log"), "w");
			const item = spawn(
				process.execPath,
				[child, role, kind, directory, source, scope, alias],
				{
					env: {
						...process.env,
						LOCK_RACE: race ? "1" : "0",
						LOCK_DEAD_PID: String(deadPid),
					},
					stdio: ["ignore", output, output],
				},
			);
			fs.closeSync(output);
			processes.push(item);
			return item;
		},
	};
}

for (const [first, second, folder] of [
	["worker", "worker", ".checkpoint-worker"],
	["full", "worker", ".checkpoint-worker"],
	["process", "process", ".processing-lock"],
])
	test(`OS ownership excludes ${first}/${second} stale-directory contenders before shared writes`, async (t) => {
		const f = fixture(t);
		const dead = spawnSync(process.execPath, ["-e", ""]);
		assert.equal(dead.status, 0);
		const marker = path.join(f.walk, folder);
		fs.mkdirSync(marker);
		fs.writeFileSync(
			path.join(marker, "owner.json"),
			JSON.stringify({ pid: dead.pid }),
		);
		const a = f.start("A", first, { race: true, deadPid: dead.pid });
		await f.wait("read-A");
		f.start("B", second, { race: true, deadPid: dead.pid });
		await f.wait("entered-A");
		const decision = await f.decide("B");
		assert.equal(
			decision.entered,
			false,
			"Both actual Node processes acquired the same operation",
		);
		assert.match(decision.error, /already|busy|collision|wait/i);
		assert.equal(
			JSON.parse(fs.readFileSync(path.join(marker, "owner.json"))).pid,
			a.pid,
		);
		f.release("A");
		await f.wait("done-A");
		assert.equal(fs.existsSync(f.file("committed-B")), false);
		assert.equal(fs.existsSync(path.join(marker, "owner.json")), false);
	});

test("processing and live checkpoint scopes can run at the same time", async (t) => {
	const f = fixture(t);
	f.start("A", "worker");
	await f.wait("entered-A");
	f.start("B", "process");
	await f.wait("entered-B");
	assert.notEqual(
		JSON.parse(
			fs.readFileSync(path.join(f.walk, ".processing-lock/owner.json")),
		).pid,
		JSON.parse(
			fs.readFileSync(path.join(f.walk, ".checkpoint-worker/owner.json")),
		).pid,
	);
	f.release("B");
	await f.wait("done-B");
	assert.ok(fs.existsSync(path.join(f.walk, ".checkpoint-worker/owner.json")));
	f.release("A");
	await f.wait("done-A");
});

test("SIGKILL releases OS ownership and realpath aliases remain exclusive", async (t) => {
	const f = fixture(t);
	const alias = path.join(f.directory, "alias");
	fs.symlinkSync(f.walk, alias, "dir");
	const a = f.start("A", "lease");
	const first = await f.decide("A");
	assert.equal(first.entered, true, first.error);
	f.start("B", "lease", { alias });
	const decision = await f.decide("B");
	assert.equal(decision.entered, false);
	assert.match(decision.error, /already|busy|collision|wait/i);
	a.kill("SIGKILL");
	await new Promise((resolve) => a.once("exit", resolve));
	const { acquireWalkLock } = await import("./walk-lock.mjs");
	const lease = await acquireWalkLock(alias, "checkpoint");
	await lease.release();
});

test("empty or malformed crash metadata recovers without clearing unknown files", async (t) => {
	const { acquireWalkLock } = await import("./walk-lock.mjs");
	for (const content of [null, "broken JSON", '{"pid":0}']) {
		const f = fixture(t);
		const directory = path.join(f.walk, ".processing-lock");
		fs.mkdirSync(directory);
		if (content !== null)
			fs.writeFileSync(path.join(directory, "owner.json"), content);
		fs.writeFileSync(path.join(directory, "keep.txt"), "unknown user content");
		const lease = await acquireWalkLock(f.walk, "processing");
		assert.equal(
			JSON.parse(fs.readFileSync(path.join(directory, "owner.json"))).pid,
			process.pid,
		);
		await lease.release();
		assert.equal(
			fs.readFileSync(path.join(directory, "keep.txt"), "utf8"),
			"unknown user content",
		);
	}
});

test("legacy live owners and an occupied OS endpoint fail closed without metadata mutation", async (t) => {
	const { acquireWalkLock, walkLockEndpoint } = await import("./walk-lock.mjs");
	const f = fixture(t);
	const directory = path.join(f.walk, ".processing-lock");
	fs.mkdirSync(directory);
	const owner = JSON.stringify({ pid: process.pid });
	fs.writeFileSync(path.join(directory, "owner.json"), owner);
	await assert.rejects(
		acquireWalkLock(f.walk, "processing"),
		/already|busy|wait/i,
	);
	assert.equal(
		fs.readFileSync(path.join(directory, "owner.json"), "utf8"),
		owner,
	);
	fs.unlinkSync(path.join(directory, "owner.json"));
	fs.rmdirSync(directory);
	const { createServer } = await import("node:net");
	const server = createServer((socket) => socket.destroy());
	await new Promise((resolve, reject) =>
		server
			.once("error", reject)
			.listen(
				{ ...walkLockEndpoint(f.walk, "processing"), exclusive: true },
				resolve,
			),
	);
	t.after(() => new Promise((resolve) => server.close(resolve)));
	await assert.rejects(
		acquireWalkLock(f.walk, "processing"),
		/already|busy|collision|wait/i,
	);
	assert.equal(fs.existsSync(directory), false);
});
