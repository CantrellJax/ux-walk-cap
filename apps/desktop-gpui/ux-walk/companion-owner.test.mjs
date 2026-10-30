import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { projectBrowserEvidence } from "./browser-evidence.mjs";
import { NativeBrowserEvidence } from "./native-browser.mjs";

test("external evidence owner durably accepts bound Meet captions, projects pause clock, and preserves source evidence without video", async (t) => {
	const root = fs.mkdtempSync("/tmp/cap-companion-owner-");
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const work = path.join(root, "work"),
		directory = path.join(root, "walk");
	fs.mkdirSync(directory);
	const file = path.join(directory, "native-walk.json"),
		project = path.join(root, "source.cap");
	fs.mkdirSync(project);
	const journal = {
		schemaVersion: 1,
		state: "recording",
		startedAtMs: 1000,
		request: { directory, topic: "Synthetic", speakers: [] },
		sourceProject: project,
		events: [],
		durationMs: null,
	};
	fs.writeFileSync(file, JSON.stringify(journal));
	let now = 1000;
	const evidence = new NativeBrowserEvidence(
		"11111111-1111-4111-8111-111111111111",
		work,
		() => now,
	);
	evidence.windowId = "55";
	evidence.start(file, "55", { mode: "external" });
	assert.equal(
		evidence.write({
			ev: "meet-caption",
			source: "chrome-extension",
			observedAt: 1000,
			name: "Unbound",
			text: "Must not persist",
			companion: { role: "meet" },
		}),
		false,
	);
	t.after(() => {
		if (evidence.active) evidence.finish(file, "failed");
	});
	const session = evidence.companion();
	const hello = await session.handle({
		type: "companion-hello",
		clientId: "profile-client-123456",
	});
	const b = await session.handle({
		type: "companion-attach",
		recordingId: hello.recordingId,
		generation: hello.generation,
		clientId: "profile-client-123456",
		role: "meet",
		tabId: 9,
		windowId: 3,
		documentId: "meet-doc",
		url: "https://meet.google.com/abc-defg-hij",
	});
	now = 2000;
	await session.handle({
		type: "companion-events",
		...b,
		events: [
			{
				eventId: "caption-1",
				observedAt: 2000,
				kind: "caption",
				name: "Clay",
				text: "Before pause",
				captionId: "turn-1",
				revision: 1,
			},
		],
	});
	evidence.anchor(file, 2000, 1000, true);
	now = 7000;
	await assert.rejects(
		session.handle({
			type: "companion-events",
			...b,
			events: [
				{
					eventId: "paused",
					observedAt: 7000,
					kind: "caption",
					name: "Wrong",
					text: "Excluded",
					captionId: "turn-x",
					revision: 1,
				},
			],
		}),
	);
	evidence.anchor(file, 7000, 1000, false);
	now = 8000;
	await assert.rejects(
		session.handle({
			type: "companion-events",
			...b,
			events: [
				{
					eventId: "old-epoch",
					observedAt: 8000,
					kind: "caption",
					name: "Wrong",
					text: "Stale queue",
					captionId: "turn-x",
					revision: 1,
				},
			],
		}),
	);
	const resumed = await session.handle({
		type: "companion-hello",
		clientId: b.clientId,
	});
	await session.handle({
		type: "companion-events",
		...b,
		clockEpoch: resumed.clockEpoch,
		events: [
			{
				eventId: "caption-2",
				observedAt: 8000,
				kind: "caption",
				name: "Jackson",
				text: "After pause",
				captionId: "turn-2",
				revision: 1,
			},
		],
	});
	evidence.finish(file);
	const projected = projectBrowserEvidence(file, {
		...journal,
		durationMs: 3000,
	});
	const captions = projected.events.filter(
		(event) => event.ev === "meet-caption",
	);
	assert.deepEqual(
		captions.map((event) => [event.name, event.t]),
		[
			["Clay", 2000],
			["Jackson", 3000],
		],
	);
	assert.equal(captions[1].observedAt, 8000);
	assert.match(projected.coverage.console, /not captured/i);
	assert.equal(
		fs.existsSync(path.join(directory, "browser-evidence.jsonl")),
		true,
	);
	assert.equal(fs.existsSync(path.join(directory, "video.mp4")), false);
});

test("wall-clock corrections and delayed captions preserve original observation time without claiming reliable attribution", async (t) => {
	const root = fs.mkdtempSync("/tmp/cap-companion-clock-");
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const directory = path.join(root, "walk"),
		project = path.join(root, "source.cap"),
		file = path.join(directory, "native-walk.json");
	fs.mkdirSync(directory);
	fs.mkdirSync(project);
	const journal = {
		schemaVersion: 1,
		state: "recording",
		startedAtMs: 1000,
		request: { directory, topic: "Clock", speakers: [] },
		sourceProject: project,
		events: [],
		durationMs: null,
	};
	fs.writeFileSync(file, JSON.stringify(journal));
	let now = 1000;
	const evidence = new NativeBrowserEvidence(
		"22222222-2222-4222-8222-222222222222",
		path.join(root, "work"),
		() => now,
	);
	evidence.windowId = "55";
	evidence.start(file, "55", { mode: "external" });
	t.after(() => {
		if (evidence.active) evidence.finish(file, "failed");
	});
	const session = evidence.companion(),
		hello = await session.handle({
			type: "companion-hello",
			clientId: "clock-profile-123456",
		});
	const binding = await session.handle({
		...hello,
		type: "companion-attach",
		clientId: "clock-profile-123456",
		role: "meet",
		tabId: 4,
		windowId: 2,
		documentId: "clock-document",
		url: "https://meet.google.com/abc-defg-hij",
	});
	now = 500;
	evidence.anchor(file, 500, 1000, false);
	await session.handle({
		type: "companion-events",
		...binding,
		events: [
			{
				eventId: "clock-adjusted",
				observedAt: 5000,
				kind: "caption",
				captionId: "turn-one",
				revision: 1,
				name: "Unconfirmed",
				text: "Wall time changed",
			},
		],
	});
	const saved = JSON.parse(
		fs.readFileSync(path.join(directory, "browser-evidence.jsonl"), "utf8"),
	);
	assert.equal(saved.observedAt, 5000);
	assert.equal(saved.receivedAt, 500);
	assert.equal(saved.nativeOffsetMs, 1000);
	assert.equal(saved.timingUncertain, true);
	evidence.finish(file);
	const projected = projectBrowserEvidence(file, {
		...journal,
		durationMs: 2000,
	});
	assert.equal(projected.events[0].t, 2000);
	assert.equal(projected.events[0].timingUncertain, true);
});
