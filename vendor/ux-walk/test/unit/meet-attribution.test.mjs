import assert from "node:assert/strict";
import test from "node:test";
import { namesFromMeet } from "../../src/meet.mjs";

test("ambiguous overlapping caption names do not become certain speaker names", () => {
	assert.deepEqual(
		namesFromMeet(
			[{ start: 0, end: 4, speaker: "source:chunk:0" }],
			[
				{ start: 0, end: 2, name: "A" },
				{ start: 2, end: 4, name: "B" },
			],
			"Me",
		),
		{},
	);
});
test("source and chunk qualified labels keep separate names, while reused unqualified labels remain unknown", () => {
	const spans = [
		{ start: 0, end: 2, name: "A" },
		{ start: 4, end: 6, name: "B" },
	];
	assert.deepEqual(
		namesFromMeet(
			[
				{ start: 0, end: 2, speaker: "mic:chunk-one:0" },
				{ start: 4, end: 6, speaker: "call:chunk-two:0" },
			],
			spans,
			"Me",
		),
		{ "mic:chunk-one:0": "A", "call:chunk-two:0": "B" },
	);
	assert.deepEqual(
		namesFromMeet(
			[
				{ start: 0, end: 2, speaker: "0", source: "mic", jobId: "one" },
				{ start: 4, end: 6, speaker: "0", source: "call", jobId: "two" },
			],
			spans,
			"Me",
		),
		{},
	);
});
