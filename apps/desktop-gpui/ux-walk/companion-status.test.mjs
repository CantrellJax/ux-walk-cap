import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { NativeBrowserEvidence } from "./native-browser.mjs";

test("companion status distinguishes selected audio and acknowledged notes, events and audio", async (t) => {
	const root = fs.mkdtempSync("/tmp/cap-companion-status-");
	const directory = path.join(root, "walk"),
		sourceProject = path.join(root, "source.cap"),
		file = path.join(directory, "native-walk.json");
	fs.mkdirSync(directory);
	fs.mkdirSync(sourceProject);
	fs.mkdirSync(path.join(directory, "checkpoints"));
	fs.writeFileSync(
		file,
		JSON.stringify({
			schemaVersion: 1,
			state: "recording",
			startedAtMs: 1000,
			sourceProject,
			request: { directory, topic: "Status", speakers: [] },
			events: [],
		}),
	);
	const evidence = new NativeBrowserEvidence(
		"11111111-1111-4111-8111-111111111111",
		path.join(root, "work"),
		() => 100000,
	);
	evidence.windowId = "55";
	evidence.start(file, "55", { mode: "external" });
	t.after(() => {
		evidence.finish(file, "failed");
		clearInterval(evidence.flushTimer);
		fs.rmSync(root, { recursive: true, force: true });
	});
	const identity = {
		recordingId: "backup-recording",
		generation: "backup-generation",
	};
	fs.writeFileSync(
		path.join(directory, "checkpoints/identity.json"),
		JSON.stringify(identity),
	);
	const heartbeat = {
		schemaVersion: 1,
		parentPid: process.ppid,
		generation: 1,
		wallMs: 100000,
		activeElapsedMs: 99000,
		paused: false,
		expectedAudio: { microphone: true, systemAudio: true },
	};
	const status = {
		schemaVersion: 1,
		...identity,
		backupEnabled: true,
		remoteClockThroughMs: 60000,
		events: { readableBytes: 100, durableBytes: 100, remoteBytes: 100 },
		sources: {
			"segment-0:microphone": { durableSourceMs: 2000, remoteSourceMs: 2000 },
			"segment-0:systemAudio": { durableSourceMs: 2000, remoteSourceMs: 2000 },
		},
		waitingSources: [],
		sourceErrors: {},
		updatedAt: 100000,
	};
	const read = async (
		changeHeartbeat = (value) => value,
		changeStatus = (value) => value,
		removeHeartbeat = false,
	) => {
		fs.writeFileSync(
			path.join(directory, "checkpoint-heartbeat.json"),
			JSON.stringify(changeHeartbeat(structuredClone(heartbeat))),
		);
		if (removeHeartbeat)
			fs.unlinkSync(path.join(directory, "checkpoint-heartbeat.json"));
		fs.writeFileSync(
			path.join(directory, "checkpoint-status.json"),
			JSON.stringify(changeStatus(structuredClone(status))),
		);
		return evidence
			.companion()
			.handle({ type: "companion-hello", clientId: "profile-client-123456" });
	};
	let result = await read();
	assert.equal(result.audio.microphone, "on");
	assert.equal(result.audio.systemAudio, "on");
	assert.equal(result.backup.journalThroughMs, 60000);
	assert.equal(result.backup.eventState, "current");
	assert.equal(result.backup.audioState, "current");
	result = await read((value) => ({
		...value,
		expectedAudio: { microphone: true, systemAudio: false },
	}));
	assert.equal(result.audio.systemAudio, "off");
	for (const wallMs of [80000, 102000]) {
		result = await read((value) => ({ ...value, wallMs }));
		assert.equal(result.audio.microphone, "unconfirmed");
	}
	result = await read((value) => ({ ...value, parentPid: 2147483647 }));
	assert.equal(result.audio.microphone, "unconfirmed");
	result = await read(
		(value) => value,
		(value) => value,
		true,
	);
	assert.equal(result.audio.systemAudio, "unconfirmed");
	for (const updatedAt of [80000, 102000]) {
		result = await read(
			(value) => value,
			(value) => ({ ...value, updatedAt }),
		);
		assert.equal(result.backup.eventState, "unconfirmed");
		assert.equal(result.backup.audioState, "unconfirmed");
		assert.equal(result.backup.journalThroughMs, undefined);
	}
	result = await read(
		(value) => value,
		(value) => ({ ...value, recordingId: "foreign" }),
	);
	assert.equal(result.backup.eventState, "unconfirmed");
	result = await read(
		(value) => value,
		(value) => ({
			...value,
			events: { readableBytes: 100, durableBytes: 100, remoteBytes: 50 },
		}),
	);
	assert.equal(result.backup.journalThroughMs, 60000);
	assert.equal(result.backup.eventState, "waiting");
	result = await read(
		(value) => value,
		(value) => ({
			...value,
			events: { readableBytes: 0, durableBytes: 0, remoteBytes: 0 },
		}),
	);
	assert.equal(result.backup.eventState, "none");
	result = await read(
		(value) => value,
		(value) => {
			value.sources["segment-0:systemAudio"].remoteSourceMs = 1000;
			return value;
		},
	);
	assert.equal(result.backup.audioState, "waiting");
	result = await read(
		(value) => value,
		(value) => ({
			...value,
			sources: {},
			waitingSources: ["microphone", "systemAudio"],
		}),
	);
	assert.equal(result.backup.audioState, "waiting");
	result = await read((value) => ({
		...value,
		expectedAudio: { microphone: false, systemAudio: false },
	}));
	assert.equal(result.backup.audioState, "not-selected");
	result = await read(
		(value) => value,
		(value) => ({
			...value,
			sourceErrors: { "segment-0:systemAudio": "unavailable" },
		}),
	);
	assert.equal(result.backup.audioState, "attention");
});
