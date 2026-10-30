import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

test("background caption animation handles cannot cancel unrelated native animation frames", () => {
	let activate;
	const nativeCancelled = [],
		timersCancelled = [];
	const document = {
		hidden: false,
		addEventListener: (_name, callback) => {
			activate = callback;
		},
	};
	const window = {
		requestAnimationFrame: () => 1,
		cancelAnimationFrame: (id) => nativeCancelled.push(id),
	};
	vm.runInNewContext(
		fs.readFileSync(
			new URL("../../extension/page.js", import.meta.url),
			"utf8",
		),
		{
			window,
			document,
			performance: { now: () => 0 },
			setTimeout: () => 1,
			clearTimeout: (id) => timersCancelled.push(id),
		},
	);
	const native = window.requestAnimationFrame(() => {});
	activate({ detail: true });
	document.hidden = true;
	const fallback = window.requestAnimationFrame(() => {});
	assert.notEqual(native, fallback);
	window.cancelAnimationFrame(native);
	assert.deepEqual(nativeCancelled, [1]);
	assert.deepEqual(timersCancelled, []);
	window.cancelAnimationFrame(fallback);
	assert.deepEqual(timersCancelled, [1]);
});
