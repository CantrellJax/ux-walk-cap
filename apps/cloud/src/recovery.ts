interface Registration {
	schemaVersion: number;
	recordingId: string;
	writerGeneration: string;
	title: string;
	startedAtMs: number;
	expiresInDays: number;
	owner: string;
	createdAt: number;
	expiresAt: number;
	requestHash: string;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_BYTES = 8 * 1024 * 1024;
const kinds = new Set([
	"journal",
	"events",
	"clock",
	"microphone",
	"systemAudio",
	"microphoneInit",
	"systemAudioInit",
	"transcriptWords",
]);
const encode = new TextEncoder();
class RecoveryError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
	}
}
const fail = (status: number, message: string): never => {
	throw new RecoveryError(status, message);
};
const result = (body: unknown, status = 200) => Response.json(body, { status });
const prefix = (id: string) => `recovery/v1/${id}/`;
const tombstone = (id: string) => `recovery-tombstones/v1/${id}`;
async function digest(bytes: Uint8Array): Promise<string> {
	return Array.from(
		new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
		(byte) => byte.toString(16).padStart(2, "0"),
	).join("");
}
async function body(request: Request, max = MAX_BYTES): Promise<Uint8Array> {
	const reader = request.body?.getReader();
	if (!reader) return new Uint8Array();
	const chunks = [];
	let size = 0;
	try {
		for (;;) {
			const part = await reader.read();
			if (part.done) break;
			size += part.value.byteLength;
			if (size > max) fail(413, "Recovery object exceeds the allowed size.");
			chunks.push(part.value);
		}
	} finally {
		await reader.cancel();
	}
	const bytes = new Uint8Array(size);
	let cursor = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, cursor);
		cursor += chunk.byteLength;
	}
	return bytes;
}
function parse(bytes: Uint8Array): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
		if (value && typeof value === "object" && !Array.isArray(value))
			return value as Record<string, unknown>;
	} catch {}
	return fail(400, "Invalid recovery JSON.");
}
async function live(
	bucket: R2Bucket,
	id: string,
	owner: string,
): Promise<Registration> {
	if (await bucket.head(tombstone(id))) fail(404, "Recovery unavailable.");
	const object = await bucket.get(`${prefix(id)}metadata.json`);
	if (!object) return fail(404, "Recovery unavailable.");
	const registration = await object.json<Registration>();
	if (registration.owner !== owner || registration.expiresAt <= Date.now())
		fail(404, "Recovery unavailable.");
	return registration;
}
async function immutable(
	bucket: R2Bucket,
	key: string,
	bytes: Uint8Array,
	hash: string,
): Promise<R2Object> {
	const created = await bucket.put(key, bytes, {
		onlyIf: { etagDoesNotMatch: "*" },
		customMetadata: { sha256: hash },
	});
	const object = created ?? (await bucket.head(key));
	if (
		!object ||
		object.size !== bytes.byteLength ||
		object.customMetadata?.sha256 !== hash
	)
		return fail(
			409,
			"Recovery object or sequence already has different content.",
		);
	return object;
}
const sequenceKey = (id: string, sequence: number) =>
	`${prefix(id)}checkpoints/${String(sequence).padStart(12, "0")}.json`;

async function route(
	request: Request,
	bucket: R2Bucket,
	owner: string,
): Promise<Response> {
	const url = new URL(request.url);
	const suffix = url.pathname.slice("/api/v1/recovery".length);
	const cursor = url.searchParams.get("cursor") ?? undefined;
	if (!suffix || suffix === "/") {
		if (request.method !== "GET") return fail(405, "Method not allowed.");
		const page = await bucket.list({
			prefix: "recovery/v1/",
			delimiter: "/",
			cursor,
			limit: 100,
		});
		const recordings = [];
		for (const item of page.delimitedPrefixes) {
			const id = item.slice("recovery/v1/".length, -1);
			try {
				recordings.push(await live(bucket, id, owner));
			} catch (error) {
				if (!(error instanceof RecoveryError && error.status === 404))
					throw error;
			}
		}
		return result({
			recordings,
			...(page.truncated ? { cursor: page.cursor } : {}),
		});
	}
	const pieces = suffix.slice(1).split("/");
	const id = pieces[0];
	if (!id || !UUID.test(id)) return fail(400, "Invalid recording identity.");
	if (request.method === "DELETE" && pieces.length === 1) {
		await bucket.put(tombstone(id), encode.encode("revoked"));
		const page = await bucket.list({ prefix: prefix(id), limit: 1000 });
		if (page.objects.length)
			await bucket.delete(page.objects.map((object) => object.key));
		if (page.truncated)
			return result({ revoked: true, cleanupPending: true }, 202);
		return new Response(null, { status: 204 });
	}
	if (request.method === "PUT" && pieces.length === 1) {
		if (await bucket.head(tombstone(id)))
			return fail(404, "Recovery unavailable.");
		const data = parse(await body(request, 4096));
		if (
			data.schemaVersion !== 1 ||
			data.recordingId !== id ||
			typeof data.writerGeneration !== "string" ||
			!UUID.test(data.writerGeneration) ||
			typeof data.title !== "string" ||
			data.title.length > 200 ||
			Array.from(data.title).some(
				(character) => character.charCodeAt(0) < 32,
			) ||
			!Number.isSafeInteger(data.startedAtMs) ||
			Number(data.startedAtMs) < 0
		)
			return fail(400, "Invalid recovery registration.");
		const days = data.expiresInDays ?? 7;
		if (!Number.isInteger(days) || Number(days) < 1 || Number(days) > 30)
			return fail(400, "Recovery expiry must be between one and thirty days.");
		const identity = {
			schemaVersion: 1,
			recordingId: id,
			writerGeneration: data.writerGeneration,
			title: data.title,
			startedAtMs: Number(data.startedAtMs),
			expiresInDays: Number(days),
		};
		const requestHash = await digest(encode.encode(JSON.stringify(identity)));
		const registration: Registration = {
			...identity,
			owner,
			createdAt: Date.now(),
			expiresAt: Date.now() + Number(days) * 86400000,
			requestHash,
		};
		const key = `${prefix(id)}metadata.json`;
		const saved = await bucket.put(key, JSON.stringify(registration), {
			onlyIf: { etagDoesNotMatch: "*" },
		});
		const current = await live(bucket, id, owner);
		if (current.requestHash !== requestHash)
			return fail(409, "Recording identity already has different metadata.");
		return result(current, saved ? 201 : 200);
	}
	const registration = await live(bucket, id, owner);
	if (request.method === "GET" && pieces.length === 1) {
		const page = await bucket.list({
			prefix: `${prefix(id)}checkpoints/`,
			cursor,
			limit: 16,
		});
		const checkpoints = [];
		for (const object of page.objects) {
			const content = await bucket.get(object.key);
			if (content) checkpoints.push(await content.json());
		}
		await live(bucket, id, owner);
		return result({
			...registration,
			checkpoints,
			...(page.truncated ? { cursor: page.cursor } : {}),
		});
	}
	if (
		pieces[1] === "objects" &&
		pieces.length === 3 &&
		HASH.test(pieces[2] ?? "")
	) {
		const hash = pieces[2];
		const key = `${prefix(id)}objects/${hash}`;
		if (request.method === "PUT") {
			const bytes = await body(request);
			if ((await digest(bytes)) !== hash)
				return fail(400, "Recovery object checksum does not match.");
			const object = await immutable(bucket, key, bytes, hash);
			await live(bucket, id, owner);
			return result({ sha256: hash, size: object.size, etag: object.etag });
		}
		if (["GET", "HEAD"].includes(request.method)) {
			const object =
				request.method === "HEAD"
					? await bucket.head(key)
					: await bucket.get(key);
			if (!object) return fail(404, "Recovery object is unavailable.");
			await live(bucket, id, owner);
			return new Response(
				"body" in object && object.body instanceof ReadableStream
					? object.body
					: null,
				{
					headers: {
						"Content-Type": "application/octet-stream",
						"Content-Disposition": "attachment",
						"Content-Length": String(object.size),
						"X-Content-SHA256": hash,
					},
				},
			);
		}
	}
	if (
		pieces[1] === "checkpoints" &&
		pieces.length === 3 &&
		request.method === "PUT"
	) {
		const sequence = Number(pieces[2]);
		if (
			!Number.isSafeInteger(sequence) ||
			sequence < 1 ||
			sequence > 999999999999
		)
			return fail(400, "Invalid checkpoint sequence.");
		const bytes = await body(request, 256 * 1024);
		const hash = await digest(bytes);
		const key = sequenceKey(id, sequence);
		const prior = await bucket.head(key);
		if (prior) {
			if (prior.customMetadata?.sha256 !== hash)
				return fail(409, "Checkpoint sequence already has different content.");
			return result({ sequence, sha256: hash, acknowledged: true });
		}
		const checkpoint = parse(bytes);
		const clock = checkpoint.clock as Record<string, unknown> | undefined;
		if (
			checkpoint.schemaVersion !== 1 ||
			checkpoint.recordingId !== id ||
			checkpoint.writerGeneration !== registration.writerGeneration ||
			checkpoint.sequence !== sequence ||
			checkpoint.previousSequence !== sequence - 1 ||
			!Number.isSafeInteger(checkpoint.activeThroughMs) ||
			Number(checkpoint.activeThroughMs) < 0 ||
			!clock ||
			clock.activeElapsedMs !== checkpoint.activeThroughMs ||
			!Number.isSafeInteger(clock.wallMs) ||
			Number(clock.wallMs) < 0 ||
			typeof clock.paused !== "boolean" ||
			!Array.isArray(checkpoint.objects) ||
			checkpoint.objects.length > 256
		)
			return fail(400, "Invalid checkpoint descriptor.");
		if (sequence > 1) {
			const previousObject = await bucket.get(sequenceKey(id, sequence - 1));
			if (!previousObject)
				return fail(409, "Previous checkpoint is not yet acknowledged.");
			const previous = await previousObject.json<{ activeThroughMs: number }>();
			if (Number(checkpoint.activeThroughMs) < previous.activeThroughMs)
				return fail(400, "Checkpoint active clock moved backwards.");
		}
		for (const reference of checkpoint.objects) {
			if (
				!reference ||
				typeof reference !== "object" ||
				typeof reference.kind !== "string" ||
				!kinds.has(reference.kind) ||
				typeof reference.sha256 !== "string" ||
				!HASH.test(reference.sha256) ||
				!Number.isSafeInteger(reference.size) ||
				reference.size < 0 ||
				reference.size > MAX_BYTES ||
				!Number.isSafeInteger(reference.activeStartMs) ||
				!Number.isSafeInteger(reference.activeEndMs) ||
				reference.activeStartMs < 0 ||
				reference.activeEndMs < reference.activeStartMs ||
				reference.activeEndMs > Number(checkpoint.activeThroughMs)
			)
				return fail(400, "Invalid checkpoint object reference.");
			if (
				[
					"microphone",
					"systemAudio",
					"microphoneInit",
					"systemAudioInit",
					"transcriptWords",
				].includes(reference.kind) &&
				(typeof reference.source !== "string" ||
					!/^[\w:.-]{1,128}$/.test(reference.source))
			)
				return fail(
					400,
					"Audio and transcript sources must be explicitly identified.",
				);
			if (
				reference.byteStart !== undefined ||
				reference.byteEnd !== undefined
			) {
				if (
					!Number.isSafeInteger(reference.byteStart) ||
					!Number.isSafeInteger(reference.byteEnd) ||
					reference.byteStart < 0 ||
					reference.byteEnd <= reference.byteStart
				)
					return fail(400, "Invalid audio byte range.");
			}
			const object = await bucket.head(
				`${prefix(id)}objects/${reference.sha256}`,
			);
			if (
				!object ||
				object.size !== reference.size ||
				object.customMetadata?.sha256 !== reference.sha256
			)
				return fail(409, "Checkpoint refers to missing or mismatched data.");
		}
		await live(bucket, id, owner);
		await immutable(bucket, key, bytes, hash);
		await live(bucket, id, owner);
		return result({ sequence, sha256: hash, acknowledged: true });
	}
	return fail(405, "Method not allowed.");
}

export async function recovery(
	request: Request,
	bucket: R2Bucket,
	owner: string,
): Promise<Response> {
	try {
		return await route(request, bucket, owner);
	} catch (error) {
		if (error instanceof RecoveryError)
			return result({ error: error.message }, error.status);
		throw error;
	}
}
