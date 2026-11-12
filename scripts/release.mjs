import { execFileSync, spawnSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brand } from "./fork-brand.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gpuiDirectory = path.join(root, "apps", "desktop-gpui");

export const target = "aarch64-apple-darwin";
export const repository = new URL(brand.repo_url).pathname.replace(
	/^\/|\.git$/g,
	"",
);
export const keychainItems = {
	key: `${brand.slug}-updater-signing-key`,
	password: `${brand.slug}-updater-signing-password`,
};

const usage =
	"Usage: node scripts/release.mjs [--publish] [--skip-build] [--notes <text> | --notes-file <file>]";

export function parseArgs(args) {
	const options = { publish: false, skipBuild: false, notes: "" };
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (argument === "--publish") options.publish = true;
		else if (argument === "--skip-build") options.skipBuild = true;
		else if (argument === "--notes" || argument === "--notes-file") {
			const value = args[++index];
			if (value === undefined) throw new Error(`${argument} needs a value`);
			if (argument === "--notes") options.notes = value;
			else options.notesFile = value;
		} else throw new Error(`Unknown argument ${argument}\n${usage}`);
	}
	if (options.publish && options.skipBuild) {
		throw new Error(
			"--publish needs a fresh build; --skip-build could ship a binary from another version",
		);
	}
	return options;
}

export function checkPublishable(version, options) {
	if (options.publish && version.includes("-")) {
		throw new Error(
			`${version} is a pre-release; the updater would offer it to everyone as the latest release`,
		);
	}
}

export function checkBundleVersion(bundleVersion, version) {
	if (bundleVersion.trim() !== version) {
		throw new Error(
			`The bundle reports version ${bundleVersion.trim()} but Cargo.toml says ${version}; rebuild without --skip-build`,
		);
	}
}

export function packageVersion(cargoToml) {
	const start = cargoToml.indexOf("[package]");
	if (start === -1) throw new Error("Cargo.toml has no [package] section");
	const end = cargoToml.indexOf("\n[", start + 1);
	const section = cargoToml.slice(start, end === -1 ? undefined : end);
	const match = /^version\s*=\s*"([^"]+)"$/m.exec(section);
	if (!match) throw new Error("Cargo.toml has no package version");
	if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(match[1])) {
		throw new Error(`Invalid package version ${match[1]}`);
	}
	return match[1];
}

export function pickSigningIdentity(findIdentityOutput, env = process.env) {
	const requested = env.CAP_UX_SIGNING_IDENTITY;
	if (requested === "-") {
		throw new Error(
			"Releases need a stable signing identity; an ad-hoc signature resets macOS privacy permissions on every update",
		);
	}
	if (requested) return { identity: requested, name: requested };
	const found = [
		...findIdentityOutput.matchAll(
			/^\s*\d+\)\s+([0-9A-F]{40})\s+"(Apple Development: [^"]+)"/gm,
		),
	];
	if (found.length === 0) {
		throw new Error(
			"No Apple Development signing identity in the keychain; set CAP_UX_SIGNING_IDENTITY",
		);
	}
	if (new Set(found.map(([, hash]) => hash)).size > 1) {
		throw new Error(
			`Several Apple Development identities (${found.map(([, , name]) => name).join(", ")}); choose one with CAP_UX_SIGNING_IDENTITY`,
		);
	}
	return { identity: found[0][1], name: found[0][2] };
}

export function releaseAssets() {
	const archive = `${brand.display_name}.app.tar.gz`;
	return {
		app: `${brand.display_name}.app`,
		archive,
		signature: `${archive}.sig`,
		dmg: `${brand.display_name}.dmg`,
		manifest: "latest.json",
	};
}

export function releaseManifest({ version, notes, signature, pubDate }) {
	return {
		version,
		notes,
		pub_date: pubDate,
		url: `${brand.releases_url}/download/v${version}/${encodeURIComponent(releaseAssets().archive)}`,
		signature,
	};
}

const decodeText = (encoded) =>
	Buffer.from(encoded.trim(), "base64").toString("utf8").trim().split("\n");

export function verifyMinisign(data, encodedSignature, encodedPublicKey) {
	const keyBytes = Buffer.from(decodeText(encodedPublicKey)[1], "base64");
	const [, signatureLine, trustedLine, globalLine] =
		decodeText(encodedSignature);
	const signatureBytes = Buffer.from(signatureLine, "base64");
	if (keyBytes.length !== 42 || signatureBytes.length !== 74) {
		throw new Error("Malformed minisign key or signature");
	}
	if (!keyBytes.subarray(2, 10).equals(signatureBytes.subarray(2, 10))) {
		return false;
	}
	const key = createPublicKey({
		key: Buffer.concat([
			Buffer.from("302a300506032b6570032100", "hex"),
			keyBytes.subarray(10),
		]),
		format: "der",
		type: "spki",
	});
	const prehashed = signatureBytes.subarray(0, 2).toString() === "ED";
	const message = prehashed
		? createHash("blake2b512").update(data).digest()
		: data;
	const signature = signatureBytes.subarray(10);
	const trustedComment = trustedLine.replace(/^trusted comment: /, "");
	return (
		verify(null, message, key, signature) &&
		verify(
			null,
			Buffer.concat([signature, Buffer.from(trustedComment)]),
			key,
			Buffer.from(globalLine, "base64"),
		)
	);
}

export function preflight(version, git) {
	if (git(["status", "--porcelain"]).trim()) {
		throw new Error(
			"The working tree has changes; commit or remove them first",
		);
	}
	const tag = `v${version}`;
	if (git(["tag", "--list", tag]).trim()) {
		throw new Error(
			`Tag ${tag} already exists; bump the version in apps/desktop-gpui/Cargo.toml`,
		);
	}
	if (
		git([
			"ls-remote",
			"--tags",
			`${brand.repo_url}.git`,
			`refs/tags/${tag}`,
		]).trim()
	) {
		throw new Error(
			`Tag ${tag} already exists on ${repository}; bump the version in apps/desktop-gpui/Cargo.toml`,
		);
	}
	return tag;
}

function output(command, args, options = {}) {
	return execFileSync(command, args, {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		...options,
	});
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: root,
		stdio: "inherit",
		...options,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} failed with ${result.signal ?? result.status}`,
		);
	}
}

const git = (args) => output("git", args);

const keychainSecret = (service) =>
	output("security", ["find-generic-password", "-s", service, "-w"]).replace(
		/\n$/,
		"",
	);

function requireKeychainItems() {
	for (const service of Object.values(keychainItems)) {
		const found = spawnSync(
			"security",
			["find-generic-password", "-s", service],
			{
				stdio: "ignore",
			},
		);
		if (found.status !== 0) {
			throw new Error(`The login Keychain has no "${service}" item`);
		}
	}
}

async function signArchive(archive) {
	run("bun", ["run", "tauri", "signer", "sign", archive], {
		cwd: gpuiDirectory,
		stdio: ["ignore", "ignore", "inherit"],
		env: {
			...process.env,
			TAURI_PRIVATE_KEY: keychainSecret(keychainItems.key),
			TAURI_PRIVATE_KEY_PASSWORD: keychainSecret(keychainItems.password),
		},
	});
	return (await fs.readFile(`${archive}.sig`, "utf8")).trim();
}

async function makeDmg(app, dmg) {
	const staging = await fs.mkdtemp(path.join(os.tmpdir(), "release-dmg-"));
	try {
		run("ditto", [app, path.join(staging, path.basename(app))]);
		await fs.symlink("/Applications", path.join(staging, "Applications"));
		run("hdiutil", [
			"create",
			"-volname",
			brand.display_name,
			"-srcfolder",
			staging,
			"-ov",
			"-format",
			"UDZO",
			dmg,
		]);
	} finally {
		await fs.rm(staging, { recursive: true, force: true });
	}
}

export async function release(args) {
	if (process.platform !== "darwin") throw new Error("Releases build on macOS");
	const options = parseArgs(args);
	const version = packageVersion(
		await fs.readFile(path.join(gpuiDirectory, "Cargo.toml"), "utf8"),
	);
	checkPublishable(version, options);
	const tag = preflight(version, git);
	const { identity, name } = pickSigningIdentity(
		output("security", ["find-identity", "-v", "-p", "codesigning"]),
	);
	requireKeychainItems();
	await fs
		.access(path.join(root, "vendor/ux-walk/node_modules/playwright-core"))
		.catch(() => {
			throw new Error(
				"Run npm ci --ignore-scripts --prefix vendor/ux-walk first",
			);
		});
	const notes = options.notesFile
		? (await fs.readFile(options.notesFile, "utf8")).trim()
		: options.notes;
	console.log(`Releasing ${brand.display_name} ${version}, signed by ${name}`);

	if (!options.skipBuild) {
		run(process.execPath, ["scripts/build-desktop-binaries.mjs", target]);
	}
	run("bun", [
		"run",
		"gpui:build",
		target,
		"--bundles",
		"app",
		...(options.skipBuild ? ["--skip-build"] : []),
	]);
	const assets = releaseAssets();
	const bundleDirectory = path.join(
		gpuiDirectory,
		"target",
		target,
		"release",
		"bundle",
		"macos",
	);
	const app = path.join(bundleDirectory, assets.app);
	run(
		process.env.RELEASE_NODE || process.execPath,
		["scripts/bundle-ux-walk.mjs", app],
		{ env: { ...process.env, CAP_UX_SIGNING_IDENTITY: identity } },
	);
	checkBundleVersion(
		output("plutil", [
			"-extract",
			"CFBundleShortVersionString",
			"raw",
			"-o",
			"-",
			path.join(app, "Contents", "Info.plist"),
		]),
		version,
	);

	const dist = path.join(root, "dist", "release", tag);
	await fs.rm(dist, { recursive: true, force: true });
	await fs.mkdir(dist, { recursive: true });
	const archive = path.join(dist, assets.archive);
	run(
		"tar",
		["--no-mac-metadata", "-czf", archive, "-C", bundleDirectory, assets.app],
		{ env: { ...process.env, COPYFILE_DISABLE: "1" } },
	);
	await makeDmg(app, path.join(dist, assets.dmg));

	const signature = await signArchive(archive);
	if (
		!verifyMinisign(await fs.readFile(archive), signature, brand.updater_pubkey)
	) {
		throw new Error(
			"The archive signature does not verify against brand.json's updater_pubkey",
		);
	}
	const manifest = releaseManifest({
		version,
		notes,
		signature,
		pubDate: new Date().toISOString(),
	});
	await fs.writeFile(
		path.join(dist, assets.manifest),
		`${JSON.stringify(manifest, null, "\t")}\n`,
	);
	console.log(`Wrote ${path.relative(root, dist)}`);
	if (!options.publish) return { dist, manifest };

	preflight(version, git);
	const sha = git(["rev-parse", "HEAD"]).trim();
	output("gh", ["api", `repos/${repository}/commits/${sha}`, "--silent"]);
	run("gh", [
		"release",
		"create",
		tag,
		"-R",
		repository,
		"--target",
		sha,
		"--title",
		`${brand.display_name} ${version}`,
		"--notes",
		notes,
		...[assets.dmg, assets.archive, assets.signature, assets.manifest].map(
			(file) => path.join(dist, file),
		),
	]);
	git(["tag", tag, sha]);
	console.log(`Published ${tag} to ${repository}`);
	return { dist, manifest };
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	release(process.argv.slice(2)).catch((error) => {
		console.error(error?.message ?? error);
		process.exitCode = 1;
	});
}
