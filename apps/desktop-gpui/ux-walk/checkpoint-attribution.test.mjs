import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { finishNativeWalk } from "./native-walk.mjs";

const { processChapter } = await import(
	new URL("../../../vendor/ux-walk/src/process.mjs", import.meta.url)
);

async function fixture(t) {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "uxw-attribution-")),
	);
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const directory = path.join(root, "walk"),
		project = path.join(root, "source.cap");
	fs.mkdirSync(directory);
	fs.mkdirSync(project);
	const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
	const video = path.join(project, "source.mp4");
	execFileSync("ffmpeg", [
		"-v",
		"error",
		"-f",
		"lavfi",
		"-i",
		"color=s=16x16:r=2:d=3",
		"-c:v",
		"libx264",
		"-threads",
		"1",
		video,
	]);
	save(path.join(project, "recording-meta.json"), {
		status: { status: "Complete" },
	});
	const file = path.join(directory, "native-walk.json"),
		journal = {
			schemaVersion: 1,
			state: "complete",
			startedAtMs: 1000,
			durationMs: 4000,
			sourceProject: project,
			request: {
				directory,
				topic: "Manual attribution",
				url: "",
				speakers: [],
			},
			events: [],
		};
	save(file, journal);
	fs.writeFileSync(
		path.join(directory, "meet.jsonl"),
		`${JSON.stringify({
			kind: "caption",
			t: 3500,
			name: "Automatic Meet Name",
			id: "turn",
		})}\n`,
	);
	const chapter = path.join(directory, "01-walkthrough");
	fs.mkdirSync(chapter);
	fs.mkdirSync(path.join(chapter, "shots"));
	fs.writeFileSync(path.join(chapter, "shots/skip.txt"), "fixture");
	const srt =
		"1\n00:00:00,500 --> 00:00:01,500\nSpeaker 1: Synthetic speech\n\n";
	fs.writeFileSync(path.join(chapter, "transcript.srt"), srt);
	let requests = 0;
	const before = global.fetch;
	global.fetch = async () => {
		requests++;
		throw new Error("Provider forbidden");
	};
	t.after(() => {
		global.fetch = before;
		assert.equal(requests, 0);
	});
	const cfg = {
		transcriber: "none",
		brief: false,
		sections: false,
		screenNames: false,
		glossary: "",
		me: "Local",
		sourceRoot: "",
	};
	const dependencies = {
		client: {
			export: async (_project, out) => {
				fs.copyFileSync(video, out);
				return { durationS: 3 };
			},
		},
		processChapter: (dir, config, options) =>
			processChapter(dir, config, { ...options, quiet: true, log: () => {} }),
	};
	await finishNativeWalk(file, cfg, dependencies);
	const chapterFile = path.join(chapter, "chapter.json"),
		manual = {
			...JSON.parse(fs.readFileSync(chapterFile)),
			speakerMap: { "Speaker 1": "Confirmed Alice" },
			speakers: ["Confirmed Alice", "Manual Bob"],
			speakerIdentity: "Confirmed by owner",
		};
	save(chapterFile, manual);
	await processChapter(chapter, cfg, { quiet: true, log: () => {} });
	assert.match(
		fs.readFileSync(path.join(chapter, "timeline.md"), "utf8"),
		/Confirmed Alice/,
	);
	return {
		root,
		directory,
		project,
		file,
		journal,
		chapter,
		chapterFile,
		manual,
		cfg,
		dependencies,
		save,
		srt,
	};
}

function archived(f) {
	const history = path.join(f.chapter, "speaker-attribution-history");
	assert.ok(
		fs.existsSync(history),
		"Confirmed attribution must be archived durably",
	);
	const entries = fs
		.readdirSync(history)
		.filter((name) => name.endsWith(".json"))
		.map((name) => JSON.parse(fs.readFileSync(path.join(history, name))));
	assert.ok(
		entries.some(
			(value) => value.metadata.speakerMap?.["Speaker 1"] === "Confirmed Alice",
		),
	);
	assert.ok(fs.readdirSync(history).some((name) => name.endsWith(".srt")));
}

test("ordinary regeneration keeps confirmed attribution over Meet inference and early/final duration differences", async (t) => {
	const f = await fixture(t);
	await finishNativeWalk(f.file, f.cfg, f.dependencies);
	const after = JSON.parse(fs.readFileSync(f.chapterFile));
	assert.deepEqual(after.speakerMap, f.manual.speakerMap);
	assert.deepEqual(after.speakers, f.manual.speakers);
	assert.equal(after.speakerIdentity, f.manual.speakerIdentity);
	const timeline = fs.readFileSync(path.join(f.chapter, "timeline.md"), "utf8");
	assert.match(timeline, /Confirmed Alice/);
	assert.doesNotMatch(timeline, /Automatic Meet Name/);
});

for (const change of ["source", "bounds", "transcript", "chapter"])
	test(`changed ${change} archives a confirmed mapping instead of applying it to another identity`, async (t) => {
		const f = await fixture(t);
		if (change === "source") {
			const next = path.join(f.root, "other.cap");
			fs.mkdirSync(next);
			f.journal.sourceProject = next;
			f.save(f.file, f.journal);
		} else if (change === "chapter") {
			const metadata = JSON.parse(fs.readFileSync(f.chapterFile));
			metadata.n = 42;
			metadata.name = "Different chapter";
			f.save(f.chapterFile, metadata);
		} else if (change === "bounds") {
			f.journal.durationMs = 2500;
			f.save(f.file, f.journal);
		} else
			fs.writeFileSync(
				path.join(f.chapter, "transcript.srt"),
				f.srt.replace("Synthetic speech", "Different source speech"),
			);
		await finishNativeWalk(f.file, f.cfg, f.dependencies);
		const after = JSON.parse(fs.readFileSync(f.chapterFile));
		assert.equal(after.speakerMap, undefined);
		assert.notEqual(after.speakerIdentity, "Confirmed by owner");
		archived(f);
	});

test("explicit full ASR archives the old confirmed mapping and resets raw Speaker labels", async (t) => {
	const f = await fixture(t);
	let calls = 0;
	await finishNativeWalk(
		f.file,
		{ ...f.cfg, transcriber: "elevenlabs" },
		{
			...f.dependencies,
			fullTranscription: true,
			prepareAudio: async () => null,
			processChapter: async (directory) => {
				calls++;
				assert.equal(
					JSON.parse(fs.readFileSync(path.join(directory, "chapter.json")))
						.speakerMap,
					undefined,
				);
				fs.writeFileSync(
					path.join(directory, "transcript.srt"),
					f.srt.replace("Synthetic speech", "Fresh provider speech"),
				);
				return { transcript: true };
			},
		},
	);
	assert.equal(calls, 1);
	assert.equal(
		JSON.parse(fs.readFileSync(f.chapterFile)).speakerMap,
		undefined,
	);
	archived(f);
});
