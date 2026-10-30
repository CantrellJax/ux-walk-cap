import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Miniflare } from "miniflare";
import { migrate, workerOptions } from "./support.mjs";

const origin = "https://capux.test";
const owner = "synthetic-owner-token-with-at-least-32-bytes";
const ownerHeaders = { Authorization: `Bearer ${owner}` };
const baseBindings = {
	UPLOAD_TOKEN: owner,
	BETTER_AUTH_URL: origin,
	BETTER_AUTH_SECRET: "synthetic-better-auth-secret-for-local-tests-only",
	SIGNUP_ENABLED: "true",
	GITHUB_CLIENT_ID: "synthetic-github-client",
	GITHUB_CLIENT_SECRET: "synthetic-github-secret",
	FREE_PLAN_MAX_BYTES: "64",
	FREE_PLAN_MAX_SHARES: "3",
};
let runtime;
let address = 10;

function github(request) {
	const url = new URL(request.url);
	if (url.href === "https://github.com/login/oauth/access_token")
		return request.text().then((body) =>
			Response.json({
				access_token: `gho_${new URLSearchParams(body).get("code")}`,
				token_type: "bearer",
				scope: "read:user,user:email",
			}),
		);
	const login = request.headers
		.get("Authorization")
		?.replace(/^Bearer gho_/, "");
	if (url.href === "https://api.github.com/user")
		return Response.json({
			id: Number.parseInt(
				createHash("sha256").update(login).digest("hex").slice(0, 8),
				16,
			),
			login,
			name: `Synthetic ${login}`,
			email: `${login}@example.test`,
			avatar_url: null,
		});
	if (url.href === "https://api.github.com/user/emails")
		return Response.json([
			{ email: `${login}@example.test`, primary: true, verified: true },
		]);
	return new Response("Unexpected outbound request in tests.", {
		status: 599,
	});
}

function options(bindings = {}) {
	return workerOptions({
		name: "capux-accounts",
		bindings: { ...baseBindings, ...bindings },
		ratelimits: { SHARE_CREATE_LIMITER: { limit: 8, period: 60 } },
		outboundService: github,
	});
}

before(async () => {
	runtime = new Miniflare(options());
	await migrate(runtime);
});
after(async () => runtime?.dispose());

class Browser {
	cookies = new Map();
	ip = `203.0.113.${address++}`;
	absorb(response) {
		for (const cookie of response.headers.getSetCookie()) {
			const [pair, ...attributes] = cookie.split(";");
			const index = pair.indexOf("=");
			const name = pair.slice(0, index).trim();
			const value = pair.slice(index + 1).trim();
			const cleared = attributes.some((item) => /^\s*max-age=0$/i.test(item));
			if (!value || cleared) this.cookies.delete(name);
			else this.cookies.set(name, value);
		}
		return response;
	}
	async fetch(path, init = {}) {
		const headers = new Headers(init.headers);
		headers.set("cf-connecting-ip", this.ip);
		if (this.cookies.size)
			headers.set(
				"Cookie",
				[...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "),
			);
		if (init.method && init.method !== "GET") headers.set("Origin", origin);
		if (init.json !== undefined) {
			headers.set("Content-Type", "application/json");
			init = { ...init, body: JSON.stringify(init.json) };
		}
		return this.absorb(
			await runtime.dispatchFetch(`${origin}${path}`, {
				...init,
				headers,
				redirect: "manual",
			}),
		);
	}
}

const db = () => runtime.getD1Database("DB");

const call = (path, init = {}) =>
	runtime.dispatchFetch(`${origin}${path}`, { redirect: "manual", ...init });

async function signIn(login, browser = new Browser()) {
	const start = await browser.fetch("/api/auth/sign-in/social", {
		method: "POST",
		json: {
			provider: "github",
			callbackURL: "/account",
			errorCallbackURL: "/signin",
		},
	});
	assert.equal(start.status, 200, await start.clone().text());
	const state = new URL((await start.json()).url).searchParams.get("state");
	const callback = await browser.fetch(
		`/api/auth/callback/github?code=${login}&state=${state}`,
	);
	assert.equal(callback.status, 302, await callback.clone().text());
	const location = callback.headers.get("Location");
	const token = callback.headers.get("set-auth-token");
	return {
		browser,
		location,
		token,
		headers: token ? { Authorization: `Bearer ${token}` } : undefined,
	};
}

async function startShare(headers, size, extra = {}) {
	const response = await call("/api/v1/shares", {
		method: "POST",
		headers,
		body: JSON.stringify({
			title: "Synthetic account walk",
			contentType: "video/mp4",
			size,
			expiresInDays: 7,
			...extra,
		}),
	});
	return { response, body: await response.clone().json() };
}

async function upload(headers, share, bytes) {
	const part = await call(`/api/v1/shares/${share.id}/parts/1`, {
		method: "PUT",
		headers,
		body: bytes,
	});
	assert.equal(part.status, 200, await part.clone().text());
	return [await part.json()];
}

const complete = (headers, share, parts) =>
	call(`/api/v1/shares/${share.id}/complete`, {
		method: "POST",
		headers,
		body: JSON.stringify({ parts }),
	});

async function publish(headers, size = 8) {
	const { response, body: share } = await startShare(headers, size);
	assert.equal(response.status, 201, await response.clone().text());
	const parts = await upload(headers, share, new Uint8Array(size).fill(5));
	assert.equal((await complete(headers, share, parts)).status, 200);
	return share;
}

const capability = (share) => ({
	Authorization: `Bearer ${share.sharePath.split("#")[1]}`,
});

test("a GitHub sign-in creates a free account whose session works as a bearer on /api/v1", async () => {
	const alice = await signIn("alice");
	assert.equal(alice.location, "/account");
	assert.ok(alice.token);
	const me = await call("/api/v1/me", { headers: alice.headers });
	assert.equal(me.status, 200);
	const body = await me.json();
	assert.equal(body.principal, "user");
	assert.equal(body.user.email, "alice@example.test");
	assert.equal(body.plan, "free");
	assert.deepEqual(body.usage, { storedBytes: 0, activeShares: 0 });
	assert.deepEqual(body.quota, { maxStoredBytes: 64, maxActiveShares: 3 });
	const cookieMe = await alice.browser.fetch("/api/v1/me");
	assert.equal((await cookieMe.json()).user.id, body.user.id);
	const health = await (await call("/healthz")).json();
	assert.deepEqual(
		{
			accounts: health.accounts,
			signup: health.signup,
			providers: health.providers,
		},
		{ accounts: true, signup: true, providers: ["github"] },
	);
});

test("one account cannot read, upload to, complete, revoke or export another account's shares", async () => {
	const alice = await signIn("alice");
	const bob = await signIn("bob");
	const ready = await publish(alice.headers);
	const { body: pending } = await startShare(alice.headers, 8);
	for (const share of [ready, pending]) {
		const path = `/api/v1/shares/${share.id}`;
		assert.equal(
			(await call(`${path}/metadata`, { headers: bob.headers })).status,
			404,
		);
		assert.equal(
			(await call(`${path}/media`, { headers: bob.headers })).status,
			404,
		);
		assert.equal(
			(
				await call(`${path}/parts/1`, {
					method: "PUT",
					headers: bob.headers,
					body: new Uint8Array(8),
				})
			).status,
			404,
		);
		assert.equal(
			(await complete(bob.headers, share, [{ partNumber: 1, etag: "x" }]))
				.status,
			404,
		);
		assert.equal(
			(await call(path, { method: "DELETE", headers: bob.headers })).status,
			404,
		);
	}
	const guessed = `/api/v1/shares/${randomUUID()}`;
	assert.equal(
		(await call(guessed, { method: "DELETE", headers: bob.headers })).status,
		404,
	);
	assert.equal(
		(await call(`${guessed}/metadata`, { headers: bob.headers })).status,
		404,
	);
	const exported = await (
		await call("/api/v1/me/export", { headers: bob.headers })
	).json();
	assert.deepEqual(exported.shares, []);
	assert.deepEqual(
		(await (await call("/api/v1/me", { headers: bob.headers })).json()).usage,
		{ storedBytes: 0, activeShares: 0 },
	);
	const own = await (
		await call("/api/v1/me/export", { headers: alice.headers })
	).json();
	assert.deepEqual(
		own.shares.map((share) => share.id).sort(),
		[ready.id, pending.id].sort(),
	);
	assert.equal(
		own.shares.find((share) => share.id === ready.id).status,
		"ready",
	);
	assert.equal(
		own.shares.find((share) => share.id === ready.id).viewerUrl,
		`${origin}/s/${ready.id}`,
	);
	assert.equal(
		(
			await call(`/api/v1/shares/${ready.id}/metadata`, {
				headers: capability(ready),
			})
		).status,
		200,
	);
	assert.equal(
		(
			await call(`/api/v1/shares/${ready.id}`, {
				method: "DELETE",
				headers: ownerHeaders,
			})
		).status,
		404,
	);
	assert.equal(
		(
			await call(`/api/v1/shares/${ready.id}`, {
				method: "DELETE",
				headers: alice.headers,
			})
		).status,
		204,
	);
	assert.equal(
		(
			await call(`/api/v1/shares/${ready.id}/metadata`, {
				headers: capability(ready),
			})
		).status,
		404,
	);
});

test("cookie sessions refuse cross-origin writes and recovery stays owner-only", async () => {
	const carol = await signIn("carol");
	const crossSite = await runtime.dispatchFetch(`${origin}/api/v1/shares`, {
		method: "POST",
		headers: {
			Cookie: [...carol.browser.cookies]
				.map(([name, value]) => `${name}=${value}`)
				.join("; "),
			Origin: "https://attacker.test",
		},
		body: JSON.stringify({ title: "x", contentType: "video/mp4", size: 4 }),
	});
	assert.equal(crossSite.status, 403);
	assert.equal(
		(await call("/api/v1/recovery", { headers: carol.headers })).status,
		401,
	);
	assert.equal(
		(await call("/api/v1/recovery", { headers: ownerHeaders })).status,
		200,
	);
});

test("owner mode keeps working beside accounts and is not subject to account quotas", async () => {
	const share = await publish(ownerHeaders, 100);
	const me = await (await call("/api/v1/me", { headers: ownerHeaders })).json();
	assert.equal(me.principal, "owner");
	assert.equal(me.user, null);
	assert.equal(me.quota, null);
	assert.ok(me.usage.storedBytes >= 100);
	const bob = await signIn("bob");
	assert.equal(
		(
			await call(`/api/v1/shares/${share.id}`, {
				method: "DELETE",
				headers: bob.headers,
			})
		).status,
		404,
	);
	assert.equal(
		(
			await call(`/api/v1/shares/${share.id}/media`, {
				headers: capability(share),
			})
		).status,
		200,
	);
	assert.equal(
		(
			await call("/api/v1/me", {
				method: "DELETE",
				headers: ownerHeaders,
			})
		).status,
		403,
	);
	assert.equal(
		(
			await call("/api/v1/shares", {
				method: "POST",
				headers: { Authorization: "Bearer not-a-session-or-owner" },
				body: "{}",
			})
		).status,
		401,
	);
});

test("quotas are enforced at create and re-checked at complete", async () => {
	const dana = await signIn("dana");
	const first = await publish(dana.headers, 40);
	const tooBig = await startShare(dana.headers, 30);
	assert.equal(tooBig.response.status, 403);
	assert.equal(tooBig.body.code, "quota_exceeded");
	await publish(dana.headers, 10);
	const { body: third } = await startShare(dana.headers, 10);
	const fourth = await startShare(dana.headers, 1);
	assert.equal(fourth.response.status, 403);
	assert.equal(fourth.body.code, "quota_exceeded");
	const parts = await upload(dana.headers, third, new Uint8Array(10));
	await runtime.setOptions(options({ FREE_PLAN_MAX_BYTES: "55" }));
	const over = await complete(dana.headers, third, parts);
	assert.equal(over.status, 403);
	assert.equal((await over.json()).code, "quota_exceeded");
	const bucket = await runtime.getR2Bucket("MEDIA");
	assert.equal(await bucket.head(`media/${third.id}`), null);
	await runtime.setOptions(options());
	const me = await (await call("/api/v1/me", { headers: dana.headers })).json();
	assert.deepEqual(me.usage, { storedBytes: 50, activeShares: 2 });
	assert.equal(
		(
			await call(`/api/v1/shares/${first.id}`, {
				method: "DELETE",
				headers: dana.headers,
			})
		).status,
		204,
	);
	assert.equal((await startShare(dana.headers, 30)).response.status, 201);
});

test("the share rate limit returns 429 per account, and auth routes are rate limited too", async () => {
	const erin = await signIn("erin");
	const statuses = [];
	for (let attempt = 0; attempt < 9; attempt++)
		statuses.push((await startShare(erin.headers, 1)).response.status);
	assert.ok(
		statuses.slice(0, 8).every((status) => status !== 429),
		`${statuses}`,
	);
	assert.equal(statuses[8], 429);
	const limited = await startShare(erin.headers, 1);
	assert.equal(limited.body.code, "rate_limited");
	assert.equal(limited.response.headers.get("Retry-After"), "60");
	const fred = await signIn("fred");
	assert.notEqual((await startShare(fred.headers, 1)).response.status, 429);
	const browser = new Browser();
	const attempts = [];
	for (let attempt = 0; attempt < 4; attempt++)
		attempts.push(
			(
				await browser.fetch("/api/auth/sign-in/social", {
					method: "POST",
					json: { provider: "github", callbackURL: "/account" },
				})
			).status,
		);
	assert.deepEqual(attempts, [200, 200, 200, 429]);
});

test("device authorization issues a bearer session only after the signed-in user approves", async () => {
	const invalid = await call("/api/auth/device/code", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ client_id: "someone-else" }),
	});
	assert.equal(invalid.status, 400);
	assert.equal((await invalid.json()).error, "invalid_client");
	const code = await call("/api/auth/device/code", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ client_id: "cap-ux-cli" }),
	});
	assert.equal(code.status, 200, await code.clone().text());
	const grant = await code.json();
	assert.equal(
		grant.verification_uri_complete,
		`${origin}/device?user_code=${grant.user_code}`,
	);
	const poll = async () => {
		await (await db())
			.prepare('update "deviceCode" set "lastPolledAt" = null')
			.run();
		return call("/api/auth/device/token", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				device_code: grant.device_code,
				client_id: "cap-ux-cli",
			}),
		});
	};
	const pending = await poll();
	assert.equal(pending.status, 400);
	assert.equal((await pending.json()).error, "authorization_pending");
	const page = await call(`/device?user_code=${grant.user_code}`);
	assert.equal(page.status, 200);
	assert.match(await page.text(), /Connect Cap UX/);
	const gwen = await signIn("gwen");
	const review = await gwen.browser.fetch(
		`/api/auth/device?user_code=${grant.user_code}`,
	);
	assert.equal(review.status, 200);
	assert.deepEqual(await review.json(), {
		user_code: grant.user_code,
		status: "pending",
		client_id: "cap-ux-cli",
		scope: null,
	});
	const intruder = await signIn("harry");
	const stolen = await intruder.browser.fetch("/api/auth/device/approve", {
		method: "POST",
		json: { userCode: grant.user_code },
	});
	assert.equal(stolen.status, 403);
	const approve = await gwen.browser.fetch("/api/auth/device/approve", {
		method: "POST",
		json: { userCode: grant.user_code },
	});
	assert.equal(approve.status, 200, await approve.clone().text());
	const issued = await poll();
	assert.equal(issued.status, 200, await issued.clone().text());
	const token = await issued.json();
	assert.equal(token.token_type, "Bearer");
	const device = { Authorization: `Bearer ${token.access_token}` };
	const me = await (await call("/api/v1/me", { headers: device })).json();
	assert.equal(me.user.email, "gwen@example.test");
	const share = await publish(device);
	assert.equal(
		(
			await call(`/api/v1/shares/${share.id}`, {
				method: "DELETE",
				headers: gwen.headers,
			})
		).status,
		204,
	);
	assert.equal((await poll()).status, 400);

	const denied = await (
		await call("/api/auth/device/code", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ client_id: "cap-ux-desktop" }),
		})
	).json();
	await gwen.browser.fetch(`/api/auth/device?user_code=${denied.user_code}`);
	assert.equal(
		(
			await gwen.browser.fetch("/api/auth/device/deny", {
				method: "POST",
				json: { userCode: denied.user_code },
			})
		).status,
		200,
	);
	await (await db())
		.prepare('update "deviceCode" set "lastPolledAt" = null')
		.run();
	const refused = await call("/api/auth/device/token", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			device_code: denied.device_code,
			client_id: "cap-ux-desktop",
		}),
	});
	assert.equal((await refused.json()).error, "access_denied");
});

test("with signup disabled, existing accounts still sign in and new accounts are refused", async () => {
	await signIn("ivy");
	await runtime.setOptions(options({ SIGNUP_ENABLED: "false" }));
	try {
		assert.equal((await (await call("/healthz")).json()).signup, false);
		const existing = await signIn("ivy");
		assert.equal(existing.location, "/account");
		assert.ok(existing.token);
		const stranger = await signIn("stranger");
		assert.equal(stranger.token, null);
		assert.match(stranger.location, /^\/signin\?error=/);
		const row = await (await db())
			.prepare('select count(*) as "count" from "user" where "email" = ?')
			.bind("stranger@example.test")
			.first();
		assert.equal(row.count, 0);
		assert.equal(
			(
				await call("/api/v1/shares", {
					method: "POST",
					headers: ownerHeaders,
					body: JSON.stringify({
						title: "owner",
						contentType: "image/png",
						size: 3,
					}),
				})
			).status,
			201,
		);
	} finally {
		await runtime.setOptions(options());
	}
	const opened = await signIn("stranger");
	assert.ok(opened.token);
});

test("account deletion revokes and deletes all media, then removes the user", async () => {
	const jill = await signIn("jill");
	const ready = await publish(jill.headers);
	const { body: pending } = await startShare(jill.headers, 8);
	const bucket = await runtime.getR2Bucket("MEDIA");
	assert.ok(await bucket.head(`media/${ready.id}`));
	const { id } = (
		await (await call("/api/v1/me", { headers: jill.headers })).json()
	).user;
	const removed = await call("/api/v1/me", {
		method: "DELETE",
		headers: jill.headers,
	});
	assert.equal(removed.status, 204, await removed.clone().text());
	for (const share of [ready, pending]) {
		assert.equal(await bucket.head(`media/${share.id}`), null);
		assert.equal(await bucket.head(`shares/${share.id}.json`), null);
		assert.ok(await bucket.head(`revoked/${share.id}`));
	}
	assert.equal(
		(
			await call(`/api/v1/shares/${ready.id}/media`, {
				headers: capability(ready),
			})
		).status,
		404,
	);
	assert.equal(
		(await call("/api/v1/me", { headers: jill.headers })).status,
		401,
	);
	const rows = await (await db())
		.prepare(
			'select (select count(*) from "user" where "id" = ?1) as "users", (select count(*) from "account" where "userId" = ?1) as "accounts", (select count(*) from "session" where "userId" = ?1) as "sessions"',
		)
		.bind(id)
		.first();
	assert.deepEqual(rows, { users: 0, accounts: 0, sessions: 0 });
	const remaining = await (await db())
		.prepare('select count(*) as "count" from "share" where "id" in (?1, ?2)')
		.bind(ready.id, pending.id)
		.first();
	assert.equal(remaining.count, 0);
});
