import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { durableJson, readJson, sha256 } from "./checkpoint-store.mjs";

const execute = promisify(execFile);
const local = new URL("./src/transcribe.mjs", import.meta.url);
const engine = fs.existsSync(local)
	? new URL("./src/", import.meta.url)
	: new URL("../../../vendor/ux-walk/src/", import.meta.url);

const GAP_S = 1.5;
const MIN_SAMPLE_S = 1.2;
const MAX_SAMPLE_S = 8;
const MAX_LINEUP_S = 240;
const MIN_VOTE_SHARE = 0.6;

const voicesFile = (root) => path.join(root, "voices.json");
const lineupFile = (root) => path.join(root, "voices-lineup.wav");

function completeJobs(root) {
	const jobsRoot = path.join(root, "jobs");
	if (!fs.existsSync(jobsRoot)) return null;
	const jobs = fs
		.readdirSync(jobsRoot)
		.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
		.map((name) => readJson(path.join(jobsRoot, name)));
	if (!jobs.length || jobs.some((job) => job.state !== "complete")) return null;
	const loaded = [];
	for (const job of jobs) {
		const file = path.join(jobsRoot, `${job.jobId}.words.json`);
		if (
			!fs.existsSync(file) ||
			sha256(fs.readFileSync(file)) !== job.resultHash
		)
			return null;
		const result = readJson(file);
		if (!Array.isArray(result.words)) return null;
		loaded.push({ job, words: result.words });
	}
	return loaded.sort(
		(left, right) =>
			segmentOf(left.job.source) - segmentOf(right.job.source) ||
			left.job.sourceStartMs - right.job.sourceStartMs ||
			left.job.source.localeCompare(right.job.source),
	);
}

const segmentOf = (source) => Number(/^segment-(\d+):/.exec(source)?.[1] ?? 0);

export function voiceInputHash(loaded) {
	return sha256(
		Buffer.from(
			JSON.stringify(
				loaded
					.map(({ job }) => [job.jobId, job.resultHash])
					.sort((left, right) => left[0].localeCompare(right[0])),
			),
		),
	);
}

function labelsOf(loaded) {
	const labels = new Map();
	for (const { job, words } of loaded) {
		const sorted = [...words].sort((a, b) => a.start - b.start);
		for (const [index, word] of sorted.entries()) {
			const label = labels.get(word.speaker) ?? {
				label: word.speaker,
				jobId: job.jobId,
				source: job.source,
				contextStartMs: job.contextStartMs ?? job.sourceStartMs,
				firstAt: [segmentOf(job.source), word.start],
				words: 0,
				runs: [],
			};
			label.words += 1;
			const previous = sorted[index - 1];
			const run = label.runs.at(-1);
			if (
				run &&
				previous?.speaker === word.speaker &&
				word.start - run.end <= 1 &&
				word.end - run.start <= MAX_SAMPLE_S
			) {
				run.end = word.end;
				run.text += ` ${word.text.trim()}`;
				run.words += 1;
			} else
				label.runs.push({
					start: word.start,
					end: word.end,
					text: word.text.trim(),
					words: 1,
				});
			labels.set(word.speaker, label);
		}
	}
	return [...labels.values()];
}

function pickSamples(labels) {
	const samples = [];
	let budget = MAX_LINEUP_S;
	for (const pass of [0, 1])
		for (const label of labels) {
			const run = [...label.runs]
				.filter((item) => item.end - item.start >= MIN_SAMPLE_S)
				.sort((a, b) => b.end - b.start - (a.end - a.start))[pass];
			if (!run) continue;
			const duration = run.end - run.start;
			if (budget < duration + GAP_S) continue;
			budget -= duration + GAP_S;
			samples.push({ label: label.label, jobId: label.jobId, ...run });
		}
	return samples;
}

export function sampleClip(label) {
	const best = [...label.runs].sort(
		(a, b) => b.words - a.words || b.end - b.start - (a.end - a.start),
	)[0];
	return best
		? {
				jobId: label.jobId,
				start: best.start,
				end: best.end,
				text: best.text,
			}
		: null;
}

async function buildLineup(root, samples, contextStart, media) {
	const args = ["-v", "error", "-nostdin", "-y"];
	const filters = [];
	const labels = [];
	const spans = [];
	let cursor = 0;
	for (const [index, sample] of samples.entries()) {
		const offset = Math.max(0, sample.start - contextStart.get(sample.jobId));
		const duration = sample.end - sample.start;
		args.push("-i", path.join(root, "jobs", `${sample.jobId}.wav`));
		filters.push(
			`[${index}:a:0]aresample=16000,aformat=channel_layouts=mono,atrim=start=${offset}:duration=${duration},asetpts=PTS-STARTPTS,apad=whole_dur=${duration + GAP_S}[s${index}]`,
		);
		labels.push(`[s${index}]`);
		spans.push({
			...sample,
			lineupStart: cursor,
			lineupEnd: cursor + duration,
		});
		cursor += duration + GAP_S;
	}
	filters.push(`${labels.join("")}concat=n=${labels.length}:v=0:a=1[out]`);
	const output = lineupFile(root);
	const temporary = `${output}.tmp.wav`;
	await media(
		"ffmpeg",
		[
			...args,
			"-filter_complex",
			filters.join(";"),
			"-map",
			"[out]",
			"-c:a",
			"pcm_s16le",
			temporary,
		],
		{ timeout: 60000 },
	);
	fs.renameSync(temporary, output);
	return { output, spans };
}

export function groupVoices(labels, spans, words) {
	const votes = new Map();
	for (const span of spans) {
		const counts = new Map();
		for (const word of words) {
			const middle = (word.start + word.end) / 2;
			if (
				word.speaker != null &&
				middle >= span.lineupStart &&
				middle <= span.lineupEnd
			)
				counts.set(word.speaker, (counts.get(word.speaker) ?? 0) + 1);
		}
		const total = [...counts.values()].reduce((a, b) => a + b, 0);
		const [winner, count] = [...counts.entries()].sort(
			(a, b) => b[1] - a[1],
		)[0] ?? [null, 0];
		if (!winner || count / total < MIN_VOTE_SHARE) continue;
		const vote = votes.get(span.label) ?? new Map();
		vote.set(winner, (vote.get(winner) ?? 0) + count);
		votes.set(span.label, vote);
	}
	const assigned = new Map();
	for (const label of labels) {
		const vote = votes.get(label.label);
		if (!vote) continue;
		const [winner, count] = [...vote.entries()].sort((a, b) => b[1] - a[1])[0];
		assigned.set(label.label, { lineup: winner, count });
	}
	const byJob = new Map();
	for (const label of labels) {
		const pick = assigned.get(label.label);
		if (!pick) continue;
		const key = `${label.jobId}\u0000${pick.lineup}`;
		const rival = byJob.get(key);
		if (!rival) {
			byJob.set(key, label);
			continue;
		}
		const weaker =
			assigned.get(rival.label).count >= pick.count ? label : rival;
		assigned.delete(weaker.label);
		if (weaker === rival) byJob.set(key, label);
	}
	const groups = new Map();
	for (const label of [...labels].sort(
		(a, b) => a.firstAt[0] - b.firstAt[0] || a.firstAt[1] - b.firstAt[1],
	)) {
		const key = assigned.has(label.label)
			? `lineup:${assigned.get(label.label).lineup}`
			: `label:${label.label}`;
		const group = groups.get(key) ?? [];
		group.push(label);
		groups.set(key, group);
	}
	const total = labels.reduce((sum, label) => sum + label.words, 0) || 1;
	return [...groups.values()].map((members, index) => {
		const best = [...members].sort((a, b) => b.words - a.words)[0];
		const count = members.reduce((sum, label) => sum + label.words, 0);
		return {
			id: `voice-${index + 1}`,
			labels: members.map((label) => label.label),
			words: count,
			stray: count / total < 0.02,
			sources: [...new Set(members.map((label) => label.source))],
			sample: sampleClip(best),
		};
	});
}

export function readVoices(root) {
	try {
		const voices = readJson(voicesFile(root));
		return voices.schemaVersion === 1 && Array.isArray(voices.voices)
			? voices
			: null;
	} catch {
		return null;
	}
}

export function currentVoices(root) {
	const voices = readVoices(root);
	const loaded = voices && completeJobs(root);
	return loaded && voices.inputHash === voiceInputHash(loaded) ? voices : null;
}

export async function matchVoices(
	root,
	cfg,
	{ transcribe, media = execute, signal } = {},
) {
	const loaded = completeJobs(root);
	if (!loaded) return null;
	const inputHash = voiceInputHash(loaded);
	const saved = readVoices(root);
	if (saved?.inputHash === inputHash && saved.state !== "submitted")
		return saved;
	const labels = labelsOf(loaded);
	const contextStart = new Map(
		loaded.map(({ job }) => [
			job.jobId,
			(job.contextStartMs ?? job.sourceStartMs) / 1000,
		]),
	);
	const base = {
		schemaVersion: 1,
		inputHash,
		provider: cfg.transcriber,
	};
	const jobsWithSpeech = new Set(labels.map((label) => label.jobId));
	if (jobsWithSpeech.size <= 1) {
		const result = {
			...base,
			state: "complete",
			method: "single-request",
			voices: groupVoices(labels, [], []),
			completedAt: Date.now(),
		};
		durableJson(voicesFile(root), result);
		return result;
	}
	if (saved?.inputHash === inputHash && saved.state === "submitted") {
		const result = {
			...base,
			state: "unmatched",
			method: "none",
			error:
				"The voice-matching request may have been sent before Worm stopped; it is not sent again automatically.",
			voices: groupVoices(labels, [], []),
			completedAt: Date.now(),
		};
		durableJson(voicesFile(root), result);
		return result;
	}
	const samples = pickSamples(labels);
	let result;
	try {
		const { output, spans } = await buildLineup(
			root,
			samples,
			contextStart,
			media,
		);
		durableJson(voicesFile(root), {
			...base,
			state: "submitted",
			submittedAt: Date.now(),
		});
		const words = await (
			transcribe ??
			(await import(new URL("transcribe.mjs", engine))).transcribeWords
		)(output, cfg, {
			log: () => {},
			signal: signal ?? AbortSignal.timeout(120000),
		});
		if (!Array.isArray(words))
			throw new Error("Provider returned invalid normalized words");
		result = {
			...base,
			state: "complete",
			method: "lineup",
			samples: spans.length,
			voices: groupVoices(labels, spans, words),
			completedAt: Date.now(),
		};
	} catch (error) {
		result = {
			...base,
			state: "unmatched",
			method: "none",
			error: String(error.message).slice(0, 500),
			voices: groupVoices(labels, [], []),
			completedAt: Date.now(),
		};
	} finally {
		fs.rmSync(lineupFile(root), { force: true });
	}
	durableJson(voicesFile(root), result);
	return result;
}

export function voiceOf(voices, label) {
	return voices?.voices.find((voice) => voice.labels.includes(label)) ?? null;
}

const CARD = "voices.json";
const NAMES = "voice-names.json";
const cleanName = (value) =>
	typeof value === "string"
		? value.replace(/\s+/g, " ").trim().slice(0, 60)
		: "";

export function readVoiceNames(directory) {
	try {
		const saved = readJson(path.join(directory, NAMES));
		return saved.schemaVersion === 1 &&
			saved.names &&
			typeof saved.names === "object"
			? saved
			: null;
	} catch {
		return null;
	}
}

export function readVoiceCard(directory) {
	try {
		const card = readJson(path.join(directory, CARD));
		return card.schemaVersion === 1 && Array.isArray(card.voices) ? card : null;
	} catch {
		return null;
	}
}

const namesHash = (names) =>
	sha256(Buffer.from(JSON.stringify(Object.entries(names).sort())));

function namesFor(directory, inputHash) {
	const saved = readVoiceNames(directory);
	return saved?.inputHash === inputHash ? saved : null;
}

export function voiceSpeakerMap(directory) {
	const card = readVoiceCard(directory);
	if (!card) return {};
	const saved = namesFor(directory, card.inputHash);
	if (!saved) return {};
	const map = {};
	for (const voice of card.all ?? []) {
		const name = cleanName(saved.names[voice.id]);
		if (name) map[voice.label] = name;
	}
	return map;
}

export const voiceNamesHash = (directory) => {
	const card = readVoiceCard(directory);
	const saved = card && namesFor(directory, card.inputHash);
	return saved ? namesHash(saved.names) : null;
};

function pastNames(directory, limit = 40) {
	const parent = path.dirname(directory);
	let entries = [];
	try {
		entries = fs
			.readdirSync(parent, { withFileTypes: true })
			.filter(
				(entry) =>
					entry.isDirectory() &&
					path.join(parent, entry.name) !== directory &&
					fs.existsSync(path.join(parent, entry.name, NAMES)),
			)
			.map((entry) => entry.name)
			.sort()
			.reverse()
			.slice(0, limit);
	} catch {
		return [];
	}
	return entries.flatMap((name) =>
		Object.values(readVoiceNames(path.join(parent, name))?.names ?? {}).map(
			cleanName,
		),
	);
}

async function extractClip(root, directory, voice, contextStart, media) {
	const sample = voice.sample;
	if (!sample || !contextStart.has(sample.jobId)) return null;
	const relative = path.join("voices", `${voice.id}.wav`);
	const output = path.join(directory, relative);
	if (fs.existsSync(output)) return relative;
	const source = path.join(root, "jobs", `${sample.jobId}.wav`);
	if (!fs.existsSync(source)) return null;
	fs.mkdirSync(path.dirname(output), { recursive: true });
	const temporary = `${output}.tmp.wav`;
	try {
		await media(
			"ffmpeg",
			[
				"-v",
				"error",
				"-nostdin",
				"-y",
				"-ss",
				String(Math.max(0, sample.start - contextStart.get(sample.jobId))),
				"-t",
				String(Math.min(MAX_SAMPLE_S, sample.end - sample.start + 0.3)),
				"-i",
				source,
				"-c:a",
				"pcm_s16le",
				temporary,
			],
			{ timeout: 30000 },
		);
		fs.renameSync(temporary, output);
		return relative;
	} catch {
		fs.rmSync(temporary, { force: true });
		return null;
	}
}

export async function writeVoiceCard(
	directory,
	voices,
	{ speakers = [], media = execute } = {},
) {
	const root = path.join(directory, "checkpoints");
	const previous = readVoiceCard(directory);
	if (previous?.inputHash !== voices.inputHash)
		fs.rmSync(path.join(directory, "voices"), { recursive: true, force: true });
	const saved = namesFor(directory, voices.inputHash);
	const contextStart = new Map(
		(completeJobs(root) ?? []).map(({ job }) => [
			job.jobId,
			(job.contextStartMs ?? job.sourceStartMs) / 1000,
		]),
	);
	const all = voices.voices.map((voice, index) => ({
		id: voice.id,
		label: `Speaker ${index + 1}`,
		stray: voice.stray,
	}));
	const shown = [];
	for (const [index, voice] of voices.voices.entries()) {
		if (voice.stray) continue;
		shown.push({
			id: voice.id,
			label: all[index].label,
			name: cleanName(saved?.names[voice.id]) || null,
			words: voice.words,
			quote: voice.sample?.text?.slice(0, 160) ?? "",
			clip: await extractClip(root, directory, voice, contextStart, media),
		});
	}
	const suggestions = [
		...new Set(
			[...speakers.map(cleanName), ...pastNames(directory)].filter(Boolean),
		),
	].slice(0, 12);
	const card = {
		schemaVersion: 1,
		inputHash: voices.inputHash,
		matched: voices.state === "complete",
		asked: !!saved,
		pending: !!saved && saved.appliedHash !== namesHash(saved.names),
		voices: shown,
		all,
		suggestions,
	};
	durableJson(path.join(directory, CARD), card);
	return card;
}

export function saveVoiceNames(directory, names, { skipped = false } = {}) {
	const card = readVoiceCard(directory);
	if (!card) throw new Error("This recording has no voices to name yet");
	const known = new Set(card.voices.map((voice) => voice.id));
	const clean = {};
	if (!skipped)
		for (const [id, value] of Object.entries(names ?? {})) {
			const name = cleanName(value);
			if (known.has(id) && name) clean[id] = name;
		}
	const previous = namesFor(directory, card.inputHash);
	const saved = {
		schemaVersion: 1,
		inputHash: card.inputHash,
		names: skipped ? (previous?.names ?? {}) : clean,
		skipped,
		...(previous?.appliedHash ? { appliedHash: previous.appliedHash } : {}),
		savedAt: Date.now(),
	};
	durableJson(path.join(directory, NAMES), saved);
	refreshVoiceCard(directory);
	return saved;
}

export function markVoiceNamesApplied(directory, appliedHash) {
	const card = readVoiceCard(directory);
	const saved = card && namesFor(directory, card.inputHash);
	if (!saved || !appliedHash) return;
	durableJson(path.join(directory, NAMES), { ...saved, appliedHash });
	refreshVoiceCard(directory);
}

function refreshVoiceCard(directory) {
	const card = readVoiceCard(directory);
	if (!card) return;
	const saved = namesFor(directory, card.inputHash);
	durableJson(path.join(directory, CARD), {
		...card,
		asked: !!saved,
		pending: !!saved && saved.appliedHash !== namesHash(saved.names),
		voices: card.voices.map((voice) => ({
			...voice,
			name: cleanName(saved?.names[voice.id]) || null,
		})),
	});
}
