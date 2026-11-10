import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { durableJson, sha256 } from "./checkpoint-store.mjs";
import { currentVoices, matchVoices, voiceOf } from "./checkpoint-voices.mjs";

const words = (speaker, start, count, text = "word") =>
	Array.from({ length: count }, (_, index) => ({
		text: `${text}${index}`,
		start: start + index * 0.4,
		end: start + index * 0.4 + 0.3,
		speaker,
	}));

function job(root, letter, source, startMs, endMs, list) {
	const id = letter.repeat(64);
	const tag = `${source}:${id.slice(0, 12)}`;
	const file = path.join(root, `jobs/${id}.words.json`);
	durableJson(file, {
		source,
		words: list.map((word) => ({ ...word, speaker: `${tag}:${word.speaker}` })),
	});
	durableJson(path.join(root, `jobs/${id}.json`), {
		jobId: id,
		source,
		sourceStartMs: startMs,
		sourceEndMs: endMs,
		contextStartMs: Math.max(0, startMs - 2000),
		state: "complete",
		resultHash: sha256(fs.readFileSync(file)),
	});
	fs.writeFileSync(path.join(root, `jobs/${id}.wav`), "");
	return tag;
}

function fixture(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "uxw-voices-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.mkdirSync(path.join(root, "jobs"), { recursive: true });
	const first = job(root, "a", "segment-0:microphone", 0, 300000, [
		...words("speaker_0", 1, 10, "jackson"),
		...words("speaker_1", 10, 10, "clay"),
	]);
	const second = job(root, "b", "segment-0:microphone", 300000, 600000, [
		...words("speaker_0", 301, 10, "clay"),
		...words("speaker_1", 310, 10, "jackson"),
	]);
	return { root, first, second };
}

const media = async (_command, args) => {
	fs.writeFileSync(args.at(-1), "");
};

test("one lineup request matches each chunk's voices to the same people across chunks", async (t) => {
	const { root, first, second } = fixture(t);
	let requests = 0;
	const transcribe = async () => {
		requests += 1;
		const lineup = [];
		let cursor = 0;
		for (const person of ["A", "B", "B", "A"]) {
			lineup.push(...words(person, cursor, 10));
			cursor += 3.7 + 1.5;
		}
		return lineup;
	};
	const voices = await matchVoices(
		root,
		{ transcriber: "elevenlabs" },
		{ transcribe, media },
	);
	assert.equal(voices.state, "complete");
	assert.equal(voices.method, "lineup");
	assert.equal(voices.voices.length, 2);
	assert.deepEqual(voiceOf(voices, `${first}:speaker_0`).labels, [
		`${first}:speaker_0`,
		`${second}:speaker_1`,
	]);
	assert.deepEqual(voiceOf(voices, `${first}:speaker_1`).labels, [
		`${first}:speaker_1`,
		`${second}:speaker_0`,
	]);
	assert.match(voiceOf(voices, `${first}:speaker_0`).sample.text, /jackson/);
	assert.equal(fs.existsSync(path.join(root, "voices-lineup.wav")), false);
	await matchVoices(root, { transcriber: "elevenlabs" }, { transcribe, media });
	assert.equal(requests, 1);
	assert.equal(currentVoices(root).inputHash, voices.inputHash);
});

test("two voices from one chunk are never merged even if the lineup hears them as one", async (t) => {
	const { root, first, second } = fixture(t);
	const transcribe = async () => words("A", 0, 60);
	const voices = await matchVoices(
		root,
		{ transcriber: "elevenlabs" },
		{ transcribe, media },
	);
	assert.notEqual(
		voiceOf(voices, `${first}:speaker_0`).id,
		voiceOf(voices, `${first}:speaker_1`).id,
	);
	assert.notEqual(
		voiceOf(voices, `${second}:speaker_0`).id,
		voiceOf(voices, `${second}:speaker_1`).id,
	);
});

test("a failed lineup keeps chunk voices apart and is not resent automatically", async (t) => {
	const { root, first, second } = fixture(t);
	let requests = 0;
	const transcribe = async () => {
		requests += 1;
		throw new Error("ElevenLabs 500: down");
	};
	const voices = await matchVoices(
		root,
		{ transcriber: "elevenlabs" },
		{ transcribe, media },
	);
	assert.equal(voices.state, "unmatched");
	assert.equal(voices.voices.length, 4);
	assert.notEqual(
		voiceOf(voices, `${first}:speaker_0`).id,
		voiceOf(voices, `${second}:speaker_1`).id,
	);
	await matchVoices(root, { transcriber: "elevenlabs" }, { transcribe, media });
	assert.equal(requests, 1);
});

test("a single chunk needs no request and pending jobs give no result", async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "uxw-voices-one-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.mkdirSync(path.join(root, "jobs"), { recursive: true });
	job(root, "c", "segment-0:microphone", 0, 60000, [
		...words("speaker_0", 1, 10),
		...words("speaker_1", 6, 10),
	]);
	const transcribe = async () => assert.fail("no request expected");
	const voices = await matchVoices(
		root,
		{ transcriber: "elevenlabs" },
		{ transcribe, media },
	);
	assert.equal(voices.method, "single-request");
	assert.equal(voices.voices.length, 2);
	durableJson(path.join(root, `jobs/${"d".repeat(64)}.json`), {
		jobId: "d".repeat(64),
		source: "segment-0:microphone",
		sourceStartMs: 60000,
		sourceEndMs: 120000,
		state: "prepared",
	});
	assert.equal(
		await matchVoices(
			root,
			{ transcriber: "elevenlabs" },
			{ transcribe, media },
		),
		null,
	);
	assert.equal(currentVoices(root), null);
});

test("a lineup that may have been sent before a crash is never sent again", async (t) => {
	const { root } = fixture(t);
	let requests = 0;
	await assert.rejects(
		matchVoices(
			root,
			{ transcriber: "elevenlabs" },
			{
				transcribe: async () => {
					requests += 1;
					const saved = JSON.parse(
						fs.readFileSync(path.join(root, "voices.json"), "utf8"),
					);
					assert.equal(saved.state, "submitted");
					throw Object.assign(new Error("killed"), { crash: true });
				},
				media: async (_command, args) => {
					fs.writeFileSync(args.at(-1), "");
				},
			},
		).then((result) => {
			if (result.state === "unmatched")
				fs.writeFileSync(
					path.join(root, "voices.json"),
					JSON.stringify({
						schemaVersion: 1,
						inputHash: result.inputHash,
						state: "submitted",
						voices: [],
					}),
				);
			throw new Error("simulated crash after submission");
		}),
	);
	const again = await matchVoices(
		root,
		{ transcriber: "elevenlabs" },
		{
			transcribe: async () => {
				requests += 1;
				return [];
			},
			media,
		},
	);
	assert.equal(requests, 1);
	assert.equal(again.state, "unmatched");
	assert.equal(again.matched, false);
});

test("a lineup that failed before anything was sent is tried again", async (t) => {
	const { root } = fixture(t);
	let builds = 0;
	const failing = async () => {
		builds += 1;
		throw new Error("ffmpeg failed");
	};
	const first = await matchVoices(
		root,
		{ transcriber: "elevenlabs" },
		{ transcribe: async () => assert.fail("not sent"), media: failing },
	);
	assert.equal(first.notSent, true);
	let requests = 0;
	const second = await matchVoices(
		root,
		{ transcriber: "elevenlabs" },
		{
			transcribe: async () => {
				requests += 1;
				return [];
			},
			media,
		},
	);
	assert.equal(builds, 1);
	assert.equal(requests, 1);
	assert.equal(second.state, "complete");
	assert.equal(second.matched, false);
});

test("voices count as matched only when every real voice got a lineup answer, and excluded sources stay out", async (t) => {
	const { root } = fixture(t);
	job(root, "e", "segment-0:systemAudio", 0, 300000, words("speaker_0", 1, 10));
	let seconds = 0;
	const voices = await matchVoices(
		root,
		{ transcriber: "elevenlabs" },
		{
			sources: new Set(["segment-0:microphone"]),
			media: async (_command, args) => {
				seconds = args.filter((arg) => arg === "-i").length;
				fs.writeFileSync(args.at(-1), "");
			},
			transcribe: async () => words("A", 0, 10),
		},
	);
	assert.equal(seconds, 4);
	assert.equal(voices.state, "complete");
	assert.equal(voices.matched, false);
	assert.equal(
		voices.voices.some((voice) =>
			voice.labels.some((label) => label.includes("systemAudio")),
		),
		false,
	);
});
