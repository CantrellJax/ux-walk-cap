import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { convertV4MiniflareOptions } from "miniflare";

export const deployment = JSON.parse(
	readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
);

export function workerOptions({
	name,
	bindings,
	assets = true,
	ratelimits,
	outboundService,
}) {
	return convertV4MiniflareOptions({
		name,
		modules: true,
		scriptPath: fileURLToPath(new URL("../dist/index.js", import.meta.url)),
		compatibilityDate: deployment.compatibility_date,
		compatibilityFlags: deployment.compatibility_flags,
		r2Buckets: ["MEDIA"],
		d1Databases: ["DB"],
		ratelimits: Object.fromEntries(
			deployment.ratelimits.map(({ name, namespace_id, simple }) => [
				name,
				{ namespace_id, simple: ratelimits?.[name] ?? simple },
			]),
		),
		...(outboundService ? { outboundService } : {}),
		...(assets
			? {
					assets: {
						routerConfig: { has_user_worker: true },
						assetConfig: { html_handling: deployment.assets.html_handling },
						directory: fileURLToPath(new URL("../public", import.meta.url)),
						binding: "ASSETS",
						run_worker_first: true,
					},
				}
			: {}),
		bindings,
	});
}

export async function migrate(runtime) {
	const database = await runtime.getD1Database("DB");
	const directory = new URL("../migrations/", import.meta.url);
	for (const file of readdirSync(directory).sort()) {
		if (!file.endsWith(".sql")) continue;
		const statements = readFileSync(new URL(file, directory), "utf8")
			.split(/;\s*(?:\n|$)/)
			.map((statement) => statement.trim())
			.filter(Boolean);
		await database.batch(
			statements.map((statement) => database.prepare(statement)),
		);
	}
	return database;
}
