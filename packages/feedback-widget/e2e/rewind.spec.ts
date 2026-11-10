import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { expect, type Page, test } from "@playwright/test";

const APP = "http://localhost:4173";
const SERVER = "http://localhost:8787";
const KEY = "wf_pub_demo_local_site";
const OWNER = "synthetic-e2e-owner-credential-of-32-bytes";
const root = new URL("..", import.meta.url);
const cloud = new URL("../../../apps/cloud/", import.meta.url);

interface Worker {
	dispatchFetch(
		url: string,
		init?: { method?: string; headers?: Record<string, string>; body?: Buffer },
	): Promise<{
		status: number;
		headers: Iterable<[string, string]>;
		arrayBuffer(): Promise<ArrayBuffer>;
		json(): Promise<unknown>;
	}>;
	getR2Bucket(name: string): Promise<{
		head(key: string): Promise<{ size: number } | null>;
	}>;
	dispose(): Promise<void>;
}

let worker: Worker;

test.beforeAll(async () => {
	const require = createRequire(new URL("package.json", cloud));
	const { Miniflare, convertV4MiniflareOptions } = (await import(
		require.resolve("miniflare")
	)) as {
		Miniflare: new (options: unknown) => Worker;
		convertV4MiniflareOptions: (options: unknown) => unknown;
	};
	worker = new Miniflare(
		convertV4MiniflareOptions({
			name: "rewind-e2e",
			modules: true,
			modulesRoot: fileURLToPath(new URL("dist/", cloud)),
			scriptPath: fileURLToPath(new URL("dist/index.js", cloud)),
			compatibilityDate: "2026-10-25",
			r2Buckets: ["MEDIA"],
			assets: {
				routerConfig: { has_user_worker: true },
				assetConfig: { html_handling: "none" },
				directory: fileURLToPath(new URL("public", cloud)),
				binding: "ASSETS",
				run_worker_first: true,
			},
			bindings: {
				UPLOAD_TOKEN: OWNER,
				FEEDBACK_SITES: JSON.stringify({
					[KEY]: { name: "Demo clinic", origins: [APP] },
				}),
			},
		}),
	);
});
test.afterAll(async () => worker?.dispose());

async function serve(page: Page) {
	await page.route(`${APP}/**`, async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.startsWith("/api/intake/"))
			return route.fulfill({ status: 409, body: '{"error":"conflict"}' });
		const type = path.endsWith(".js") ? "text/javascript" : "text/html";
		return route.fulfill({
			body: await readFile(new URL(`.${path}`, root)),
			contentType: type,
		});
	});
	await page.route(`${SERVER}/**`, async (route) => {
		const request = route.request();
		const result = await worker.dispatchFetch(request.url(), {
			method: request.method(),
			headers: request.headers(),
			body: ["GET", "HEAD"].includes(request.method())
				? undefined
				: (request.postDataBuffer() ?? undefined),
		});
		return route.fulfill({
			status: result.status,
			headers: Object.fromEntries(result.headers),
			body: Buffer.from(await result.arrayBuffer()),
		});
	});
}

const owner = (path: string) =>
	worker.dispatchFetch(`${SERVER}${path}`, {
		headers: { Authorization: `Bearer ${OWNER}` },
	});

async function sendFeedback(page: Page, note: string, include: boolean) {
	const host = page.locator("feedback-widget");
	await host.getByRole("button", { name: "Send feedback" }).click();
	const panel = host.getByRole("dialog", { name: "Send feedback" });
	const rewind = panel.getByRole("checkbox", {
		name: /Include the last 2 minutes of this page/,
	});
	await expect(rewind).toBeVisible();
	await expect(rewind).toBeChecked();
	const box = await rewind.boundingBox();
	expect(box && box.x >= 0 && box.width > 0).toBe(true);
	if (!include) await rewind.uncheck();
	await panel.getByLabel("Your note").fill(note);
	await panel.getByRole("button", { name: "Send feedback" }).click();
	await expect(panel.getByText("Thanks. Your feedback was sent.")).toBeVisible({
		timeout: 20_000,
	});
	await expect(rewind).toBeChecked();
	await panel.getByRole("button", { name: "Close feedback" }).click();
}

async function latest(note: string) {
	const { reports } = (await (await owner("/api/v1/feedback")).json()) as {
		reports: Array<{ id: string; preview: string; rewind: boolean }>;
	};
	const report = reports.find((item) => item.preview === note);
	if (!report) throw new Error(`no stored report for ${note}`);
	return report;
}

test("a tester's last minutes are recorded masked, sent on Send and replayed only for the owner", async ({
	page,
}) => {
	await serve(page);
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(`${APP}/demo/index.html`);

	await page.locator("#patient-name").fill("Typed secret 4242");
	await page.locator("#visit-note").fill("Visit secret 9191");
	await page.getByTestId("chart-summary").click();
	await page.getByTestId("save-intake").click();
	await page.mouse.wheel(0, 200);
	await page.waitForTimeout(800);

	const note = "The intake form lost my changes.";
	await sendFeedback(page, note, true);
	const sent = await latest(note);
	expect(sent.rewind).toBe(true);

	const stored = await (await worker.getR2Bucket("MEDIA")).head(
		`feedback/v1/${sent.id}/rewind`,
	);
	expect(stored?.size).toBeGreaterThan(200);
	const download = await owner(`/api/v1/feedback/${sent.id}/rewind`);
	expect(download.status).toBe(200);
	const recording = JSON.parse(
		gunzipSync(Buffer.from(await download.arrayBuffer())).toString("utf8"),
	);
	expect(recording).toMatchObject({
		schemaVersion: 1,
		kind: "rrweb",
		rrweb: "2.2.0",
	});
	const types = recording.events.map((event: { type: number }) => event.type);
	expect(types[0]).toBe(4);
	expect(types).toContain(2);
	expect(types).toContain(3);
	const text = JSON.stringify(recording);
	expect(text).toContain("Patient intake");
	for (const secret of [
		"Typed secret 4242",
		"Jane Q. Example",
		"Visit secret 9191",
		"Follow-up on lab results",
		"5550123",
		"penicillin",
		note,
		"What happened? What did you expect?",
	])
		expect(text, secret).not.toContain(secret);

	const anonymous = await worker.dispatchFetch(
		`${SERVER}/api/v1/feedback/${sent.id}/rewind`,
		{ headers: { Origin: APP } },
	);
	expect(anonymous.status).toBe(401);

	await sendFeedback(page, "No replay this time.", false);
	expect((await latest("No replay this time.")).rewind).toBe(false);

	await page.goto(`${SERVER}/rewind/${sent.id}`);
	await page.getByLabel("Owner credential").fill(OWNER);
	await page.getByRole("button", { name: "Open replay" }).click();
	await expect(page.getByText(note)).toBeVisible();
	await expect(page.locator(".rr-player")).toBeVisible();
	await expect(page.getByLabel("Owner credential")).toBeHidden();
	await expect(
		page.frameLocator(".replayer-wrapper iframe").getByText("Patient intake"),
	).toBeVisible();
	expect(errors).toEqual([]);
});
