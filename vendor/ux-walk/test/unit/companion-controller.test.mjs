import assert from "node:assert/strict";
import test from "node:test";
import { createCompanionController } from "../../extension/companion-controller.js";

function fixture() {
	const memory = { local: {} },
		injected = [],
		sent = [],
		native = [];
	let number = 0,
		fail = false,
		invalidAck = false;
	const status = {
		recordingId: "record-one",
		generation: "generation-one",
		clockEpoch: 0,
		state: "recording",
		recording: true,
		browserMode: "external",
		roles: {},
	};
	const tabs = {
		1: { id: 1, windowId: 10, url: "https://example.test/" },
		2: { id: 2, windowId: 20, url: "https://meet.google.com/abc-defg-hij" },
	};
	const api = {
		storage: {
			local: {
				get: async (key) => ({ [key]: memory.local[key] }),
				set: async (data) => Object.assign(memory.local, structuredClone(data)),
			},
		},
		tabs: {
			get: async (id) => tabs[id],
			sendMessage: async (id, m, options) => {
				sent.push({ id, m, options });
				return {
					ok: true,
					data: {
						observedAt: 1000,
						context: {
							url: tabs[id].url,
							viewport: { width: 1000, height: 700 },
						},
						text: "Visible text",
					},
				};
			},
		},
		scripting: {
			executeScript: async (options) => {
				injected.push(options);
				return [{ frameId: 0, documentId: `document-${options.target.tabId}` }];
			},
		},
	};
	const callNative = async (m) => {
		native.push(m);
		if (fail) throw Error("Disconnected");
		if (m.type === "companion-hello") return structuredClone(status);
		if (m.type === "companion-attach") {
			const b = {
				...m,
				origin: new URL(m.url).origin,
				bindingId: `binding-${m.role}`,
			};
			delete b.type;
			status.roles[m.role] = b;
			return b;
		}
		if (m.type === "companion-detach") {
			delete status.roles[m.role];
			return { stopped: true };
		}
		return {
			acknowledged: !invalidAck,
			recordingId: m.recordingId,
			generation: m.generation,
			eventIds: m.events.map((e) => e.eventId),
		};
	};
	const controller = createCompanionController({
		api,
		callNative,
		uuid: () => `identity-${++number}-abcdefghijkl`,
	});
	return {
		controller,
		api,
		callNative,
		memory,
		injected,
		sent,
		native,
		status,
		fail: (value) => {
			fail = value;
		},
		invalidAck: (value) => {
			invalidAck = value;
		},
	};
}
const caption = {
	type: "companion-observed",
	role: "meet",
	clockEpoch: 0,
	data: {
		observedAt: 1000,
		kind: "caption",
		name: "Clay",
		text: "Synthetic",
		captionId: "turn-one",
		revision: 1,
	},
};
const sender = {
	tab: { id: 2 },
	frameId: 0,
	documentId: "document-2",
	url: "https://meet.google.com/abc-defg-hij",
};
test("only explicit role tabs/documents observe; another Meet never contributes names", async () => {
	const f = fixture();
	await f.controller.control({
		action: "attach",
		role: "walkthrough",
		tabId: 1,
		windowId: 10,
	});
	await f.controller.control({
		action: "attach",
		role: "meet",
		tabId: 2,
		windowId: 20,
	});
	assert.deepEqual(
		f.injected.map((item) => item.target.tabId),
		[1, 2],
	);
	const binding = f.status.roles.meet.bindingId;
	for (const change of [
		{ tab: { id: 99 } },
		{ frameId: 1 },
		{ documentId: "other-doc" },
		{ url: "https://meet.google.com/xyz-abcd-efg" },
	])
		assert.equal(
			(
				await f.controller.observed(
					{ ...caption, bindingId: binding },
					{ ...sender, ...change },
				)
			).ok,
			false,
		);
	assert.equal(
		(await f.controller.observed({ ...caption, bindingId: binding }, sender))
			.saved,
		true,
	);
});
test("original-session queue survives disconnect/restart but never follows a new generation or pause epoch", async () => {
	const f = fixture();
	await f.controller.control({
		action: "attach",
		role: "meet",
		tabId: 2,
		windowId: 20,
	});
	f.fail(true);
	await f.controller.observed(
		{ ...caption, bindingId: f.status.roles.meet.bindingId },
		sender,
	);
	assert.equal(f.memory.local.companion.queue.length, 1);
	f.fail(false);
	f.status.generation = "generation-two";
	f.status.roles = {};
	const restarted = createCompanionController({
		api: f.api,
		callNative: f.callNative,
		uuid: () => "never-new-profile",
	});
	await restarted.refresh();
	assert.equal(f.memory.local.companion.queue.length, 0);
	assert.equal(f.native.filter((m) => m.type === "companion-events").length, 0);
});
test("invalid acknowledgements keep queued evidence; a valid receipt clears it once", async () => {
	const f = fixture();
	await f.controller.control({
		action: "attach",
		role: "meet",
		tabId: 2,
		windowId: 20,
	});
	f.invalidAck(true);
	const m = { ...caption, bindingId: f.status.roles.meet.bindingId };
	assert.equal((await f.controller.observed(m, sender)).saved, false);
	assert.equal(f.memory.local.companion.queue.length, 1);
	f.invalidAck(false);
	await f.controller.refresh();
	assert.equal(f.memory.local.companion.queue.length, 0);
});

test("a generation change during queue persistence cannot count a discarded observation as saved", async () => {
	const f = fixture();
	await f.controller.control({
		action: "attach",
		role: "meet",
		tabId: 2,
		windowId: 20,
	});
	const bindingId = f.status.roles.meet.bindingId;
	const persist = f.api.storage.local.set;
	f.api.storage.local.set = async (data) => {
		await persist(data);
		if (data.companion.queue.length) {
			f.status.generation = "new-generation";
			f.status.roles = {};
		}
	};
	const result = await f.controller.observed({ ...caption, bindingId }, sender);
	assert.equal(result.saved, false);
	assert.equal(
		f.native.filter((message) => message.type === "companion-events").length,
		0,
	);
	assert.match(
		(await f.controller.refresh()).lastError,
		/stale|changed|discard/i,
	);
});
