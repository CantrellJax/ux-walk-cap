import fs from "node:fs";
import path from "node:path";
import {
	durableJson,
	durableWrite,
	readJson,
	sha256,
} from "./checkpoint-store.mjs";

import { sourceAudioProblem } from "./native-audio.mjs";

const local = new URL("./src/transcribe.mjs", import.meta.url);
const engine = fs.existsSync(local)
	? new URL("./src/", import.meta.url)
	: new URL("../../../vendor/ux-walk/src/", import.meta.url);

export async function reuseCheckpointTranscript(
	directory,
	rows,
	startedAtMs,
	cfg = {},
) {
	const root = path.join(directory, "checkpoints");
	const jobsRoot = path.join(root, "jobs");
	if (!fs.existsSync(jobsRoot)) return { handled: false };
	const jobs = fs
		.readdirSync(jobsRoot)
		.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
		.map((name) => readJson(path.join(jobsRoot, name)));
	if (!jobs.length) {
		if (
			!fs.existsSync(path.join(root, "identity.json")) ||
			cfg.liveTranscription === false ||
			!["elevenlabs", "assemblyai"].includes(cfg.transcriber)
		)
			return { handled: false };
		const error =
			"Live transcription is pending or draining. Source audio is retained; reprocess after the checkpoint worker finishes.";
		return {
			handled: true,
			error,
			results: new Map(
				rows.map((row) => [
					row.dir,
					{ transcript: false, transcriptError: error },
				]),
			),
		};
	}
	const results = new Map();
	let error = null;
	let layout;
	try {
		layout = readJson(path.join(root, "final-layout.json"));
	} catch {
		error =
			"Live transcript source clocks are retained; final display alignment is not yet available. Retry preparation after checkpoint draining finishes.";
	}
	const mapped = [];
	let complete = true;
	let base = 0;
	if (layout) {
		const config = layout.config ?? {};
		const spans = layout.displaySpans;
		const unsupported =
			layout.alignmentProblem ||
			sourceAudioProblem(null, config) ||
			!Array.isArray(spans) ||
			spans.length !== layout.meta?.segments?.length ||
			spans.some((span) => !(span > 0)) ||
			config.timeline?.segments?.some(
				(span, index) =>
					span.recordingSegment !== index ||
					span.start !== 0 ||
					span.timescale !== 1 ||
					(span.volume ?? 1) !== 1 ||
					Math.abs(span.end - spans[index]) > 0.15,
			);
		if (unsupported)
			error =
				"Live transcript is retained with source clocks; edited timeline alignment requires an explicit full transcription retry.";
		else
			for (const [index, segment] of layout.meta.segments.entries()) {
				const duration = spans[index];
				for (const [side, kind, gainKey] of [
					["mic", "microphone", "micVolumeDb"],
					["system_audio", "systemAudio", "systemVolumeDb"],
				]) {
					if (
						!segment[side] ||
						config.audio?.mute ||
						(config.audio?.[gainKey] ?? 0) < -30
					)
						continue;
					const source = `segment-${index}:${kind}`;
					const matching = jobs
						.filter((job) => job.source === source)
						.sort((a, b) => a.sourceStartMs - b.sourceStartMs);
					const tracks = [
						segment.display,
						segment.camera,
						segment.mic,
						segment.system_audio,
					].filter(Boolean);
					const latest = tracks.every((track) =>
						Number.isFinite(track.start_time),
					)
						? Math.max(...tracks.map((track) => track.start_time))
						: null;
					const clip = config.clips?.find(
						(item) => (item.index ?? 0) === index,
					);
					const offset = config.clips?.length
						? (clip?.offsets?.[side] ?? 0)
						: latest == null
							? 0
							: latest - segment[side].start_time;
					if (!Number.isFinite(offset)) {
						complete = false;
						continue;
					}
					let covered = 0;
					for (const job of matching) {
						if (job.state !== "complete" || job.sourceStartMs > covered + 1) {
							complete = false;
							continue;
						}
						const file = path.join(jobsRoot, `${job.jobId}.words.json`);
						if (
							!fs.existsSync(file) ||
							sha256(fs.readFileSync(file)) !== job.resultHash
						) {
							complete = false;
							continue;
						}
						const result = readJson(file);
						if (result.source !== source || !Array.isArray(result.words)) {
							complete = false;
							continue;
						}
						covered = Math.max(covered, job.sourceEndMs);
						for (const word of result.words) {
							const start = Math.max(base, base + word.start - offset);
							const end = Math.min(base + duration, base + word.end - offset);
							if (Number.isFinite(start) && end > start)
								mapped.push({ ...word, start, end, source, jobId: job.jobId });
						}
					}
					if (
						covered / 1000 <
						(layout.sourceDurations?.[source] ?? duration + offset) - 0.15
					)
						complete = false;
				}
				base += duration;
			}
	}
	if (!complete && !error)
		error =
			"Partial live transcript: some source audio is pending, failed or ambiguous. Saved jobs are reused without another automatic billable submission.";
	const { wordsToSrt } = await import(new URL("transcribe.mjs", engine));
	mapped.sort((a, b) => a.start - b.start || a.source.localeCompare(b.source));
	for (const row of rows) {
		const start = (row.startMs - startedAtMs) / 1000;
		const end = (row.endMs - startedAtMs) / 1000;
		const words = mapped
			.filter((word) => word.end > start && word.start < end)
			.map((word) => ({
				...word,
				start: Math.max(0, word.start - start),
				end: Math.min(end - start, word.end - start),
			}));
		const chapter = path.join(directory, row.dir);
		const srt = path.join(chapter, "transcript.srt");
		if (
			!words.length &&
			fs.existsSync(path.join(chapter, "transcript-sources.json")) &&
			fs.existsSync(srt)
		) {
			const bytes = fs.readFileSync(srt);
			durableWrite(
				path.join(
					chapter,
					`transcript-source-${sha256(bytes).slice(0, 12)}.srt`,
				),
				bytes,
			);
			fs.unlinkSync(srt);
		}
		durableJson(path.join(chapter, "transcript-sources.json"), {
			schemaVersion: 1,
			words,
			complete: !error,
			speakerIdentity:
				"Labels belong to one source and chunk; identities are not matched across requests",
			...(error ? { error } : {}),
		});
		if (words.length)
			durableWrite(path.join(chapter, "transcript.srt"), wordsToSrt(words));
		results.set(row.dir, {
			transcript: words.length > 0,
			...(error ? { transcriptError: error } : {}),
		});
	}
	return { handled: true, results, error };
}
