import { afterEach, describe, expect, it, vi } from "vitest";
import { init } from "../src/index";
import {
	compressRewind,
	MASK_INPUTS,
	MASK_VALUE,
	REWIND_BLOCK,
	RewindBuffer,
	type RewindSnapshot,
	rewindJson,
	rewindMinutes,
	rewindRecordOptions,
	startRewind,
} from "../src/rewind";

const META = 4;
const FULL = 2;
const INCREMENTAL = 3;
const MINUTE = 60_000;

function checkout(buffer: RewindBuffer, at: number, size = 10) {
	buffer.push({ type: META, timestamp: at }, `{"type":4,"t":${at}}`);
	buffer.push(
		{ type: FULL, timestamp: at },
		`{"type":2,"t":${at},"pad":"${"x".repeat(size)}"}`,
	);
}
const step = (buffer: RewindBuffer, at: number, size = 10) =>
	buffer.push(
		{ type: INCREMENTAL, timestamp: at },
		`{"type":3,"t":${at},"pad":"${"y".repeat(size)}"}`,
	);
const starts = (snapshot: RewindSnapshot | null) =>
	snapshot?.segments.map((segment) => segment.startedAt) ?? [];

function bytesOf(blob: Blob): Promise<Uint8Array> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
		reader.onerror = () => reject(reader.error);
		reader.readAsArrayBuffer(blob);
	});
}

async function gunzip(blob: Blob): Promise<string> {
	const body = new Response((await bytesOf(blob)) as BodyInit).body;
	return new Response(
		body?.pipeThrough(new DecompressionStream("gzip")),
	).text();
}

describe("rewind config", () => {
	it("is off unless minutes are set, and clamps to 2 to 5 minutes", () => {
		expect(rewindMinutes(undefined)).toBeNull();
		expect(rewindMinutes({ minutes: Number.NaN })).toBeNull();
		expect(rewindMinutes({ minutes: 1 })).toBe(2);
		expect(rewindMinutes({ minutes: 3.4 })).toBe(3);
		expect(rewindMinutes({ minutes: 30 })).toBe(5);
	});
});

describe("rewind buffer", () => {
	it("keeps the last N minutes by dropping whole segments", () => {
		const buffer = new RewindBuffer(2 * MINUTE);
		for (let minute = 0; minute <= 5; minute++) {
			checkout(buffer, minute * MINUTE);
			step(buffer, minute * MINUTE + 30_000);
		}
		const snapshot = buffer.snapshot(5 * MINUTE + 40_000);
		expect(starts(snapshot)).toEqual([3 * MINUTE, 4 * MINUTE, 5 * MINUTE]);
		expect(snapshot?.segments[0]?.events[0]).toContain('"type":4');
		expect(snapshot?.segments[0]?.events[1]).toContain('"type":2');
	});

	it("trims by age at send time even when the page is idle", () => {
		const buffer = new RewindBuffer(2 * MINUTE);
		checkout(buffer, 0);
		checkout(buffer, MINUTE);
		checkout(buffer, 2 * MINUTE);
		expect(starts(buffer.snapshot(2 * MINUTE))).toEqual([
			0,
			MINUTE,
			2 * MINUTE,
		]);
		expect(starts(buffer.snapshot(3 * MINUTE))).toEqual([MINUTE, 2 * MINUTE]);
	});

	it("ignores events until the first full snapshot", () => {
		const buffer = new RewindBuffer(2 * MINUTE);
		step(buffer, 1);
		expect(buffer.snapshot(2)).toBeNull();
		expect(buffer.size.events).toBe(0);
		buffer.push({ type: META, timestamp: 3 }, '{"type":4}');
		expect(buffer.snapshot(4)).toBeNull();
	});

	it("caps memory by events and characters, oldest segment first", () => {
		const byEvents = new RewindBuffer(5 * MINUTE, {
			events: 6,
			chars: 1e9,
		});
		checkout(byEvents, 0);
		step(byEvents, 1);
		checkout(byEvents, 2);
		step(byEvents, 3);
		expect(starts(byEvents.snapshot(4))).toEqual([0, 2]);
		step(byEvents, 5);
		expect(starts(byEvents.snapshot(6))).toEqual([2]);
		expect(byEvents.size.events).toBe(4);

		const byChars = new RewindBuffer(5 * MINUTE, {
			events: 1e9,
			chars: 400,
		});
		checkout(byChars, 0, 100);
		checkout(byChars, 1, 100);
		checkout(byChars, 2, 100);
		expect(byChars.size.chars).toBeLessThanOrEqual(400);
		expect(starts(byChars.snapshot(3))).toEqual([1, 2]);
	});

	it("drops a segment that alone exceeds the cap until the next full snapshot", () => {
		const buffer = new RewindBuffer(5 * MINUTE, { events: 1e9, chars: 300 });
		checkout(buffer, 0, 50);
		step(buffer, 1, 400);
		expect(buffer.snapshot(2)).toBeNull();
		step(buffer, 3, 10);
		expect(buffer.size.events).toBe(0);
		checkout(buffer, 4, 50);
		expect(starts(buffer.snapshot(5))).toEqual([4]);
	});
});

describe("rewind masking", () => {
	it("blocks masked, editable, choice and hidden fields and the widget", () => {
		for (const selector of [
			"[data-worm-mask]",
			"[contenteditable]:not([contenteditable=false])",
			"select",
			"input[type=checkbox]",
			"input[type=radio]",
			"input[type=hidden]",
			"feedback-widget",
		])
			expect(REWIND_BLOCK.split(",")).toContain(selector);
		const options = rewindRecordOptions(() => {});
		expect(options.maskInputOptions).toBe(MASK_INPUTS);
		expect(MASK_INPUTS).toMatchObject({ input: true, textarea: true });
		expect(options.maskInputFn?.("Jane Q. Example", document.body)).toBe(
			MASK_VALUE,
		);
		expect(options.recordCanvas).toBe(false);
		expect(options.inlineImages).toBe(false);
		expect(options.collectFonts).toBe(false);
		expect(options.recordCrossOriginIframes).toBe(false);
		expect(options.blockClass).toBe("rr-block");
	});

	it("records the page without field values, masked text or the widget", async () => {
		document.body.innerHTML = `
			<h1>Visible heading</h1>
			<input id="name" value="Jane Q. Example" placeholder="Jane's phone">
			<input id="odd" type="weird" value="odd-type-secret">
			<input type="hidden" name="mrn" value="hidden-mrn-5550123">
			<input type="checkbox" id="hiv" checked>
			<textarea id="note">Visit note secret</textarea>
			<select><option>Diagnosis option secret</option></select>
			<div data-worm-mask>MRN 5550123 <img src="/scan.png" alt="scan secret"></div>
			<div contenteditable>Editable secret</div>
			<feedback-widget class="rr-block">Widget note secret</feedback-widget>`;
		const rewind = startRewind(2);
		expect(rewind).not.toBeNull();
		const name = document.getElementById("name") as HTMLInputElement;
		name.value = "Typed later secret";
		name.dispatchEvent(new Event("input", { bubbles: true }));
		const later = document.createElement("div");
		later.setAttribute("data-worm-mask", "");
		later.textContent = "Added masked secret";
		document.body.append(later);
		await new Promise((resolve) => setTimeout(resolve, 50));
		const snapshot = rewind?.snapshot();
		rewind?.stop();
		expect(snapshot).not.toBeNull();
		const json = rewindJson(snapshot as RewindSnapshot);
		expect(json).toContain("Visible heading");
		for (const secret of [
			"Jane Q. Example",
			"Jane's phone",
			"odd-type-secret",
			"hidden-mrn-5550123",
			"Visit note secret",
			"Diagnosis option secret",
			"5550123",
			"scan secret",
			"Editable secret",
			"Widget note secret",
			"Typed later secret",
			"Added masked secret",
		])
			expect(json).not.toContain(secret);
		expect(JSON.parse(json)).toMatchObject({
			schemaVersion: 1,
			kind: "rrweb",
			rrweb: "2.2.0",
		});
	});
});

describe("rewind upload", () => {
	const segment = (startedAt: number, size: number) => ({
		startedAt,
		events: [
			`{"type":4,"timestamp":${startedAt}}`,
			`{"type":2,"timestamp":${startedAt},"r":"${Array.from({ length: size }, (_, i) => ((i * 7919) % 97).toString(36)).join("")}"}`,
		],
	});

	it("gzips the envelope", async () => {
		const blob = await compressRewind({
			endedAt: 9,
			segments: [segment(1, 10)],
		});
		expect(blob?.type).toBe("application/gzip");
		const bytes = await bytesOf(blob as Blob);
		expect([...bytes.subarray(0, 2)]).toEqual([0x1f, 0x8b]);
		const value = JSON.parse(await gunzip(blob as Blob));
		expect(value).toMatchObject({ startedAt: 1, endedAt: 9 });
		expect(value.events).toHaveLength(2);
	});

	it("drops the oldest segments to fit the size caps, or leaves the rewind out", async () => {
		const snapshot = {
			endedAt: 99,
			segments: [segment(1, 4000), segment(2, 4000), segment(3, 100)],
		};
		const fits = await compressRewind(snapshot, {
			gzipBytes: 1e9,
			jsonBytes: 2000,
		});
		expect(JSON.parse(await gunzip(fits as Blob)).startedAt).toBe(3);
		expect(
			await compressRewind(snapshot, { gzipBytes: 10, jsonBytes: 1e9 }),
		).toBeNull();
	});
});

describe("rewind in the widget", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		document.body.innerHTML = "";
	});

	async function sendWith(include: boolean, rewind?: { minutes: number }) {
		const forms: FormData[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init: RequestInit) => {
				forms.push(init.body as FormData);
				return new Response('{"id":"x"}', { status: 201 });
			}),
		);
		document.body.innerHTML = "<p>Page</p>";
		const widget = init({
			server: "https://feedback.example.test",
			siteKey: "wf_pub_demo_site_key_1",
			rewind,
		});
		const root = document.querySelector("feedback-widget")
			?.shadowRoot as ShadowRoot;
		const box = root.querySelector<HTMLInputElement>("#feedback-widget-rewind");
		const row = root.querySelector<HTMLElement>(".rewind");
		widget.open();
		const note = root.querySelector("textarea") as HTMLTextAreaElement;
		note.value = "It broke";
		note.dispatchEvent(new Event("input"));
		if (box) box.checked = include;
		await new Promise((resolve) => setTimeout(resolve, 20));
		(root.querySelector(".send") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(forms).toHaveLength(1), { timeout: 5000 });
		const status = root.querySelector(".status")?.textContent;
		widget.destroy();
		return { form: forms[0] as FormData, row, box, status };
	}

	it("is off by default", async () => {
		const { form, row } = await sendWith(true);
		expect(row?.hidden).toBe(true);
		expect(form.get("rewind")).toBeNull();
	});

	it("tells the tester, sends the rewind when checked and not when unchecked", async () => {
		const sent = await sendWith(true, { minutes: 3 });
		expect(sent.row?.hidden).toBe(false);
		expect(sent.row?.textContent).toContain("Include the last 3 minutes");
		const part = sent.form.get("rewind") as File;
		expect(part.name).toBe("rewind.json.gz");
		expect(part.type).toBe("application/gzip");
		expect(JSON.parse(await gunzip(part)).kind).toBe("rrweb");
		expect(sent.box?.checked).toBe(true);

		const skipped = await sendWith(false, { minutes: 3 });
		expect(skipped.form.get("rewind")).toBeNull();
		expect(skipped.status).toBe("Thanks. Your feedback was sent.");
	});
});
