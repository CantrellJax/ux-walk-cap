import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
	CompanionSession,
	requestCompanion,
	startCompanionServer,
} from "../../src/companion.mjs";

const clientId = "profile-client-123456789";
const identity = {
	recordingId: "recording-one",
	generation: "generation-one",
	clientId,
};
const tab = {
	tabId: 42,
	windowId: 5,
	documentId: "document-one",
	url: "https://meet.google.com/abc-defg-hij",
	title: "Meet",
};
function fixture() {
	let state = "recording",
		flushed = 0,
		persisted = 0;
	const saved = [],
		metadata = {};
	const session = new CompanionSession({
		...identity,
		backend: "cap",
		mode: "external",
		metadata,
		state: () => state,
		clock: () => 5000,
		write: async (e) => {
			saved.push(e);
			return true;
		},
		flush: async () => {
			flushed++;
		},
		persist: async () => {
			persisted++;
		},
	});
	const attach = (role = "meet", changes = {}) =>
		session.handle({
			type: "companion-attach",
			...identity,
			...tab,
			role,
			...changes,
		});
	const send = (binding, changes = {}) =>
		session.handle({
			type: "companion-events",
			...binding,
			events: [
				{
					eventId: "event-one",
					observedAt: 4000,
					kind: "caption",
					captionId: "caption-one",
					name: "Clay",
					text: "Check this field",
					revision: 1,
				},
			],
			...changes,
		});
	return {
		session,
		saved,
		metadata,
		attach,
		send,
		state: (value) => {
			state = value;
		},
		counts: () => ({ flushed, persisted }),
	};
}
test("two explicit roles reject wrong session/profile/tab/document/origin/meeting and never accept unbound captions", async () => {
	const h = fixture();
	await assert.rejects(
		h.send({ ...identity, ...tab, role: "meet", bindingId: "unbound" }),
		/bound|selected/i,
	);
	const meet = await h.attach();
	const walk = await h.attach("walkthrough", {
		tabId: 8,
		documentId: "walk-document",
		url: "https://example.test/",
	});
	assert.notEqual(meet.bindingId, walk.bindingId);
	for (const change of [
		{ recordingId: "other" },
		{ generation: "other" },
		{ clientId: "other-profile-123456" },
		{ tabId: 99 },
		{ documentId: "other" },
		{ url: "https://example.test/" },
		{ url: "https://meet.google.com/xyz-abcd-efg" },
	])
		await assert.rejects(h.send({ ...meet, ...change }));
	assert.equal(h.saved.length, 0);
});
test("durable ACK follows flush/persist, retries deduplicate, changed payload under same ID fails", async () => {
	const h = fixture(),
		b = await h.attach();
	const ack = await h.send(b);
	assert.deepEqual(ack.eventIds, ["event-one"]);
	assert.equal(h.saved.length, 1);
	assert.ok(h.counts().flushed > 0);
	assert.ok(h.counts().persisted > 1);
	await h.send(b);
	assert.equal(h.saved.length, 1);
	await assert.rejects(
		h.send(b, {
			events: [
				{
					eventId: "event-one",
					observedAt: 4000,
					kind: "caption",
					captionId: "caption-one",
					name: "Clay",
					text: "changed",
					revision: 1,
				},
			],
		}),
		/identity|changed/i,
	);
});
test("paused/finishing and oversize/malformed events never append; stopping a role remains possible", async () => {
	const h = fixture(),
		b = await h.attach();
	for (const state of ["paused", "finishing", "idle"]) {
		h.state(state);
		await assert.rejects(h.send(b));
		await assert.rejects(h.attach());
	}
	h.state("recording");
	for (const events of [
		[
			{
				eventId: "too-big",
				kind: "caption",
				observedAt: 4000,
				captionId: "a",
				name: "A",
				text: "x".repeat(8001),
			},
		],
		[
			{
				eventId: "negative-time",
				observedAt: -1,
				kind: "caption",
				captionId: "a",
				name: "A",
				text: "x",
			},
		],
		[{ eventId: "unknown", observedAt: 4000, kind: "debug", secrets: "NO" }],
	])
		await assert.rejects(h.send(b, { events }));
	assert.equal(h.saved.length, 0);
	h.state("paused");
	await h.session.handle({ type: "companion-detach", ...b });
});
test("authenticated bounded local ingress publishes one owner and rejects other tokens/owners", async (t) => {
	const configDir = fs.mkdtempSync("/tmp/uxw-companion-contract-");
	t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));
	const h = fixture(),
		server = await startCompanionServer({ configDir, session: h.session });
	t.after(() => server.close());
	const descriptor = JSON.parse(
		fs.readFileSync(path.join(configDir, "companion-session.json")),
	);
	const status = await requestCompanion(descriptor, {
		type: "companion-hello",
		clientId,
	});
	assert.equal(status.recordingId, identity.recordingId);
	await assert.rejects(
		requestCompanion(
			{ ...descriptor, token: "0".repeat(64) },
			{ type: "companion-hello", clientId },
		),
		/auth/i,
	);
	await assert.rejects(
		startCompanionServer({ configDir, session: fixture().session }),
		/owner|active/i,
	);
});
test("simultaneous recorders cannot publish competing owners", async (t) => {
	const configDir = fs.mkdtempSync("/tmp/uxw-owner-race-");
	t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));
	const attempts = await Promise.allSettled([
		startCompanionServer({ configDir, session: fixture().session }),
		startCompanionServer({ configDir, session: fixture().session }),
	]);
	const live = attempts.filter((result) => result.status === "fulfilled");
	assert.equal(live.length, 1);
	await live[0].value.close();
});

test("same-generation and pause-epoch delayed observations remain saveable after a bridge outage", async () => {
	const h = fixture(),
		binding = await h.attach();
	h.session.options.clock = () => 45000;
	const receipt = await h.send(binding);
	assert.equal(receipt.acknowledged, true);
	assert.equal(h.saved.length, 1);
	assert.equal(h.saved[0].observedAt, 4000);
	assert.equal(h.saved[0].timingUncertain, true);
});
