import { afterEach, describe, expect, it, vi } from "vitest";
import { init } from "../src/index";
import {
	BlockFilter,
	compressRewind,
	MASK_INPUTS,
	MASK_VALUE,
	REWIND_BLOCK,
	RewindBuffer,
	type RewindSnapshot,
	rewindJson,
	rewindMinutes,
	rewindRecordOptions,
	scrubEvent,
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

	it("drops a segment left over from a long idle gap, so the span stays short", () => {
		const buffer = new RewindBuffer(2 * MINUTE);
		checkout(buffer, 0);
		step(buffer, 20 * MINUTE);
		checkout(buffer, 20 * MINUTE);
		step(buffer, 20 * MINUTE + 5000);
		const snapshot = buffer.snapshot(20 * MINUTE + 10_000);
		expect(starts(snapshot)).toEqual([20 * MINUTE]);

		const idle = new RewindBuffer(2 * MINUTE);
		checkout(idle, 0);
		expect(idle.snapshot(20 * MINUTE)).toBeNull();
		checkout(idle, 20 * MINUTE);
		expect(starts(idle.snapshot(20 * MINUTE + 1))).toEqual([20 * MINUTE]);
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
			checkoutMs: MINUTE,
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
			checkoutMs: MINUTE,
		});
		checkout(byChars, 0, 100);
		checkout(byChars, 1, 100);
		checkout(byChars, 2, 100);
		expect(byChars.size.chars).toBeLessThanOrEqual(400);
		expect(starts(byChars.snapshot(3))).toEqual([1, 2]);
	});

	it("drops a segment that alone exceeds the cap until the next full snapshot", () => {
		const buffer = new RewindBuffer(5 * MINUTE, {
			events: 1e9,
			chars: 300,
			checkoutMs: MINUTE,
		});
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

	it("drops content added below a masked element, including shadow roots attached later", async () => {
		document.body.innerHTML = `
			<p>Shown text</p>
			<div id="early" data-worm-mask></div>
			<late-panel id="late" data-worm-mask></late-panel>`;
		const rewind = startRewind(2);
		const appended = document.createElement("div");
		appended.setAttribute("data-worm-mask", "");
		document.body.append(appended);
		await new Promise((resolve) => setTimeout(resolve, 10));
		appended.attachShadow({ mode: "open" }).innerHTML =
			"<p>Appended shadow secret</p>";
		(document.getElementById("early") as HTMLElement).attachShadow({
			mode: "open",
		}).innerHTML = "<p>Early shadow secret <b>nested secret</b></p>";
		customElements.define(
			"late-panel",
			class extends HTMLElement {
				constructor() {
					super();
					this.attachShadow({ mode: "open" }).innerHTML =
						"<span>Defined later secret</span>";
				}
			},
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		const shadow = document.getElementById("early")?.shadowRoot;
		const text = shadow?.querySelector("b");
		if (text) text.textContent = "Changed shadow secret";
		shadow?.querySelector("p")?.setAttribute("title", "Attribute secret");
		const visible = document.createElement("p");
		visible.textContent = "Added visible text";
		document.body.append(visible);
		await new Promise((resolve) => setTimeout(resolve, 50));
		const json = rewindJson(rewind?.snapshot() as RewindSnapshot);
		rewind?.stop();
		expect(json).toContain("Shown text");
		expect(json).toContain("Added visible text");
		for (const secret of [
			"Appended shadow secret",
			"Early shadow secret",
			"nested secret",
			"Defined later secret",
			"Changed shadow secret",
			"Attribute secret",
		])
			expect(json).not.toContain(secret);
	});

	it("filters adds, texts, attributes and inputs under blocked ids", () => {
		const page = document.createElement("div");
		const masked = document.createElement("div");
		masked.setAttribute("data-worm-mask", "");
		const inside = document.createElement("span");
		masked.append(inside);
		page.append(masked);
		const nodes = new Map<number, Node>([
			[1, page],
			[2, masked],
			[3, inside],
		]);
		const filter = new BlockFilter({ getNode: (id) => nodes.get(id) ?? null });
		filter.keep({
			type: FULL,
			data: {
				node: {
					id: 1,
					type: 2,
					tagName: "div",
					attributes: {},
					childNodes: [
						{ id: 2, type: 2, tagName: "div", attributes: { rr_width: "1px" } },
					],
				},
			},
		});
		const mutation = {
			type: INCREMENTAL,
			data: {
				source: 0,
				adds: [
					{ parentId: 2, node: { id: 10, type: 11, childNodes: [] } },
					{ parentId: 10, node: { id: 11, type: 3, textContent: "secret" } },
					{ parentId: 1, node: { id: 12, type: 3, textContent: "shown" } },
				],
				texts: [
					{ id: 11, value: "secret" },
					{ id: 3, value: "secret" },
					{ id: 12, value: "shown" },
				],
				attributes: [
					{ id: 2, attributes: { title: "secret" } },
					{ id: 1, attributes: { title: "shown" } },
				],
				removes: [],
			},
		};
		expect(filter.keep(mutation)).toBe(true);
		const kept = JSON.stringify(mutation);
		expect(kept).not.toContain("secret");
		expect(kept).toContain("shown");
		expect(
			filter.keep({
				type: INCREMENTAL,
				data: { source: 5, id: 11, text: "x" },
			}),
		).toBe(false);
		expect(
			filter.keep({ type: INCREMENTAL, data: { source: 5, id: 3, text: "x" } }),
		).toBe(false);
		expect(
			filter.keep({
				type: INCREMENTAL,
				data: { source: 5, id: 12, text: "x" },
			}),
		).toBe(true);
		expect(
			filter.keep({
				type: INCREMENTAL,
				data: {
					source: 14,
					ranges: [{ start: 11, startOffset: 0, end: 12, endOffset: 1 }],
				},
			}),
		).toBe(false);
		expect(
			filter.keep({
				type: INCREMENTAL,
				data: { source: 2, type: 2, id: 2, x: 1, y: 1 },
			}),
		).toBe(true);
	});

	it("keeps the page address without its query, hash or ids", async () => {
		history.replaceState(null, "", "/patients/123456?mrn=X#Y");
		document.body.innerHTML = "<p>Chart</p>";
		const rewind = startRewind(2, [
			{ pattern: /^\/patients/, replace: "/people" },
		]);
		const json = rewindJson(rewind?.snapshot() as RewindSnapshot);
		rewind?.stop();
		const meta = JSON.parse(json).events.find(
			(event: { type: number }) => event.type === META,
		);
		expect(meta.data.href).toBe(`${location.origin}/people/:id`);
		expect(json).not.toContain("mrn");
		expect(json).not.toContain("123456");
		history.replaceState(null, "", "/");
	});

	it("drops iframe srcdoc and query strings from links and sources, and blocks datalists", async () => {
		document.body.innerHTML = `
			<iframe srcdoc="<p>Srcdoc secret</p>"></iframe>
			<a href="/chart?mrn=link-secret#frag-secret">Chart</a>
			<img src="/scan.png?token=img-secret" srcset="/a.png?k=set-secret 1x, /b.png 2x" alt="">
			<datalist id="names"><option value="Datalist secret"></option></datalist>`;
		const rewind = startRewind(2);
		document.querySelector("a")?.setAttribute("href", "/next?mrn=later-secret");
		document
			.querySelector("iframe")
			?.setAttribute("srcdoc", "<p>Later srcdoc secret</p>");
		await new Promise((resolve) => setTimeout(resolve, 50));
		const json = rewindJson(rewind?.snapshot() as RewindSnapshot);
		rewind?.stop();
		expect(json).toMatch(/"href":"[^"]*\/chart"/);
		expect(json).toContain("/b.png 2x");
		for (const secret of [
			"Srcdoc secret",
			"link-secret",
			"frag-secret",
			"img-secret",
			"set-secret",
			"Datalist secret",
			"later-secret",
			"Later srcdoc secret",
		])
			expect(json).not.toContain(secret);
		const event = {
			type: INCREMENTAL,
			data: {
				source: 0,
				adds: [],
				texts: [],
				removes: [],
				attributes: [{ id: 1, attributes: { srcdoc: "x", src: "/a?b=c" } }],
			},
		};
		scrubEvent(event);
		expect(event.data.attributes[0]?.attributes).toEqual({
			src: `${location.origin}/a`,
		});
	});
});

describe("rewind slots and URLs", () => {
	it("drops light DOM slotted into a masked part of a shadow tree", async () => {
		class PhiField extends HTMLElement {
			constructor() {
				super();
				this.attachShadow({ mode: "open" }).innerHTML =
					'<label>Field</label><span data-worm-mask><slot></slot><slot name="dob"></slot></span><em><slot name="hint"></slot></em>';
			}
		}
		if (!customElements.get("phi-field"))
			customElements.define("phi-field", PhiField);
		document.body.innerHTML = `
			<p>Shown text</p>
			<phi-field id="early">Early slot secret 1111<span slot="hint">Visible hint</span></phi-field>`;
		const rewind = startRewind(2);
		await new Promise((resolve) => setTimeout(resolve, 10));
		const added = document.createElement("phi-field");
		added.textContent = "Added slot secret 2222";
		document.body.append(added);
		const early = document.getElementById("early") as HTMLElement;
		const dob = document.createElement("span");
		dob.slot = "dob";
		dob.textContent = "Named slot secret 3333";
		early.append(dob);
		await new Promise((resolve) => setTimeout(resolve, 20));
		(early.firstChild as Text).data = "Changed slot secret 4444";
		dob.title = "Slotted attribute secret";
		const late = document.createElement("div");
		late.innerHTML = "<b>Before attach</b>";
		document.body.append(late);
		await new Promise((resolve) => setTimeout(resolve, 20));
		late.attachShadow({ mode: "open" }).innerHTML =
			"<span data-worm-mask><slot></slot></span>";
		(late.querySelector("b") as HTMLElement).textContent =
			"Late root secret 5555";
		await new Promise((resolve) => setTimeout(resolve, 50));
		const json = rewindJson(rewind?.snapshot() as RewindSnapshot);
		const fresh = startRewind(2);
		const full = rewindJson(fresh?.snapshot() as RewindSnapshot);
		fresh?.stop();
		rewind?.stop();
		for (const text of [json, full]) {
			expect(text).toContain("Shown text");
			expect(text).toContain("Visible hint");
			for (const secret of [
				"Early slot secret 1111",
				"Added slot secret 2222",
				"Named slot secret 3333",
				"Changed slot secret 4444",
				"Slotted attribute secret",
				"Late root secret 5555",
			])
				expect(text).not.toContain(secret);
		}
	});

	it("blanks data, blob, mailto and tel URLs and runs paths through the route rules", () => {
		const page = {
			href: "https://app.example.test/home",
			rules: [{ pattern: /\/chart$/, replace: "/record" }],
		};
		const node = {
			id: 1,
			type: 2,
			tagName: "div",
			attributes: {},
			childNodes: [
				{
					id: 2,
					type: 2,
					tagName: "img",
					attributes: {
						src: "data:image/png;base64,c2lnbmF0dXJl",
						srcset: "data:image/png;base64,AAAA 1x, /b.png 2x",
						style:
							"background:url('data:image/png;base64,Q0FSRA') ,url(/bg.png?t=1)",
					},
				},
				{
					id: 3,
					type: 2,
					tagName: "a",
					attributes: {
						href: "/patients/88812345/chart?mrn=1",
						ping: "/track?u=1 blob:https://app.example.test/x",
						cite: "mailto:pat@example.com",
						formaction: "tel:5551234",
						background: "/img/123456.png",
						data: "javascript:alert(1)",
					},
				},
				{
					id: 4,
					type: 2,
					tagName: "use",
					attributes: {
						"xlink:href": "#icon-check",
						href: "#patient-88812345",
					},
				},
			],
		};
		scrubEvent({ type: FULL, data: { node } }, page);
		const [img, link, use] = node.childNodes;
		expect(img?.attributes).toEqual({
			src: "",
			srcset: "",
			style: 'background:url("") ,url("https://app.example.test/bg.png")',
		});
		expect(link?.attributes).toEqual({
			href: "https://app.example.test/patients/:id/record",
			ping: "https://app.example.test/track",
			cite: "",
			formaction: "",
			background: "https://app.example.test/img/123456.png",
			data: "",
		});
		expect(use?.attributes).toEqual({ "xlink:href": "#icon-check", href: "" });
		const srcset = { srcset: "/a.png?x=1 1x, /patients/123456.png 2x" };
		scrubEvent(
			{
				type: INCREMENTAL,
				data: {
					source: 0,
					adds: [],
					texts: [],
					removes: [],
					attributes: [{ id: 2, attributes: srcset }],
				},
			},
			page,
		);
		expect(srcset.srcset).toBe(
			"https://app.example.test/a.png 1x, https://app.example.test/patients/123456.png 2x",
		);
	});

	it("drops rule changes to stylesheets adopted by a hidden shadow root", () => {
		const masked = document.createElement("div");
		masked.setAttribute("data-worm-mask", "");
		const nodes = new Map<number, Node>([[2, masked]]);
		const filter = new BlockFilter({ getNode: (id) => nodes.get(id) ?? null });
		const event = (data: Record<string, unknown>) => ({
			type: INCREMENTAL,
			data,
		});
		expect(
			filter.keep(
				event({
					source: 15,
					id: 2,
					styleIds: [7],
					styles: [
						{ styleId: 7, rules: [{ rule: ".x::after{content:'secret'}" }] },
					],
				}),
			),
		).toBe(false);
		expect(
			filter.keep(event({ source: 8, styleId: 7, adds: [{ rule: ".y{}" }] })),
		).toBe(false);
		expect(
			filter.keep(
				event({
					source: 13,
					styleId: 7,
					set: { property: "color", value: "red" },
				}),
			),
		).toBe(false);
		expect(
			filter.keep(event({ source: 8, styleId: 8, adds: [{ rule: ".z{}" }] })),
		).toBe(true);
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

	it("never sends a span longer than the window plus one checkout", async () => {
		const blob = await compressRewind({
			endedAt: 30 * MINUTE,
			segments: [segment(0, 10), segment(29 * MINUTE, 10)],
		});
		expect(JSON.parse(await gunzip(blob as Blob)).startedAt).toBe(29 * MINUTE);
		expect(
			await compressRewind({
				endedAt: 30 * MINUTE,
				segments: [segment(0, 10)],
			}),
		).toBeNull();
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

	async function sendWith(
		include: boolean,
		rewind?: { minutes: number },
		refuse = 0,
	) {
		const forms: FormData[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init: RequestInit) => {
				const form = init.body as FormData;
				forms.push(form);
				if (refuse && form.get("rewind"))
					return new Response('{"error":"refused"}', { status: refuse });
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
		await vi.waitFor(
			() =>
				expect(root.querySelector(".status")?.className).toMatch(/ok|error/),
			{ timeout: 5000 },
		);
		const status = root.querySelector(".status")?.textContent;
		widget.destroy();
		return { form: forms[0] as FormData, forms, row, box, status };
	}

	it("resends the report without the rewind when the server refuses it", async () => {
		for (const refuse of [413, 415]) {
			const sent = await sendWith(true, { minutes: 2 }, refuse);
			expect(sent.forms).toHaveLength(2);
			expect(sent.forms[0]?.get("rewind")).not.toBeNull();
			expect(sent.forms[1]?.get("rewind")).toBeNull();
			expect(sent.forms[1]?.get("note")).toBe("It broke");
			expect(sent.status).toBe(
				"Thanks. Your feedback was sent without the replay.",
			);
		}
	});

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
