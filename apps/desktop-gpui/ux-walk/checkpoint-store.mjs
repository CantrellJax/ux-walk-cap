import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MAX_OBJECT_BYTES = 8 * 1024 * 1024;
export const CHECKPOINT_KINDS = new Set([
	"journal",
	"events",
	"clock",
	"microphone",
	"systemAudio",
	"microphoneInit",
	"systemAudioInit",
	"transcriptWords",
]);
export const sha256 = (bytes) =>
	createHash("sha256").update(bytes).digest("hex");

export function syncDirectory(directory) {
	const fd = fs.openSync(directory, "r");
	try {
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

export function durableMkdir(directory) {
	if (fs.existsSync(directory)) {
		if (!fs.statSync(directory).isDirectory())
			throw new Error("Checkpoint directory is not a directory");
		return;
	}
	const parent = path.dirname(directory);
	durableMkdir(parent);
	try {
		fs.mkdirSync(directory, { mode: 0o700 });
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
	}
	syncDirectory(parent);
	syncDirectory(directory);
}

export function durableWrite(file, bytes) {
	const directory = path.dirname(file);
	durableMkdir(directory);
	const temporary = path.join(directory, `.checkpoint-${randomUUID()}.tmp`);
	try {
		const fd = fs.openSync(temporary, "wx", 0o600);
		try {
			fs.writeFileSync(fd, bytes);
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		fs.renameSync(temporary, file);
		syncDirectory(directory);
	} finally {
		fs.rmSync(temporary, { force: true });
	}
}

export const durableJson = (file, value) =>
	durableWrite(file, `${JSON.stringify(value)}\n`);
export const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

export function completeJsonlPrefix(file, start = 0, limit = MAX_OBJECT_BYTES) {
	const size = fs.statSync(file).size;
	if (start > size) throw new Error("Event source was truncated");
	const bytes = Buffer.alloc(Math.min(limit, size - start));
	const fd = fs.openSync(file, "r");
	let count;
	try {
		count = fs.readSync(fd, bytes, 0, bytes.length, start);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	const whole = bytes.subarray(0, count);
	const end = whole.lastIndexOf(10) + 1;
	const complete = whole.subarray(0, end);
	for (const line of complete.toString("utf8").split("\n").filter(Boolean))
		JSON.parse(line);
	return { bytes: complete, end: start + end };
}

function validClock(clock) {
	return (
		Number.isSafeInteger(clock?.wallMs) &&
		clock.wallMs >= 0 &&
		Number.isSafeInteger(clock.activeElapsedMs) &&
		clock.activeElapsedMs >= 0 &&
		typeof clock.paused === "boolean"
	);
}

export class CheckpointStore {
	constructor(directory, options) {
		this.root = path.join(directory, "checkpoints");
		this.options = options;
		for (const name of ["objects", "descriptors", "acks", "jobs"])
			durableMkdir(path.join(this.root, name));
		const identityFile = path.join(this.root, "identity.json");
		if (fs.existsSync(identityFile)) {
			const existing = readJson(identityFile);
			if (
				existing.recordingId !== options.recordingId ||
				existing.generation !== options.generation ||
				existing.endpoint !== options.endpoint
			)
				throw new Error("Checkpoint identity or server endpoint changed");
		} else durableJson(identityFile, { schemaVersion: 1, ...options });
		const descriptors = this.descriptors();
		let previous = 0;
		for (const descriptor of descriptors) {
			if (
				descriptor.sequence !== previous + 1 ||
				descriptor.previousSequence !== previous ||
				descriptor.recordingId !== options.recordingId ||
				descriptor.writerGeneration !== options.generation ||
				!validClock(descriptor.clock)
			)
				throw new Error("Checkpoint sequence or identity is invalid");
			previous = descriptor.sequence;
		}
		let remoteSequence = 0;
		for (const descriptor of descriptors) {
			const receipt = path.join(
				this.root,
				"acks",
				`${descriptor.sequence}.json`,
			);
			if (!fs.existsSync(receipt)) break;
			const ack = readJson(receipt);
			if (
				ack.endpoint !== options.endpoint ||
				ack.descriptorHash !== sha256(Buffer.from(JSON.stringify(descriptor)))
			)
				break;
			remoteSequence = descriptor.sequence;
		}
		this.state = {
			schemaVersion: 1,
			sequence: previous,
			remoteSequence,
			localClockThroughMs: descriptors.at(-1)?.clock.activeElapsedMs ?? 0,
			remoteClockThroughMs:
				descriptors.find((item) => item.sequence === remoteSequence)?.clock
					.activeElapsedMs ?? 0,
		};
		this.save();
	}
	objectPath(hash) {
		if (!/^[a-f0-9]{64}$/.test(hash))
			throw new Error("Invalid object checksum");
		return path.join(this.root, "objects", hash);
	}
	put(kind, data, range) {
		if (!CHECKPOINT_KINDS.has(kind))
			throw new Error("Unsupported checkpoint object kind");
		const bytes = Buffer.from(data);
		if (bytes.length > MAX_OBJECT_BYTES)
			throw new Error("Checkpoint object exceeds size limit");
		const hash = sha256(bytes);
		const file = this.objectPath(hash);
		if (!fs.existsSync(file)) durableWrite(file, bytes);
		if (sha256(fs.readFileSync(file)) !== hash)
			throw new Error("Checkpoint object integrity checksum failed");
		return { ...range, kind, sha256: hash, size: bytes.length };
	}
	verify(object) {
		if (
			!CHECKPOINT_KINDS.has(object.kind) ||
			!Number.isSafeInteger(object.size) ||
			object.size < 0 ||
			object.size > MAX_OBJECT_BYTES
		)
			throw new Error("Invalid checkpoint object integrity metadata");
		const file = this.objectPath(object.sha256);
		if (
			fs.lstatSync(file).isSymbolicLink() ||
			fs.statSync(file).size !== object.size
		)
			throw new Error("Checkpoint object integrity size changed");
		const bytes = fs.readFileSync(file);
		if (bytes.length !== object.size || sha256(bytes) !== object.sha256)
			throw new Error("Checkpoint object integrity checksum failed");
		return bytes;
	}
	commit(objects, clock, extra = {}) {
		if (
			!validClock(clock) ||
			clock.activeElapsedMs < this.state.localClockThroughMs
		)
			throw new Error("Checkpoint clock moved backwards");
		if (objects.length > 256)
			throw new Error("Too many objects in one checkpoint");
		for (const object of objects) this.verify(object);
		const descriptor = {
			schemaVersion: 1,
			recordingId: this.options.recordingId,
			writerGeneration: this.options.generation,
			sequence: this.state.sequence + 1,
			previousSequence: this.state.sequence,
			activeThroughMs: clock.activeElapsedMs,
			clock,
			objects,
			...extra,
		};
		durableJson(
			path.join(
				this.root,
				"descriptors",
				`${String(descriptor.sequence).padStart(12, "0")}.json`,
			),
			descriptor,
		);
		this.state.sequence = descriptor.sequence;
		this.state.localClockThroughMs = clock.activeElapsedMs;
		this.save();
		return descriptor;
	}
	descriptors() {
		return fs
			.readdirSync(path.join(this.root, "descriptors"))
			.filter((name) => /^\d{12}\.json$/.test(name))
			.sort()
			.map((name) => readJson(path.join(this.root, "descriptors", name)));
	}
	pending() {
		return this.descriptors().filter(
			(descriptor) => descriptor.sequence > this.state.remoteSequence,
		);
	}
	acknowledge(sequence, endpoint) {
		if (endpoint !== this.options.endpoint)
			throw new Error("Checkpoint backup server endpoint changed");
		if (
			sequence !== this.state.remoteSequence + 1 ||
			sequence > this.state.sequence
		)
			throw new Error("Checkpoint acknowledgement is out of order");
		const descriptor = this.descriptors().find(
			(item) => item.sequence === sequence,
		);
		durableJson(path.join(this.root, "acks", `${sequence}.json`), {
			endpoint,
			descriptorHash: sha256(Buffer.from(JSON.stringify(descriptor))),
			acknowledgedAt: Date.now(),
		});
		this.state.remoteSequence = sequence;
		this.state.remoteClockThroughMs = descriptor.clock.activeElapsedMs;
		this.save();
	}
	save() {
		durableJson(path.join(this.root, "state.json"), this.state);
	}
}
