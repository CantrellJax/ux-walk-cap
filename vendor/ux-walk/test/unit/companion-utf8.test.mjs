import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import test from "node:test";
import {
	CompanionSession,
	requestCompanion,
	startCompanionServer,
} from "../../src/companion.mjs";

const name = "José 日本語";
function session(write = async () => true) {
	return new CompanionSession({
		recordingId: "recording",
		generation: "generation",
		backend: "cap",
		state: () => "recording",
		clock: () => 5000,
		write,
		flush: async () => {},
	});
}
function split(bytes) {
	return bytes.indexOf(Buffer.from("é")) + 1;
}

test(
	"split UTF-8 requests preserve speaker names and retry identity",
	{ timeout: 10000 },
	async (t) => {
		const root = fs.mkdtempSync("/tmp/uxw-utf8-request-");
		t.after(() => fs.rmSync(root, { recursive: true, force: true }));
		const saved = [],
			native = session(async (event) => {
				saved.push(event);
				return true;
			});
		let firstRead;
		const observed = new Promise((resolve) => {
				firstRead = resolve;
			}),
			create = net.createServer;
		net.createServer = (handler) =>
			create((socket) => {
				handler(socket);
				socket.once("data", firstRead);
			});
		let owner;
		try {
			owner = await startCompanionServer({ configDir: root, session: native });
		} finally {
			net.createServer = create;
		}
		t.after(() => owner.close());
		const bound = await native.handle({
			type: "companion-attach",
			recordingId: "recording",
			generation: "generation",
			clientId: "profile-1234567890",
			role: "meet",
			tabId: 1,
			windowId: 1,
			documentId: "document",
			url: "https://meet.google.com/abc-defg-hij",
		});
		const message = {
			type: "companion-events",
			...bound,
			events: [
				{
					eventId: "event",
					kind: "caption",
					observedAt: 4000,
					name,
					text: "日本語 caption",
					captionId: "caption",
					revision: 1,
				},
			],
		};
		const bytes = Buffer.from(
				`${JSON.stringify({ token: owner.descriptor.token, message })}\n`,
			),
			cut = split(bytes);
		const socket = net.createConnection({
			host: owner.descriptor.host,
			port: owner.descriptor.port,
		});
		t.after(() => socket.destroy());
		const chunks = [];
		const ended = new Promise((resolve, reject) => {
			socket.on("data", (data) => chunks.push(data));
			socket.once("end", resolve);
			socket.once("error", reject);
		});
		await new Promise((resolve) => socket.once("connect", resolve));
		socket.write(bytes.subarray(0, cut));
		await observed;
		socket.write(bytes.subarray(cut));
		await ended;
		assert.equal(JSON.parse(Buffer.concat(chunks)).result.acknowledged, true);
		assert.equal(saved[0].name, name);
		assert.equal(
			(await requestCompanion(owner.descriptor, message)).acknowledged,
			true,
		);
		assert.equal(saved.length, 1);
	},
);

test(
	"split UTF-8 owner responses preserve selected tab titles",
	{ timeout: 10000 },
	async (t) => {
		const root = fs.mkdtempSync("/tmp/uxw-utf8-response-");
		t.after(() => fs.rmSync(root, { recursive: true, force: true }));
		const owner = await startCompanionServer({
				configDir: root,
				session: session(),
			}),
			descriptor = owner.descriptor;
		await owner.close();
		let firstRead;
		const observed = new Promise((resolve) => {
			firstRead = resolve;
		});
		const server = net.createServer((socket) => {
			socket.once("data", async () => {
				const bytes = Buffer.from(
						`${JSON.stringify({ ok: true, result: { title: name } })}\n`,
					),
					cut = split(bytes);
				socket.write(bytes.subarray(0, cut));
				await observed;
				socket.end(bytes.subarray(cut));
			});
		});
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen({ host: descriptor.host, port: descriptor.port }, resolve);
		});
		t.after(() => new Promise((resolve) => server.close(resolve)));
		const connect = net.createConnection;
		net.createConnection = (...args) => {
			const socket = connect(...args);
			socket.once("data", firstRead);
			return socket;
		};
		try {
			assert.equal(
				(await requestCompanion(descriptor, { type: "companion-hello" })).title,
				name,
			);
		} finally {
			net.createConnection = connect;
		}
	},
);
