import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyUxWalkSource } from "./sync-ux-walk.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "vendor", "ux-walk");

function run(command, args) {
	return execFileSync(command, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

export async function bundleUxWalk(app) {
	if (process.platform !== "darwin") throw new Error("Bundle UX Walk on macOS");
	const contents = path.join(path.resolve(app), "Contents");
	const parent = JSON.parse(
		run("plutil", [
			"-convert",
			"json",
			"-o",
			"-",
			path.join(contents, "Info.plist"),
		]),
	);
	if (!String(parent.CFBundleIdentifier).startsWith("com.cantrell.cap-ux")) {
		throw new Error("UX Walk can only be bundled into a Cap-UX app");
	}
	const { revision } = await verifyUxWalkSource(source);
	await fs.access(
		path.join(source, "node_modules/playwright-core/package.json"),
	);
	const resources = path.join(contents, "Resources");
	const engine = path.join(resources, "ux-walk");
	await fs.mkdir(engine, { recursive: true });
	for (const item of [
		"src",
		"bin",
		"prompts",
		"assets",
		"skills",
		"glossary.example.txt",
		"package.json",
		"package-lock.json",
		"LICENSE",
		"SOURCE.json",
	]) {
		await fs.cp(path.join(source, item), path.join(engine, item), {
			recursive: true,
		});
	}
	await fs.cp(
		path.join(source, "node_modules", "playwright-core"),
		path.join(engine, "node_modules", "playwright-core"),
		{ recursive: true },
	);
	await fs.copyFile(process.execPath, path.join(engine, "bin", "node"));
	await fs.chmod(path.join(engine, "bin", "node"), 0o755);
	const nodeLicense = path.resolve(
		path.dirname(process.execPath),
		"..",
		"LICENSE",
	);
	await fs.copyFile(nodeLicense, path.join(resources, "NODE-LICENSE"));
	await fs.copyFile(
		path.join(root, "LICENSE"),
		path.join(resources, "CAP-LICENSE"),
	);
	for (const file of [
		"native-walk.mjs",
		"native-audio.mjs",
		"checkpoint-store.mjs",
		"walk-lock.mjs",
		"chapter-attribution.mjs",
		"checkpoint-jobs.mjs",
		"checkpoint-worker.mjs",
		"checkpoint-transcript.mjs",
		"fragmented-audio.mjs",
		"recovery-transport.mjs",
		"restore-checkpoint.mjs",
		"native-browser.mjs",
		"browser-evidence.mjs",
	]) {
		await fs.copyFile(
			path.join(root, "apps/desktop-gpui/ux-walk", file),
			path.join(engine, file),
		);
	}
	await fs.writeFile(
		path.join(resources, "engine-source.json"),
		`${JSON.stringify({ repository: "https://github.com/CantrellJax/ux-walk-cap", sourceURL: `${parent.UXWalkSourceURL ?? `https://github.com/CantrellJax/ux-walk-cap/tree/${run("git", ["-C", root, "rev-parse", "HEAD"]).trim()}`}/vendor/ux-walk`, revision, node: process.version }, null, 2)}\n`,
	);
	for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
		run("plutil", [
			"-replace",
			key,
			"-string",
			"Cap UX",
			path.join(contents, "Info.plist"),
		]);
	}
	const identity = process.env.CAP_UX_SIGNING_IDENTITY || "-";
	for (const target of [path.join(engine, "bin", "node"), path.resolve(app)]) {
		run("codesign", [
			"--force",
			"--sign",
			identity,
			"--preserve-metadata=entitlements",
			target,
		]);
	}
	run("codesign", ["--verify", "--deep", "--strict", path.resolve(app)]);
	console.log(
		`Bundled the native UX Walk engine ${revision} into ${path.basename(app)}`,
	);
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const app = process.argv[2];
	if (!app)
		throw new Error("Usage: node scripts/bundle-ux-walk.mjs <Cap-UX.app>");
	bundleUxWalk(app).catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
