import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

const token = "synthetic-rewind-owner-token-with-32-bytes-x";
const owner = { Authorization: `Bearer ${token}` };
const APP = "https://app.example.test";
const KEY = "wf_pub_rewind_site_key_1";
const SERVER = "https://feedback-server.test";
const deployment = JSON.parse(
	readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
);
let runtime;

before(() => {
	runtime = new Miniflare(
		convertV4MiniflareOptions({
			name: "rewind-test",
			modules: true,
			scriptPath: fileURLToPath(new URL("../dist/index.js", import.meta.url)),
			compatibilityDate: "2026-10-25",
			r2Buckets: ["MEDIA"],
			assets: {
				routerConfig: { has_user_worker: true },
				assetConfig: { html_handling: deployment.assets.html_handling },
				directory: fileURLToPath(new URL("../public", import.meta.url)),
				binding: "ASSETS",
				run_worker_first: true,
			},
			ratelimits: {
				FEEDBACK_LIMIT: {
					namespace_id: "1",
					simple: { limit: 1000, period: 60 },
				},
				FEEDBACK_SITE_LIMIT: {
					namespace_id: "2",
					simple: { limit: 1000, period: 60 },
				},
			},
			bindings: {
				UPLOAD_TOKEN: token,
				FEEDBACK_SITES: JSON.stringify({
					[KEY]: { name: "Rewind clinic", origins: [APP], retentionDays: 3 },
				}),
			},
		}),
	);
});
after(async () => runtime?.dispose());

function envelope({
	startedAt = 1_700_000_000_000,
	span = 120_000,
	events,
} = {}) {
	return JSON.stringify({
		schemaVersion: 1,
		kind: "rrweb",
		rrweb: "2.2.0",
		startedAt,
		endedAt: startedAt + span,
		events: events ?? [
			{
				type: 4,
				data: { href: "https://app.example.test/", width: 390, height: 844 },
				timestamp: startedAt,
			},
			{
				type: 2,
				data: {
					node: { type: 0, childNodes: [] },
					initialOffset: { top: 0, left: 0 },
				},
				timestamp: startedAt,
			},
			{
				type: 3,
				data: { source: 2, type: 2, id: 5, x: 10, y: 20 },
				timestamp: startedAt + 500,
			},
		],
	});
}
const recording = (options) => gzipSync(Buffer.from(envelope(options)));

async function post(
	rewind,
	{ type = "application/gzip", note = "Replay attached" } = {},
) {
	const body = new FormData();
	body.set("key", KEY);
	body.set("note", note);
	body.set(
		"evidence",
		JSON.stringify({
			schemaVersion: 1,
			capturedAt: Date.now(),
			route: "/",
			events: [],
		}),
	);
	if (typeof rewind === "string") body.set("rewind", rewind);
	else if (rewind)
		body.set("rewind", new Blob([rewind], { type }), "rewind.json.gz");
	const encoded = new Request(`${SERVER}/`, { method: "POST", body });
	return runtime.dispatchFetch(`${SERVER}/api/v1/feedback`, {
		method: "POST",
		body: Buffer.from(await encoded.arrayBuffer()),
		headers: {
			"Content-Type": encoded.headers.get("Content-Type"),
			Origin: APP,
		},
	});
}
const get = (path, headers = owner) =>
	runtime.dispatchFetch(`${SERVER}${path}`, { headers });

test("the owner reads a stored rewind; nobody else can, and delete removes it", async () => {
	const bytes = recording();
	const created = await post(bytes);
	assert.equal(created.status, 201, await created.clone().text());
	const { id } = await created.json();

	const report = await (await get(`/api/v1/feedback/${id}`)).json();
	assert.deepEqual(report.rewind, {
		contentType: "application/gzip",
		size: bytes.length,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		rrweb: "2.2.0",
		startedAt: 1_700_000_000_000,
		endedAt: 1_700_000_120_000,
		jsonBytes: envelope().length,
	});
	assert.equal(report.expiresAt - report.createdAt, 3 * 86_400_000);
	const listed = await (await get("/api/v1/feedback")).json();
	assert.equal(listed.reports.find((item) => item.id === id)?.rewind, true);

	const stored = await (await runtime.getR2Bucket("MEDIA")).head(
		`feedback/v1/${id}/rewind`,
	);
	assert.equal(stored?.size, bytes.length);
	assert.equal(stored?.httpMetadata?.contentType, "application/gzip");

	const path = `/api/v1/feedback/${id}/rewind`;
	for (const headers of [
		{},
		{ Origin: APP },
		{ Cookie: `capux_read=${token}` },
		{ Authorization: "Bearer wrong-token-of-sufficient-length-000" },
		{ Authorization: `Basic ${btoa(`owner:${token}`)}` },
	]) {
		const denied = await get(path, headers);
		assert.equal(denied.status, 401, JSON.stringify(headers));
		assert.equal(denied.headers.get("Access-Control-Allow-Origin"), null);
	}

	const download = await get(path);
	assert.equal(download.status, 200);
	assert.equal(download.headers.get("Content-Type"), "application/gzip");
	assert.equal(download.headers.get("Content-Disposition"), "attachment");
	assert.equal(download.headers.get("Cache-Control"), "private, no-store");
	assert.equal(download.headers.get("X-Content-SHA256"), report.rewind.sha256);
	assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);

	const removed = await runtime.dispatchFetch(
		`${SERVER}/api/v1/feedback/${id}`,
		{
			method: "DELETE",
			headers: owner,
		},
	);
	assert.equal(removed.status, 204);
	assert.equal((await get(path)).status, 404);
	assert.equal(
		await (await runtime.getR2Bucket("MEDIA")).head(`feedback/v1/${id}/rewind`),
		null,
	);
});

test("reports without a rewind still work and have no rewind to read", async () => {
	const created = await post(null);
	assert.equal(created.status, 201);
	const { id } = await created.json();
	assert.equal(
		(await (await get(`/api/v1/feedback/${id}`)).json()).rewind,
		null,
	);
	assert.equal((await get(`/api/v1/feedback/${id}/rewind`)).status, 404);
});

test("rewinds over the size caps are refused", async () => {
	const big = Buffer.alloc(4 * 1024 * 1024 + 1, 0);
	big.set([0x1f, 0x8b, 0x08]);
	assert.equal((await post(big)).status, 413);

	const prefix = envelope().slice(0, -2);
	const bomb = gzipSync(
		Buffer.concat([
			Buffer.from(`${prefix},`),
			Buffer.alloc(25 * 1024 * 1024, 0x20),
			Buffer.from("]}"),
		]),
	);
	assert.ok(bomb.length < 4 * 1024 * 1024);
	assert.equal((await post(bomb)).status, 413);
});

test("only gzip-compressed rrweb recordings in the expected envelope are accepted", async () => {
	const refused = async (body, options) => (await post(body, options)).status;
	assert.equal(await refused(recording(), { type: "application/json" }), 415);
	assert.equal(await refused(Buffer.from(envelope())), 415);
	assert.equal(
		await refused(gzipSync(Buffer.from('{"schemaVersion":1,"events":[]}'))),
		415,
	);
	assert.equal(
		await refused(
			gzipSync(Buffer.from(envelope().replace('"type":4', '"type":3'))),
		),
		415,
	);
	assert.equal(await refused(recording().subarray(0, 40)), 415);
	assert.equal(await refused(recording({ span: 16 * 60_000 })), 415);
	assert.equal(await refused(recording({ span: -1 })), 415);
	assert.equal(await refused("not a file"), 400);
	assert.equal(await refused(Buffer.alloc(0)), 413);
});

test("the replay page holds no report data, sets no cookie and is never public data", async () => {
	const { id } = await (
		await post(recording(), { note: "Patient note secret" })
	).json();
	const page = await get(`/rewind/${id}`, {});
	assert.equal(page.status, 200);
	assert.equal(page.headers.get("Set-Cookie"), null);
	assert.equal(page.headers.get("Cache-Control"), "private, no-store");
	const csp = page.headers.get("Content-Security-Policy");
	assert.match(csp, /script-src 'self';/);
	assert.match(csp, /connect-src 'self';/);
	assert.match(csp, /frame-ancestors 'none'/);
	assert.doesNotMatch(csp, /https:|\*/);
	const html = await page.text();
	assert.match(html, /Owner credential/);
	assert.match(html, /src="\/vendor\/rrweb-player\.js"/);
	assert.doesNotMatch(html, /Patient note secret|cdn|https?:\/\/(?!github)/i);

	for (const asset of [
		"/vendor/rrweb-player.js",
		"/vendor/rrweb-player.css",
		"/rewind.js",
	]) {
		const response = await get(asset, {});
		assert.equal(response.status, 200, asset);
		assert.doesNotMatch(await response.text(), /Patient note secret/);
	}
	assert.equal((await get(`/rewind/not-an-id`, {})).status, 404);
	assert.equal((await get(`/api/v1/feedback/${id}/rewind`, {})).status, 401);
});
