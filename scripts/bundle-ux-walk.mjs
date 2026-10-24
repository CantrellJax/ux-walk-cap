import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyUxWalkSource } from "./sync-ux-walk.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "packages", "ux-walk");

function run(command, args) {
	return execFileSync(command, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function xml(value) {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
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
	const helper = path.join(contents, "Helpers", "UX Walk.app");
	const resources = path.join(helper, "Contents", "Resources");
	const binaries = path.join(helper, "Contents", "MacOS");
	const engine = path.join(resources, "engine");
	await fs.mkdir(binaries, { recursive: true });
	await fs.mkdir(engine, { recursive: true });
	for (const item of [
		"src",
		"bin",
		"prompts",
		"assets",
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
	await fs.copyFile(
		path.join(root, "apps/desktop-gpui/assets/branding/cap-ux.icns"),
		path.join(resources, "cap-ux.icns"),
	);
	await fs.copyFile(
		path.join(source, "assets/foot.svg"),
		path.join(resources, "foot.svg"),
	);
	const architecture = process.arch === "arm64" ? "arm64" : "x86_64";
	for (const [file, output] of [
		["uxw-menubar.swift", path.join(binaries, "ux-walk")],
		["uxw-capture.swift", path.join(engine, "bin", "uxw-capture")],
	]) {
		run("swiftc", [
			"-O",
			"-suppress-warnings",
			"-target",
			`${architecture}-apple-macos15.0`,
			path.join(source, "swift", file),
			"-o",
			output,
		]);
	}
	const environment = parent.LSEnvironment ?? {};
	const environmentXML = Object.entries(environment)
		.map(
			([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`,
		)
		.join("");
	const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${xml(parent.CFBundleIdentifier)}.ux-walk</string>
<key>CFBundleName</key><string>UX Walk</string>
<key>CFBundleExecutable</key><string>ux-walk</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleIconFile</key><string>cap-ux</string>
<key>CFBundleShortVersionString</key><string>${xml(parent.CFBundleShortVersionString)}</string>
<key>LSMinimumSystemVersion</key><string>15.0</string>
<key>LSUIElement</key><true/>
<key>NSMicrophoneUsageDescription</key><string>UX Walk records your narration with the walkthrough.</string>
<key>NSCameraUsageDescription</key><string>UX Walk includes your camera when you select it.</string>
<key>NSAudioCaptureUsageDescription</key><string>UX Walk records call audio when you select it.</string>
<key>LSEnvironment</key><dict>${environmentXML}</dict>
</dict></plist>
`;
	await fs.writeFile(path.join(helper, "Contents", "Info.plist"), plist);
	await fs.writeFile(
		path.join(resources, "engine-source.json"),
		`${JSON.stringify({ repository: "https://github.com/CantrellJax/ux-walk-cap", sourceURL: `${parent.UXWalkSourceURL ?? `https://github.com/CantrellJax/ux-walk-cap/tree/${run("git", ["-C", root, "rev-parse", "HEAD"]).trim()}`}/packages/ux-walk`, revision, node: process.version }, null, 2)}\n`,
	);
	for (const target of [
		path.join(engine, "bin", "node"),
		path.join(engine, "bin", "uxw-capture"),
		helper,
		path.resolve(app),
	]) {
		run("codesign", ["--force", "--sign", "-", target]);
	}
	run("codesign", ["--verify", "--deep", "--strict", path.resolve(app)]);
	console.log(`Bundled UX Walk ${revision} into ${path.basename(app)}`);
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
