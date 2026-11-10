import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shot = vi.hoisted(() => ({
	filter: undefined as undefined | ((node: Node) => boolean),
}));

vi.mock("modern-screenshot", () => ({
	domToCanvas: vi.fn(async (_root: unknown, options: { filter: never }) => {
		shot.filter = options.filter;
		const canvas = document.createElement("canvas");
		canvas.getContext = (() => ({
			fillRect: () => {},
			fillStyle: "",
		})) as never;
		canvas.toBlob = ((done: (blob: Blob | null) => void) =>
			done(new Blob(["x"], { type: "image/jpeg" }))) as never;
		return canvas;
	}),
}));

vi.mock("../src/rewind", async (original) => ({
	...(await original<typeof import("../src/rewind")>()),
	startRewind: () => ({ snapshot: () => [{}], stop: () => {} }),
	compressRewind: async () => new Blob(["gz"]),
}));

import { createReporter, type FeedbackReporter } from "../src/reporter";

const realFetch = window.fetch;
let reporter: FeedbackReporter;
let calls: FormData[];

const respond = (...statuses: number[]) => {
	reporter?.destroy();
	calls = [];
	window.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
		calls.push(init?.body as FormData);
		return new Response("{}", { status: statuses.shift() ?? 200 });
	}) as typeof window.fetch;
	reporter = createReporter({
		server: "https://feedback.test",
		siteKey: "key",
		rewind: { minutes: 3 },
	});
};

beforeEach(() => {
	document.body.innerHTML = `<button id="page">Page</button>
		<div id="panel"><button id="inside">Inside</button></div>
		<div id="scrim" data-worm-exclude><button id="scrim-btn">Scrim</button></div>`;
	respond();
});

afterEach(() => {
	reporter.destroy();
	window.fetch = realFetch;
});

describe("createReporter", () => {
	it("reports what the host needs to draw its panel", () => {
		expect(reporter.rewindMinutes).toBe(3);
		expect(reporter.maxNote).toBeGreaterThan(0);
		expect(reporter.maxVoiceMs).toBe(120_000);
	});

	it("leaves the panel and data-worm-exclude elements out of screenshots", async () => {
		const panel = document.getElementById("panel") as HTMLElement;
		reporter.setPanel(panel);
		await reporter.captureScreenshot();
		const keep = shot.filter as (node: Node) => boolean;
		expect(keep(panel)).toBe(false);
		expect(keep(document.getElementById("scrim") as HTMLElement)).toBe(false);
		expect(keep(document.getElementById("page") as HTMLElement)).toBe(true);
	});

	it("does not log clicks inside the panel or an excluded element", async () => {
		reporter.setPanel(document.getElementById("panel"));
		for (const id of ["page", "inside", "scrim-btn"])
			document.getElementById(id)?.click();
		await reporter.send({
			note: "hi",
			screenshot: null,
			voice: null,
			includeRewind: false,
		});
		const evidence = JSON.parse(String(calls[0]?.get("evidence")));
		const clicks = evidence.events.filter(
			(event: { ev: string }) => event.ev === "click",
		);
		expect(clicks).toHaveLength(1);
		expect(clicks[0].el.text).toBe("Page");
	});

	it("retries without the replay when the server refuses it as too large", async () => {
		respond(413, 200);
		const result = await reporter.send({
			note: "hi",
			screenshot: null,
			voice: null,
			includeRewind: true,
		});
		expect(calls).toHaveLength(2);
		expect(calls[0]?.has("rewind")).toBe(true);
		expect(calls[1]?.has("rewind")).toBe(false);
		expect(result).toEqual({ replaySent: false });
	});

	it("sends the replay when the server accepts it", async () => {
		const result = await reporter.send({
			note: "hi",
			screenshot: null,
			voice: null,
			includeRewind: true,
		});
		expect(calls).toHaveLength(1);
		expect(result).toEqual({ replaySent: true });
	});

	it("throws when the server refuses the report", async () => {
		respond(500);
		await expect(
			reporter.send({
				note: "hi",
				screenshot: null,
				voice: null,
				includeRewind: false,
			}),
		).rejects.toThrow("500");
	});
});
