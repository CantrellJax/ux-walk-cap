import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const now = 100000;
async function render(changes = {}) {
	const elements = Object.fromEntries(
		[
			"status",
			"error",
			"walkthrough",
			"meet",
			"captions",
			"backup",
			"audio",
		].map((id) => [id, { textContent: "" }]),
	);
	const state = {
		connection: "connected",
		state: "recording",
		recording: true,
		roles: { meet: { title: "Selected Meet" } },
		queued: 0,
		audio: { microphone: "on", systemAudio: "on", updatedAt: now },
		backup: {
			enabled: true,
			journalThroughMs: 60000,
			eventState: "current",
			audioState: "current",
			updatedAt: now,
		},
		...changes,
	};
	vm.runInNewContext(
		fs.readFileSync(
			new URL("../../extension/popup.js", import.meta.url),
			"utf8",
		),
		{
			document: {
				querySelectorAll: () => [],
				getElementById: (id) => elements[id],
			},
			chrome: {
				tabs: {
					query: async () => [
						{ id: 1, windowId: 1, url: "https://meet.google.com/abc-defg-hij" },
					],
				},
				runtime: { sendMessage: async () => state },
			},
			Date: { now: () => now },
			setInterval: () => {},
		},
	);
	await new Promise((resolve) => setImmediate(resolve));
	return elements;
}
test("popup names selected audio and reports notes, event and audio backup separately", async () => {
	let elements = await render();
	assert.match(elements.audio.textContent, /Mic: on.*Computer audio: on/);
	assert.match(elements.backup.textContent, /Notes backed up through 1:00/);
	assert.match(
		elements.backup.textContent,
		/Tab and Meet evidence: current at last check/,
	);
	assert.match(
		elements.backup.textContent,
		/Saved audio: current at last check/,
	);
	elements = await render({
		audio: { microphone: "on", systemAudio: "off", updatedAt: now },
	});
	assert.match(elements.audio.textContent, /Computer audio: off/);
	assert.match(elements.audio.textContent, /Meet speech.*computer audio/);
	elements = await render({ queued: 1 });
	assert.doesNotMatch(elements.backup.textContent, /evidence: current/);
	elements = await render({
		backup: {
			enabled: true,
			journalThroughMs: 60000,
			eventState: "waiting",
			audioState: "waiting",
			updatedAt: now,
		},
	});
	assert.match(elements.backup.textContent, /Notes backed up through 1:00/);
	assert.match(elements.backup.textContent, /evidence: waiting/);
	assert.match(elements.backup.textContent, /audio: waiting/);
});
test("popup never presents stale, missing, future or disconnected status as confirmed backup", async () => {
	for (const updatedAt of [undefined, 80000, 102000]) {
		const elements = await render({
			audio: { microphone: "on", systemAudio: "on", updatedAt },
			backup: {
				enabled: true,
				journalThroughMs: 60000,
				eventState: "current",
				audioState: "current",
				updatedAt,
			},
		});
		assert.match(elements.audio.textContent, /Mic: unconfirmed/);
		assert.doesNotMatch(
			elements.backup.textContent,
			/backed up through|current at last check/,
		);
	}
	let elements = await render({ connection: "disconnected" });
	assert.doesNotMatch(
		elements.backup.textContent,
		/backed up through|current at last check/,
	);
	assert.match(elements.audio.textContent, /unconfirmed/);
	elements = await render({
		backup: {
			enabled: true,
			journalThroughMs: 0,
			eventState: "none",
			audioState: "not-selected",
			updatedAt: now,
		},
	});
	assert.doesNotMatch(elements.backup.textContent, /0:00|current/);
	assert.match(elements.backup.textContent, /none saved yet/);
});
