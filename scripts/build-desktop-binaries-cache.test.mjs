import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
	buildDesktopBinaries,
	parseOptions,
} from "./build-desktop-binaries.mjs";
import {
	releaseBinaryMatchesDebugBinary,
	stagedBinariesAreCurrent,
} from "./build-desktop-binaries-cache.mjs";

async function fixture(context) {
	const directory = await fs.mkdtemp(
		path.join(os.tmpdir(), "cap-sidecar-cache-"),
	);
	context.after(async () => fs.rm(directory, { recursive: true, force: true }));
	const watched = path.join(directory, "source.rs");
	const release = path.join(directory, "release.exe");
	const cli = path.join(directory, "cap-cli.exe");
	const exporter = path.join(directory, "cap-exporter.exe");
	await fs.writeFile(watched, "source");
	await fs.writeFile(release, "optimized");
	await fs.writeFile(cli, "optimized");
	await fs.writeFile(exporter, "optimized");
	const sourceTime = new Date("2025-01-01T00:00:00.000Z");
	const binaryTime = new Date("2025-01-02T00:00:00.000Z");
	await fs.utimes(watched, sourceTime, sourceTime);
	for (const file of [release, cli, exporter])
		await fs.utimes(file, binaryTime, binaryTime);
	return { watched, release, cli, exporter, binaryTime };
}

test("rejects a debug binary copied into the release artifact path", async (context) => {
	const { watched, release, cli, exporter } = await fixture(context);
	const debug = path.join(path.dirname(release), "debug.exe");
	await fs.writeFile(debug, "optimized");

	assert.equal(await releaseBinaryMatchesDebugBinary(release, [debug]), true);
	assert.equal(
		await stagedBinariesAreCurrent(
			release,
			[cli, exporter],
			[watched],
			[debug],
		),
		false,
	);
});

test("accepts an optimized release artifact when a different debug binary exists", async (context) => {
	const { watched, release, cli, exporter } = await fixture(context);
	const debug = path.join(path.dirname(release), "debug.exe");
	await fs.writeFile(debug, "debug-one");

	assert.equal(await releaseBinaryMatchesDebugBinary(release, [debug]), false);
	assert.equal(
		await stagedBinariesAreCurrent(
			release,
			[cli, exporter],
			[watched],
			[debug],
		),
		true,
	);
});

test("accepts current release binary and byte-identical staged sidecars", async (context) => {
	const { watched, release, cli, exporter } = await fixture(context);
	assert.equal(
		await stagedBinariesAreCurrent(release, [cli, exporter], [watched]),
		true,
	);
});

test("rejects staged sidecars when the release binary does not exist", async (context) => {
	const { watched, release, cli, exporter } = await fixture(context);
	await fs.rm(release);
	assert.equal(
		await stagedBinariesAreCurrent(release, [cli, exporter], [watched]),
		false,
	);
});

test("rejects same-sized debug content even when staged files are newer", async (context) => {
	const { watched, release, cli, exporter, binaryTime } =
		await fixture(context);
	await fs.writeFile(cli, "debug-old");
	await fs.utimes(cli, binaryTime, binaryTime);
	assert.equal(
		await stagedBinariesAreCurrent(release, [cli, exporter], [watched]),
		false,
	);
});

test("rejects a release binary older than watched source", async (context) => {
	const { watched, release, cli, exporter } = await fixture(context);
	const newerSource = new Date("2025-01-03T00:00:00.000Z");
	await fs.utimes(watched, newerSource, newerSource);
	assert.equal(
		await stagedBinariesAreCurrent(release, [cli, exporter], [watched]),
		false,
	);
});

test("rejects any missing or mismatched secondary destination", async (context) => {
	const { watched, release, cli, exporter, binaryTime } =
		await fixture(context);
	await fs.writeFile(exporter, "wrong-one");
	await fs.utimes(exporter, binaryTime, binaryTime);
	assert.equal(
		await stagedBinariesAreCurrent(release, [cli, exporter], [watched]),
		false,
	);
	await fs.rm(exporter);
	assert.equal(
		await stagedBinariesAreCurrent(release, [cli, exporter], [watched]),
		false,
	);
});

async function buildFixture(context) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "cap-sidecar-build-"));
	context.after(() => fs.rm(root, { recursive: true, force: true }));
	const target = "aarch64-apple-darwin";
	for (const profile of ["debug", `${target}/release`]) {
		await fs.mkdir(path.join(root, "target", profile), { recursive: true });
		for (const binary of ["cap", "cap-muxer"])
			await fs.writeFile(
				path.join(root, "target", profile, binary),
				`${profile}-${binary}`,
			);
	}
	return {
		root,
		target,
		destination: path.join(root, "apps/desktop-gpui/binaries"),
	};
}

test("debug sidecars build and stage native artifacts without touching release paths", async (context) => {
	const { root, target, destination } = await buildFixture(context);
	const calls = [];
	const env = {
		CARGO_BUILD_TARGET: "foreign-target",
		RUST_TARGET_TRIPLE: "foreign-target",
	};
	await buildDesktopBinaries([target, "--debug"], {
		root,
		env,
		runCommand: (command, args, options) => {
			calls.push({ command, args, env: options.env });
			return command === "rustc"
				? { status: 0, stdout: `host: ${target}\n` }
				: { status: 0 };
		},
	});
	assert.deepEqual(
		calls.filter((call) => call.command === "cargo").map((call) => call.args),
		[
			["build", "-p", "cap-muxer"],
			["build", "-p", "cap"],
		],
	);
	for (const call of calls.filter((call) => call.command === "cargo")) {
		assert.equal(call.env.CARGO_BUILD_TARGET, undefined);
		assert.equal(call.env.RUST_TARGET_TRIPLE, undefined);
	}
	for (const [name, source] of [
		["cap-muxer", "cap-muxer"],
		["cap-cli", "cap"],
		["cap-exporter", "cap"],
	]) {
		assert.equal(
			await fs.readFile(path.join(destination, `${name}-${target}`), "utf8"),
			`debug-${source}`,
		);
		assert.equal(
			await fs.readFile(
				path.join(root, "target", target, "release", source),
				"utf8",
			),
			`${target}/release-${source}`,
		);
	}
	assert.equal(env.CARGO_BUILD_TARGET, "foreign-target");
});

test("a foreign debug target fails before building or staging", async (context) => {
	const { root, destination } = await buildFixture(context);
	const calls = [];
	await assert.rejects(
		buildDesktopBinaries(["x86_64-apple-darwin", "--debug"], {
			root,
			runCommand: (command) => {
				calls.push(command);
				return { status: 0, stdout: "host: aarch64-apple-darwin\n" };
			},
		}),
		/require host target/,
	);
	assert.deepEqual(calls, ["rustc"]);
	await assert.rejects(fs.access(destination), /ENOENT/);
	assert.deepEqual(parseOptions(["--debug"]), {
		target: undefined,
		debug: true,
	});
	assert.throws(() => parseOptions(["--debug=true"]), /Usage/);
});

test("release builds keep their cache and rebuild rather than stage debug content", async (context) => {
	const { root, target, destination } = await buildFixture(context);
	const calls = [];
	const runCommand = (command, args) => {
		calls.push({ command, args });
		return { status: 0 };
	};
	await buildDesktopBinaries([target], { root, runCommand });
	assert.deepEqual(
		calls.map((call) => call.args),
		[
			["build", "--release", "-p", "cap-muxer", "--target", target],
			["build", "--release", "-p", "cap", "--target", target],
		],
	);
	calls.length = 0;
	await buildDesktopBinaries([target], { root, runCommand });
	assert.deepEqual(calls, []);
	await fs.copyFile(
		path.join(root, "target/debug/cap-muxer"),
		path.join(root, "target", target, "release/cap-muxer"),
	);
	await assert.rejects(
		buildDesktopBinaries([target], { root, runCommand }),
		/built binary not found/,
	);
	assert.deepEqual(
		calls.map((call) => call.args),
		[["build", "--release", "-p", "cap-muxer", "--target", target]],
	);
	assert.equal(
		await fs.readFile(path.join(destination, `cap-muxer-${target}`), "utf8"),
		`${target}/release-cap-muxer`,
	);
});

test("the legacy sidecar entrypoint still validates arguments without starting a build", () => {
	const result = spawnSync(
		process.execPath,
		[
			new URL("./build-cap-muxer.mjs", import.meta.url).pathname,
			"--debug=true",
		],
		{ encoding: "utf8" },
	);
	assert.equal(result.status, 1);
	assert.match(
		result.stderr,
		/Usage: node scripts\/build-desktop-binaries.mjs/,
	);
});
