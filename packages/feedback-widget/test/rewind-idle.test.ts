import { gunzipSync } from "node:zlib";
import { afterAll, expect, it, vi } from "vitest";

const START = Date.UTC(2026, 10, 9, 12, 0, 0);
vi.useFakeTimers({ toFake: ["Date"], now: START });
afterAll(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function bytesOf(blob: Blob): Promise<Uint8Array> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
		reader.onerror = () => reject(reader.error);
		reader.readAsArrayBuffer(blob);
	});
}

it("sends a report with a rewind after 20 idle minutes and a new interaction", async () => {
	const { init } = await import("../src/index");
	const spans: number[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: string, request: RequestInit) => {
			const part = (request.body as FormData).get("rewind");
			if (part instanceof Blob) {
				const value = JSON.parse(
					gunzipSync(await bytesOf(part)).toString("utf8"),
				);
				spans.push(value.endedAt - value.startedAt);
				if (value.endedAt - value.startedAt > 15 * 60_000)
					return new Response('{"error":"span"}', { status: 415 });
			}
			return new Response('{"id":"x"}', { status: 201 });
		}),
	);
	document.body.innerHTML = '<p id="page">Start</p>';
	const widget = init({
		server: "https://feedback.example.test",
		siteKey: "wf_pub_demo_site_key_1",
		rewind: { minutes: 2 },
	});
	const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
	await tick();
	(document.getElementById("page") as HTMLElement).textContent = "Early edit";
	await tick();

	vi.setSystemTime(START + 20 * 60_000);
	(document.getElementById("page") as HTMLElement).textContent = "After idle";
	await tick();
	vi.setSystemTime(START + 20 * 60_000 + 5_000);
	(document.getElementById("page") as HTMLElement).textContent =
		"Clicked again";
	await tick();

	const root = document.querySelector("feedback-widget")
		?.shadowRoot as ShadowRoot;
	widget.open();
	const note = root.querySelector("textarea") as HTMLTextAreaElement;
	note.value = "Back after lunch";
	note.dispatchEvent(new Event("input"));
	(root.querySelector(".send") as HTMLButtonElement).click();
	await vi.waitFor(
		() =>
			expect(root.querySelector(".status")?.textContent).toBe(
				"Thanks. Your feedback was sent.",
			),
		{ timeout: 5000 },
	);
	widget.destroy();
	expect(spans).toHaveLength(1);
	expect(spans[0]).toBeLessThanOrEqual(6 * 60_000);
});
