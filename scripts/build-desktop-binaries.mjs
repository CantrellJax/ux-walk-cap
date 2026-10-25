import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
	releaseBinaryMatchesDebugBinary,
	stagedBinariesAreCurrent,
} from "./build-desktop-binaries-cache.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
export function detectHostTriple({
	runCommand = spawnSync,
	env = process.env,
} = {}) {
	const result = runCommand("rustc", ["-vV"], { encoding: "utf8", env });
	if (result.status !== 0) {
		const reason =
			result.stderr || result.error?.message || `exit ${result.status}`;
		throw new Error(`rustc -vV failed: ${reason}`);
	}
	const match = result.stdout.match(/^host:\s*(.+)$/m);
	if (!match) throw new Error("Could not parse host triple from rustc -vV");
	return match[1].trim();
}

async function fileExists(p) {
	return await fs
		.access(p)
		.then(() => true)
		.catch(() => false);
}

export function nativeBuildEnvironment(env) {
	const native = { ...env };
	delete native.CARGO_BUILD_TARGET;
	delete native.RUST_TARGET_TRIPLE;
	return native;
}

export function parseOptions(args) {
	const positional = args.filter((arg) => arg !== "--debug");
	if (positional.length > 1 || positional.some((arg) => arg.startsWith("-"))) {
		throw new Error(
			"Usage: node scripts/build-desktop-binaries.mjs [target-triple] [--debug]",
		);
	}
	return { target: positional[0], debug: args.includes("--debug") };
}

export async function buildDesktopBinaries(
	args = process.argv.slice(2),
	{ root = repoRoot, env = process.env, runCommand = spawnSync } = {},
) {
	const options = parseOptions(args);
	const host = options.debug
		? detectHostTriple({ runCommand, env })
		: undefined;
	const target =
		options.target ||
		(options.debug ? host : env.RUST_TARGET_TRIPLE) ||
		detectHostTriple({ runCommand, env });
	if (options.debug && target !== host) {
		throw new Error(
			`Debug desktop binaries require host target ${host}, received ${target}`,
		);
	}
	const profile = options.debug ? "debug" : "release";
	const ext = target.includes("windows") ? ".exe" : "";
	const destination = path.join(
		root,
		"apps",
		"desktop",
		"src-tauri",
		"binaries",
	);
	await fs.mkdir(destination, { recursive: true });

	for (const sidecar of [
		{
			packageName: "cap-muxer",
			sourceBinary: "cap-muxer",
			destBinaries: ["cap-muxer"],
			watchPaths: [
				path.join(root, "crates", "cap-muxer"),
				path.join(root, "crates", "cap-muxer-protocol"),
				path.join(root, "Cargo.lock"),
			],
		},
		{
			packageName: "cap",
			sourceBinary: "cap",
			destBinaries: ["cap-cli", "cap-exporter"],
			watchPaths: [
				path.join(root, "apps", "cli"),
				path.join(root, "crates", "cli-install"),
				path.join(root, "crates", "editor"),
				path.join(root, "crates", "enc-ffmpeg"),
				path.join(root, "crates", "export"),
				path.join(root, "crates", "media"),
				path.join(root, "crates", "media-info"),
				path.join(root, "crates", "project"),
				path.join(root, "crates", "rendering"),
				path.join(root, "Cargo.lock"),
			],
		},
	]) {
		await buildSidecar(sidecar, target, ext, {
			root,
			destination,
			profile,
			env,
			runCommand,
		});
	}
}

async function buildSidecar(
	sidecar,
	target,
	ext,
	{ root, destination, profile, env, runCommand },
) {
	const src = path.join(
		root,
		"target",
		...(profile === "debug" ? [] : [target]),
		profile,
		`${sidecar.sourceBinary}${ext}`,
	);
	const dests = sidecar.destBinaries.map((destBinary) =>
		path.join(destination, `${destBinary}-${target}${ext}`),
	);
	const debugBinaries = [
		path.join(root, "target", target, "debug", `${sidecar.sourceBinary}${ext}`),
		path.join(root, "target", "debug", `${sidecar.sourceBinary}${ext}`),
	];

	if (
		profile === "release" &&
		(await releaseBinaryMatchesDebugBinary(src, debugBinaries))
	) {
		console.warn(
			`Discarding debug binary found in release artifact path: ${src}`,
		);
		await fs.rm(src);
	}

	if (
		profile === "release" &&
		(await stagedBinariesAreCurrent(
			src,
			dests,
			sidecar.watchPaths,
			debugBinaries,
		))
	) {
		console.log(
			`${sidecar.destBinaries.join(", ")} desktop binaries up to date`,
		);
		return;
	}

	console.log(
		`Building ${sidecar.destBinaries.join(", ")} desktop binaries for ${target}...`,
	);
	const cargo = runCommand(
		"cargo",
		[
			"build",
			...(profile === "release" ? ["--release"] : []),
			"-p",
			sidecar.packageName,
			...(profile === "release" ? ["--target", target] : []),
		],
		{
			stdio: "inherit",
			cwd: root,
			env: profile === "debug" ? nativeBuildEnvironment(env) : env,
		},
	);
	if (cargo.error) throw cargo.error;
	if (cargo.status !== 0)
		throw new Error(
			`cargo build ${sidecar.packageName} failed with ${cargo.status ?? cargo.signal}`,
		);

	if (!(await fileExists(src))) {
		throw new Error(`built binary not found at ${src}`);
	}

	for (const dest of dests) {
		await fs.copyFile(src, dest);
		console.log(`Copied ${src} -> ${dest}`);
	}
}

const entrypoint = process.argv[1] && path.resolve(process.argv[1]);
if (
	[
		fileURLToPath(import.meta.url),
		path.join(__dirname, "build-cap-muxer.mjs"),
	].includes(entrypoint)
) {
	buildDesktopBinaries().catch((err) => {
		console.error(err);
		process.exitCode = 1;
	});
}
