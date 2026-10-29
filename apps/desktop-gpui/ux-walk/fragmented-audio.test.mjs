import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { scanFragmentedAudio } from "./fragmented-audio.mjs";

test("only complete audio fragments advance the durable source cursor", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ux-walk-audio-prefix-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const file = path.join(root, "growing.m4a");
	execFileSync("ffmpeg", [
		"-v",
		"error",
		"-f",
		"lavfi",
		"-i",
		"sine=frequency=440:duration=2.4",
		"-c:a",
		"aac",
		"-movflags",
		"frag_keyframe+empty_moov+default_base_moof+skip_trailer",
		"-frag_duration",
		"500000",
		file,
	]);
	const full = scanFragmentedAudio(file);
	assert.ok(full.fragments.length >= 3);
	assert.ok(
		full.fragments.every((fragment) => fragment.endMs > fragment.startMs),
	);
	const last = full.fragments.at(-1);
	const incomplete = path.join(root, "incomplete.m4a");
	fs.writeFileSync(incomplete, fs.readFileSync(file).subarray(0, last.end - 1));
	const first = scanFragmentedAudio(incomplete);
	assert.equal(first.fragments.length, full.fragments.length - 1);
	assert.equal(first.end, last.start);
	fs.appendFileSync(incomplete, fs.readFileSync(file).subarray(last.end - 1));
	const tail = scanFragmentedAudio(incomplete, {
		cursor: first.end,
		init: first.init,
	});
	assert.equal(tail.fragments.length, 1);
	assert.deepEqual(tail.fragments[0].bytes, last.bytes);
	const snapshot = path.join(root, "standalone.m4a");
	fs.writeFileSync(
		snapshot,
		Buffer.concat([tail.init, tail.fragments[0].bytes]),
	);
	const probe = JSON.parse(
		execFileSync("ffprobe", [
			"-v",
			"error",
			"-show_entries",
			"stream=codec_type",
			"-of",
			"json",
			snapshot,
		]),
	);
	assert.equal(probe.streams[0].codec_type, "audio");
});
