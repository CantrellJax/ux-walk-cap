import type { RuntimeEnv } from "./env";

export const OWNER_KEY = "self-hosted-owner";
const PENDING_RESERVATION_MS = 86400000;

export interface AccountUser {
	id: string;
	email: string;
	name: string;
	plan: string;
}

export type Principal =
	| { kind: "owner"; key: typeof OWNER_KEY }
	| { kind: "user"; key: string; user: AccountUser };

export interface Quota {
	maxStoredBytes: number;
	maxActiveShares: number;
}

export interface Usage {
	storedBytes: number;
	activeShares: number;
}

export interface ShareRecord {
	id: string;
	owner: string;
	title: string;
	contentType: string;
	size: number;
	status: "pending" | "ready" | "revoked";
	createdAt: number;
	expiresAt: number;
	completedAt: number | null;
	revokedAt: number | null;
}

export const userKey = (id: string) => `user:${id}`;

function limit(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function quotaFor(env: RuntimeEnv, _plan: string): Quota {
	return {
		maxStoredBytes: limit(env.FREE_PLAN_MAX_BYTES, 5 * 1024 ** 3),
		maxActiveShares: limit(env.FREE_PLAN_MAX_SHARES, 25),
	};
}

const active = (owner: number, now: number, pendingSince: number) =>
	`"owner" = ?${owner} and (("status" = 'ready' and "expiresAt" > ?${now}) or ("status" = 'pending' and "createdAt" > ?${pendingSince} and "expiresAt" > ?${now}))`;

export async function usage(env: RuntimeEnv, owner: string): Promise<Usage> {
	const now = Date.now();
	const row = await env.DB.prepare(
		`select count(*) as "shares", coalesce(sum("size"), 0) as "bytes" from "share" where ${active(1, 2, 3)}`,
	)
		.bind(owner, now, now - PENDING_RESERVATION_MS)
		.first<{ shares: number; bytes: number }>();
	return { storedBytes: row?.bytes ?? 0, activeShares: row?.shares ?? 0 };
}

export async function reserve(
	env: RuntimeEnv,
	share: Omit<ShareRecord, "status" | "completedAt" | "revokedAt">,
	quota: Quota | undefined,
): Promise<boolean> {
	const now = Date.now();
	const values = [
		share.id,
		share.owner,
		share.title,
		share.contentType,
		share.size,
		share.createdAt,
		share.expiresAt,
	];
	if (!quota) {
		await env.DB.prepare(
			`insert into "share" ("id", "owner", "title", "contentType", "size", "status", "createdAt", "expiresAt") values (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7)`,
		)
			.bind(...values)
			.run();
		return true;
	}
	const result = await env.DB.prepare(
		`insert into "share" ("id", "owner", "title", "contentType", "size", "status", "createdAt", "expiresAt")
		select ?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7
		where (select count(*) from "share" where ${active(2, 8, 9)}) < ?10
		and (select coalesce(sum("size"), 0) from "share" where ${active(2, 8, 9)}) + ?5 <= ?11`,
	)
		.bind(
			...values,
			now,
			now - PENDING_RESERVATION_MS,
			quota.maxActiveShares,
			quota.maxStoredBytes,
		)
		.run();
	return result.meta.changes === 1;
}

export async function storedBytesExcept(
	env: RuntimeEnv,
	owner: string,
	id: string,
): Promise<number> {
	const row = await env.DB.prepare(
		`select coalesce(sum("size"), 0) as "bytes" from "share" where "owner" = ?1 and "id" != ?2 and "status" = 'ready' and "expiresAt" > ?3`,
	)
		.bind(owner, id, Date.now())
		.first<{ bytes: number }>();
	return row?.bytes ?? 0;
}

export async function shareOwner(
	env: RuntimeEnv,
	id: string,
): Promise<string | undefined> {
	const row = await env.DB.prepare(
		`select "owner" from "share" where "id" = ?1`,
	)
		.bind(id)
		.first<{ owner: string }>();
	return row?.owner;
}

export async function markReady(env: RuntimeEnv, id: string, size: number) {
	await env.DB.prepare(
		`update "share" set "status" = 'ready', "size" = ?2, "completedAt" = ?3 where "id" = ?1 and "status" = 'pending'`,
	)
		.bind(id, size, Date.now())
		.run();
}

export async function markRevoked(env: RuntimeEnv, id: string) {
	await env.DB.prepare(
		`update "share" set "status" = 'revoked', "revokedAt" = ?2 where "id" = ?1 and "status" != 'revoked'`,
	)
		.bind(id, Date.now())
		.run();
}

export async function sharesOf(
	env: RuntimeEnv,
	owner: string,
): Promise<ShareRecord[]> {
	const { results } = await env.DB.prepare(
		`select * from "share" where "owner" = ?1 order by "createdAt" desc`,
	)
		.bind(owner)
		.all<ShareRecord>();
	return results;
}

export async function purge(env: RuntimeEnv, owner: string): Promise<void> {
	const shares = await sharesOf(env, owner);
	for (const share of shares) {
		await env.MEDIA.put(`revoked/${share.id}`, "revoked");
		if (share.status === "pending") {
			const manifest = await env.MEDIA.get(`shares/${share.id}.json`);
			const uploadId = manifest
				? (await manifest.json<{ uploadId?: string }>()).uploadId
				: undefined;
			if (uploadId)
				await env.MEDIA.resumeMultipartUpload(`media/${share.id}`, uploadId)
					.abort()
					.catch(() => undefined);
		}
	}
	for (let index = 0; index < shares.length; index += 500)
		await env.MEDIA.delete(
			shares
				.slice(index, index + 500)
				.flatMap((share) => [`media/${share.id}`, `shares/${share.id}.json`]),
		);
	await env.DB.prepare(`delete from "share" where "owner" = ?1`)
		.bind(owner)
		.run();
}
