import fs from "node:fs";
import path from "node:path";
import {
	durableJson,
	durableWrite,
	readJson,
	sha256,
} from "./checkpoint-store.mjs";

function read(file) {
	try {
		return readJson(file);
	} catch {
		return null;
	}
}
function hashFile(file) {
	return fs.existsSync(file) ? sha256(fs.readFileSync(file)) : null;
}
function fields(metadata) {
	const result = {};
	if (
		metadata?.speakerMap &&
		typeof metadata.speakerMap === "object" &&
		!Array.isArray(metadata.speakerMap) &&
		Object.values(metadata.speakerMap).every(
			(value) => typeof value === "string",
		)
	)
		result.speakerMap = metadata.speakerMap;
	if (
		Array.isArray(metadata?.speakers) &&
		metadata.speakers.every((value) => typeof value === "string")
	)
		result.speakers = metadata.speakers;
	if (metadata?.speakerIdentity != null)
		result.speakerIdentity = metadata.speakerIdentity;
	return result;
}
function same(left, right) {
	return JSON.stringify(left) === JSON.stringify(right);
}
function sameTranscript(left, right) {
	return (
		left?.srt === right?.srt &&
		left?.requestId === right?.requestId &&
		same(left?.voices ?? null, right?.voices ?? null)
	);
}
function sameChapter(left, right) {
	return (
		["n", "dir", "name", "kind", "startMs", "endMs"].every(
			(key) => left?.[key] === right[key],
		) &&
		left?.sourceRange?.startS === right.sourceRange.startS &&
		left?.sourceRange?.endS === right.sourceRange.endS &&
		left?.sourceProject === right.sourceProject
	);
}

export class ChapterAttribution {
	constructor(file, journal, project, { replace = false } = {}) {
		this.file = fs.realpathSync(file);
		this.journal = journal;
		this.directory = journal.request.directory;
		this.project = project;
		this.replace = replace;
		this.prior = new Map();
		this.generated = new Map();
		for (const entry of fs
			.readdirSync(this.directory, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())) {
			const directory = path.join(this.directory, entry.name);
			const metadata = read(path.join(directory, "chapter.json"));
			if (!metadata) continue;
			const manual =
				metadata.speakerMap ||
				metadata.speakerIdentity != null ||
				(Array.isArray(metadata.speakers) &&
					!same(metadata.speakers, journal.request.speakers));
			if (manual)
				this.prior.set(entry.name, {
					metadata,
					key: this.archive(directory, metadata),
				});
			else if (
				/^[a-f0-9]{64}$/.test(metadata.pendingSpeakerAttribution ?? "")
			) {
				const key = metadata.pendingSpeakerAttribution;
				const saved = read(
					path.join(directory, "speaker-attribution-history", `${key}.json`),
				);
				if (
					saved &&
					sha256(
						Buffer.from(
							JSON.stringify({
								metadata: saved.metadata,
								request: saved.request,
								fullRequest: saved.fullRequest,
							}),
						),
					) === key
				)
					this.prior.set(entry.name, { metadata: saved.metadata, key });
			}
		}
	}
	captureIdentity() {
		return sha256(
			Buffer.from(
				JSON.stringify({
					journal: this.file,
					source: fs.realpathSync(this.journal.sourceProject),
					startedAtMs: this.journal.startedAtMs,
					project: fs.realpathSync(this.project),
					metadata: hashFile(path.join(this.project, "recording-meta.json")),
					config: hashFile(path.join(this.project, "project-config.json")),
					manifest: hashFile(path.join(this.directory, "media/media.json")),
				}),
			),
		);
	}
	transcriptIdentity(directory) {
		const srt = hashFile(path.join(directory, "transcript.srt"));
		if (!srt) return null;
		const sources = read(path.join(directory, "transcript-sources.json"));
		const voices = Array.isArray(sources?.words)
			? [
					...new Set(
						sources.words.map((word) =>
							JSON.stringify([word.source, word.jobId, word.speaker]),
						),
					),
				].sort()
			: null;
		return {
			srt,
			voices,
			requestId:
				read(path.join(directory, "full-transcript-request.json"))?.requestId ??
				null,
		};
	}
	archive(directory, metadata) {
		const history = path.join(directory, "speaker-attribution-history");
		if (fs.existsSync(history) && fs.lstatSync(history).isSymbolicLink())
			throw new Error("Speaker attribution history must stay in its chapter");
		const request = read(path.join(directory, "full-transcript-request.json"));
		const fullRequest = read(
			path.join(this.directory, "checkpoints/full-transcript.json"),
		);
		const payload = { metadata, request, fullRequest };
		const key = sha256(Buffer.from(JSON.stringify(payload)));
		const srt = path.join(directory, "transcript.srt");
		if (fs.existsSync(srt)) {
			const bytes = fs.readFileSync(srt);
			const copy = path.join(history, `${sha256(bytes)}.srt`);
			if (!fs.existsSync(copy)) durableWrite(copy, bytes);
		}
		const destination = path.join(history, `${key}.json`);
		if (!fs.existsSync(destination))
			durableJson(destination, {
				schemaVersion: 1,
				...payload,
				archivedAt: Date.now(),
			});
		return key;
	}
	metadata(name, base, final = false) {
		const directory = path.join(this.directory, name);
		const previous = this.prior.get(name);
		const capture = this.captureIdentity();
		const transcript = this.transcriptIdentity(directory);
		const matchedSource =
			!this.replace &&
			previous?.metadata.nativeCaptureIdentity === capture &&
			transcript != null &&
			sameTranscript(previous.metadata.transcriptSourceIdentity, transcript);
		const matched = matchedSource && sameChapter(previous.metadata, base);
		const metadata = {
			...base,
			...(matched ? fields(previous.metadata) : {}),
			nativeCaptureIdentity: capture,
			transcriptSourceIdentity: transcript,
		};
		if (previous) {
			metadata.speakerAttributionArchive = previous.key;
			if (!matched) {
				metadata.speakerAttributionNotice =
					"Previous confirmed attribution is archived; source identity or chapter bounds changed. Confirm speakers again.";
				if (
					!final &&
					matchedSource &&
					["n", "dir", "name", "kind", "sourceProject", "startMs"].every(
						(key) => previous.metadata[key] === base[key],
					) &&
					previous.metadata.sourceRange?.startS === base.sourceRange.startS
				)
					metadata.pendingSpeakerAttribution = previous.key;
			}
		}
		this.generated.set(name, metadata);
		return metadata;
	}
	record(name) {
		const base = this.generated.get(name);
		const directory = path.join(this.directory, name);
		const current = read(path.join(directory, "chapter.json"));
		const transcript = this.transcriptIdentity(directory);
		if (transcript) {
			const copy = path.join(
				directory,
				"speaker-attribution-history",
				`${transcript.srt}.srt`,
			);
			if (!fs.existsSync(copy))
				durableWrite(
					copy,
					fs.readFileSync(path.join(directory, "transcript.srt")),
				);
		}
		const metadata = {
			...base,
			...(sameChapter(current, base) ? fields(current) : {}),
			nativeCaptureIdentity: this.captureIdentity(),
			transcriptSourceIdentity: transcript,
		};
		durableJson(path.join(directory, "chapter.json"), metadata);
		return metadata;
	}
}
