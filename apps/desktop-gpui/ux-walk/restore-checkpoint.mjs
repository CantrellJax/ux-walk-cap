import fs from "node:fs";
import path from "node:path";
import { projectMeetCaptions } from "./browser-evidence.mjs";
import {
	CHECKPOINT_KINDS,
	durableJson,
	durableMkdir,
	durableWrite,
	MAX_OBJECT_BYTES,
	sha256,
	syncDirectory,
} from "./checkpoint-store.mjs";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sourceId = /^[\w:.-]{1,128}$/;
const escape = (text) =>
	String(text ?? "").replace(
		/[&<>"']/g,
		(character) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				character
			],
	);

export async function restoreRecovery(transport, recordingId, destination) {
	if (!uuid.test(recordingId))
		throw new Error("Invalid recovery recording identity");
	if (!path.isAbsolute(destination) || fs.existsSync(destination))
		throw new Error(
			"Restore into a new absolute directory that does not exist",
		);
	const pages = [];
	let cursor;
	let registration;
	do {
		const page = await transport.request(
			"GET",
			`/api/v1/recovery/${recordingId}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
		);
		if (
			page.recordingId !== recordingId ||
			!uuid.test(page.writerGeneration) ||
			!Array.isArray(page.checkpoints)
		)
			throw new Error("Recovery identity is invalid");
		registration ??= page;
		if (registration.writerGeneration !== page.writerGeneration)
			throw new Error("Recovery generation changed");
		pages.push(...page.checkpoints);
		cursor = page.cursor;
		if (pages.length > 100000)
			throw new Error("Recovery checkpoint count exceeds the supported limit");
	} while (cursor);
	pages.sort((left, right) => left.sequence - right.sequence);
	let previous = 0;
	let active = 0;
	for (const descriptor of pages) {
		if (
			descriptor.recordingId !== recordingId ||
			descriptor.writerGeneration !== registration.writerGeneration ||
			descriptor.sequence !== previous + 1 ||
			descriptor.previousSequence !== previous ||
			!Number.isSafeInteger(descriptor.clock?.activeElapsedMs) ||
			descriptor.clock.activeElapsedMs < active ||
			!Array.isArray(descriptor.objects) ||
			!Number.isSafeInteger(descriptor.clock.wallMs) ||
			descriptor.clock.wallMs < 0 ||
			typeof descriptor.clock.paused !== "boolean"
		)
			throw new Error(
				"Recovery checkpoint sequence, clock or identity is invalid",
			);
		previous = descriptor.sequence;
		active = descriptor.clock.activeElapsedMs;
		for (const object of descriptor.objects) {
			if (
				!CHECKPOINT_KINDS.has(object.kind) ||
				!/^[a-f0-9]{64}$/.test(object.sha256) ||
				!Number.isSafeInteger(object.size) ||
				object.size < 0 ||
				object.size > MAX_OBJECT_BYTES ||
				!Number.isSafeInteger(object.activeStartMs) ||
				!Number.isSafeInteger(object.activeEndMs) ||
				object.activeStartMs < 0 ||
				object.activeEndMs < object.activeStartMs ||
				object.activeEndMs > active
			)
				throw new Error("Recovery object integrity metadata is invalid");
			if (
				[
					"microphone",
					"systemAudio",
					"microphoneInit",
					"systemAudioInit",
					"transcriptWords",
				].includes(object.kind) &&
				!sourceId.test(object.source)
			)
				throw new Error("Recovery source identity is invalid");
			if (
				["microphone", "systemAudio", "transcriptWords"].includes(
					object.kind,
				) &&
				(!Number.isFinite(object.sourceStartMs) ||
					!Number.isFinite(object.sourceEndMs) ||
					object.sourceStartMs < 0 ||
					object.sourceEndMs < object.sourceStartMs)
			)
				throw new Error("Recovery source presentation range is invalid");
			if (
				["microphone", "systemAudio"].includes(object.kind) &&
				object.encoding !== "standalone" &&
				(!Number.isSafeInteger(object.headerSize) ||
					object.headerSize < 0 ||
					object.headerSize > object.size ||
					!/^[a-f0-9]{64}$/.test(object.initHash) ||
					object.byteStart === undefined)
			)
				throw new Error("Recovery fragment header or byte range is invalid");
			if (
				object.byteStart !== undefined &&
				(!Number.isSafeInteger(object.byteStart) ||
					!Number.isSafeInteger(object.byteEnd) ||
					object.byteStart < 0 ||
					object.byteEnd <= object.byteStart ||
					(["microphone", "systemAudio"].includes(object.kind) &&
						object.encoding !== "standalone" &&
						object.byteEnd - object.byteStart + (object.headerSize ?? 0) !==
							object.size))
			)
				throw new Error("Recovery source byte range is invalid");
		}
	}
	durableMkdir(destination);
	const objectsDir = path.join(destination, "recovered-objects");
	durableMkdir(objectsDir);
	const seen = new Set();
	const records = [];
	for (const descriptor of pages)
		for (const object of descriptor.objects) {
			const file = path.join(objectsDir, object.sha256);
			if (!fs.existsSync(file))
				await transport.request(
					"GET",
					`/api/v1/recovery/${recordingId}/objects/${object.sha256}`,
					{ output: file },
				);
			if (
				fs.lstatSync(file).isSymbolicLink() ||
				fs.statSync(file).size !== object.size ||
				sha256(fs.readFileSync(file)) !== object.sha256
			)
				throw new Error("Downloaded recovery object checksum integrity failed");
			const identity = `${object.kind}:${object.source ?? ""}:${object.byteStart ?? object.activeStartMs}:${object.sha256}`;
			if (!seen.has(identity)) {
				records.push({ ...object, file });
				seen.add(identity);
			}
		}
	let savedJournal = {};
	let clockData = {};
	let eventEnd = 0;
	const words = [];
	const eventFile = path.join(destination, "browser-evidence.jsonl");
	const eventFd = fs.openSync(eventFile, "wx", 0o600);
	try {
		for (const object of records) {
			if (object.kind === "journal")
				savedJournal = JSON.parse(fs.readFileSync(object.file, "utf8"));
			if (object.kind === "clock")
				clockData = {
					...clockData,
					...JSON.parse(fs.readFileSync(object.file, "utf8")),
				};
			if (object.kind === "transcriptWords")
				words.push(JSON.parse(fs.readFileSync(object.file, "utf8")));
			if (object.kind === "events") {
				const bytes = fs.readFileSync(object.file);
				if (
					!Number.isSafeInteger(object.byteStart) ||
					object.byteStart !== eventEnd ||
					object.byteEnd - object.byteStart !== bytes.length
				)
					throw new Error(
						"Recovery event byte ranges contain a gap or are not contiguous",
					);
				eventEnd = object.byteEnd;
				if (bytes.length && bytes.at(-1) !== 10)
					throw new Error("Recovery events contain an incomplete JSONL tail");
				for (const line of bytes.toString("utf8").split("\n").filter(Boolean))
					JSON.parse(line);
				fs.writeFileSync(eventFd, bytes);
			}
		}
		fs.fsyncSync(eventFd);
	} finally {
		fs.closeSync(eventFd);
	}
	const audio = [];
	for (const source of new Set(
		records
			.filter((object) => ["microphone", "systemAudio"].includes(object.kind))
			.map((object) => object.source),
	)) {
		const parts = records
			.filter(
				(object) =>
					object.source === source &&
					["microphone", "systemAudio"].includes(object.kind),
			)
			.sort(
				(left, right) =>
					(left.sourceStartMs ?? left.activeStartMs) -
					(right.sourceStartMs ?? right.activeStartMs),
			);
		const safeSource = sha256(Buffer.from(source)).slice(0, 24);
		const init = records.find(
			(object) =>
				object.source === source &&
				["microphoneInit", "systemAudioInit"].includes(object.kind),
		);
		const fragmentParts = parts.filter(
			(part) => part.encoding !== "standalone",
		);
		if (fragmentParts.length) {
			const relative = `recovered-${safeSource}.m4a`;
			if (!init) throw new Error("Recovery audio initialization is missing");
			const fd = fs.openSync(path.join(destination, relative), "wx", 0o600);
			try {
				fs.writeFileSync(fd, fs.readFileSync(init.file));
				let end = null;
				for (const part of fragmentParts) {
					if (end != null && part.byteStart !== end)
						throw new Error("Recovery audio fragments are not contiguous");
					const bytes = fs.readFileSync(part.file);
					if (
						part.initHash !== init.sha256 ||
						sha256(bytes.subarray(0, part.headerSize)) !== init.sha256
					)
						throw new Error("Recovery audio initialization identity changed");
					fs.writeFileSync(fd, bytes.subarray(part.headerSize));
					end = part.byteEnd;
				}
				fs.fsyncSync(fd);
			} finally {
				fs.closeSync(fd);
			}
			audio.push({ source, relative });
		}
		for (const part of parts.filter((part) => part.encoding === "standalone")) {
			const relative = `recovered-${safeSource}-${part.sha256.slice(0, 12)}.${part.container === "wav" ? "wav" : "m4a"}`;
			durableWrite(
				path.join(destination, relative),
				fs.readFileSync(part.file),
			);
			audio.push({ source, relative });
		}
	}
	const sourceProject = path.join(destination, "recovered.cap");
	durableMkdir(sourceProject);
	const journal = {
		schemaVersion: 1,
		request: {
			directory: destination,
			topic:
				savedJournal.request?.topic ?? registration.title ?? "Recovered walk",
			url: "",
			speakers: [],
		},
		sourceProject,
		startedAtMs: savedJournal.startedAtMs ?? registration.startedAtMs ?? 0,
		state: "aborted",
		durationMs: null,
		events: Array.isArray(savedJournal.events) ? savedJournal.events : [],
	};
	durableJson(path.join(destination, "native-walk.json"), journal);
	if (clockData.browser)
		durableJson(path.join(destination, "browser-evidence.json"), {
			...clockData.browser,
			journal: path.join(destination, "native-walk.json"),
			sourceProject,
			state: "aborted",
			reason:
				"Recovered critical evidence; video capture completeness is unverified",
		});
	durableJson(path.join(destination, "transcript-sources.json"), {
		schemaVersion: 1,
		interrupted: true,
		chunks: words,
		speakerIdentity: "Source and chunk labels are provisional across requests",
	});
	const notes = [
		...journal.events,
		...(clockData.noteDraft
			? [{ text: `Unsubmitted note draft: ${clockData.noteDraft}` }]
			: []),
	]
		.map((event) => `<li>${escape(event.text)}</li>`)
		.join("");
	const speech = words
		.flatMap((chunk) =>
			(chunk.words ?? []).map(
				(word) =>
					`<li>${escape(chunk.source)} · ${escape(word.start)}s: ${escape(word.text)}</li>`,
			),
		)
		.join("");
	const meet = projectMeetCaptions(
		fs
			.readFileSync(eventFile, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line)),
		journal.startedAtMs,
		active,
	);
	durableWrite(
		path.join(destination, "meet.jsonl"),
		meet.map((event) => JSON.stringify(event)).join("\n") +
			(meet.length ? "\n" : ""),
	);
	const meetHtml = meet
		.map(
			(event) =>
				`<li>${escape(event.nativeOffsetMs)}ms · ${escape(event.name)} (unconfirmed): ${escape(event.text)}</li>`,
		)
		.join("");
	durableWrite(
		path.join(destination, "report.html"),
		`<!doctype html><meta charset="utf-8"><title>Recovered walk evidence</title><h1>${escape(journal.request.topic)}</h1><p>Interrupted recording. Critical evidence was recovered without a finalized video. Audio and transcript timestamps are qualified by source; global alignment may be incomplete.</p><h2>Notes</h2><ul>${notes}</ul><h2>Audio</h2>${audio.map((item) => `<p>${escape(item.source)}</p><audio controls src="${item.relative}"></audio>`).join("")}<h2>Speech</h2><p>Speaker labels may change between chunks.</p><ul>${speech}</ul><h2>Meet caption evidence</h2><p>Names and caption timing are unconfirmed. Audio remains the speech source.</p><ul>${meetHtml}</ul><p><a href="browser-evidence.jsonl">Click, error and meeting evidence</a> · <a href="meet.jsonl">Projected Meet captions</a> · <a href="transcript-sources.json">Transcript source data</a></p>`,
	);
	durableJson(path.join(destination, "recovery-ready.json"), {
		recordingId,
		generation: registration.writerGeneration,
		checkpointSequence: previous,
		clockThroughMs: active,
		interrupted: true,
		verifiedObjects: seen.size,
		audio,
	});
	syncDirectory(destination);
	return destination;
}
