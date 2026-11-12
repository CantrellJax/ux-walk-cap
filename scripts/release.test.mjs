import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { brand } from "./fork-brand.mjs";
import {
	keychainItems,
	packageVersion,
	parseArgs,
	pickSigningIdentity,
	preflight,
	releaseAssets,
	releaseManifest,
	repository,
	verifyMinisign,
} from "./release.mjs";

const probeSignature =
	"dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUemdlcm9ZcExyRVl0RC9IUjVnN2VhS0Q3QVp0U0lNRTUwWTU4WW1CelpEb3YwdkJYNU5VYXhRTnFsODJqTWFqTVFPM285SnU3alkwU0V6M2w3bGNUbFpjRzBocVlFUVFjPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk0NTE1ODI5CWZpbGU6cHJvYmUudHh0Ckx2VldPWHpSTzA4Rk9lTmFLLzlsTDhiTmtkbUo0NEtYeTlkcE55ZmRYbzJRdmdDdzdtTUVsZzZwRkJJSWhITHpyMlhES2lhWEhqWHBkd05VcEFLWkJRPT0K";

test("the version comes from the desktop package", () => {
	assert.equal(
		packageVersion(
			'[workspace]\nmembers = ["."]\n\n[package]\nname = "x"\nversion = "0.7.1"\n\n[dependencies]\nfoo = { version = "1.0.0" }\n',
		),
		"0.7.1",
	);
	const shipped = readFileSync(
		new URL("../apps/desktop-gpui/Cargo.toml", import.meta.url),
		"utf8",
	);
	assert.match(packageVersion(shipped), /^\d+\.\d+\.\d+/);
	assert.throws(() => packageVersion('[package]\nversion = "seven"\n'));
});

test("arguments", () => {
	assert.deepEqual(parseArgs([]), {
		publish: false,
		skipBuild: false,
		notes: "",
	});
	assert.deepEqual(parseArgs(["--publish", "--notes", "Fixes"]), {
		publish: true,
		skipBuild: false,
		notes: "Fixes",
	});
	assert.throws(() => parseArgs(["--notes"]));
	assert.throws(() => parseArgs(["--tag", "v1"]));
});

test("the Apple Development identity is picked by name", () => {
	const listing = [
		'  1) 4D1C64539ECA74A26E370D0B4FA22155443CCF36 "Apple Development: Someone (ABCDE12345)"',
		"     1 valid identities found",
	].join("\n");
	assert.deepEqual(pickSigningIdentity(listing, {}), {
		identity: "4D1C64539ECA74A26E370D0B4FA22155443CCF36",
		name: "Apple Development: Someone (ABCDE12345)",
	});
	assert.deepEqual(
		pickSigningIdentity(listing, { CAP_UX_SIGNING_IDENTITY: "Mine" }),
		{ identity: "Mine", name: "Mine" },
	);
	assert.throws(
		() => pickSigningIdentity(listing, { CAP_UX_SIGNING_IDENTITY: "-" }),
		/ad-hoc/,
	);
	assert.throws(() => pickSigningIdentity("0 valid identities found", {}));
	const two = `${listing}\n  2) 0000000000000000000000000000000000000000 "Apple Development: Other (ZZZZZ99999)"`;
	assert.throws(() => pickSigningIdentity(two, {}), /Several/);
});

test("the manifest points the updater at the tagged archive", () => {
	const assets = releaseAssets();
	assert.equal(assets.archive, `${brand.display_name}.app.tar.gz`);
	assert.equal(assets.dmg, `${brand.display_name}.dmg`);
	assert.equal(`https://github.com/${repository}`, brand.repo_url);
	assert.ok(keychainItems.key.startsWith(brand.slug));
	const manifest = releaseManifest({
		version: "0.7.0",
		notes: "",
		signature: "c2ln",
		pubDate: "2026-11-12T00:00:00.000Z",
	});
	assert.deepEqual(Object.keys(manifest).sort(), [
		"notes",
		"pub_date",
		"signature",
		"url",
		"version",
	]);
	assert.equal(
		manifest.url,
		`${brand.releases_url}/download/v0.7.0/${encodeURIComponent(assets.archive)}`,
	);
});

test("signatures verify against the committed updater key", () => {
	assert.equal(
		verifyMinisign(
			Buffer.from("hello\n"),
			probeSignature,
			brand.updater_pubkey,
		),
		true,
	);
	assert.equal(
		verifyMinisign(
			Buffer.from("hello!\n"),
			probeSignature,
			brand.updater_pubkey,
		),
		false,
	);
	const installer = readFileSync(
		new URL("../apps/desktop-gpui/src/installer.rs", import.meta.url),
		"utf8",
	);
	assert.ok(installer.includes(probeSignature));
});

test("preflight refuses a dirty tree and an existing tag", () => {
	const git = (answers) => (args) => answers[args[0]] ?? "";
	assert.equal(preflight("0.7.0", git({})), "v0.7.0");
	assert.throws(
		() => preflight("0.7.0", git({ status: " M Cargo.toml\n" })),
		/changes/,
	);
	assert.throws(
		() => preflight("0.7.0", git({ tag: "v0.7.0\n" })),
		/already exists/,
	);
	assert.throws(
		() => preflight("0.7.0", git({ "ls-remote": "abc\trefs/tags/v0.7.0\n" })),
		new RegExp(`already exists on ${repository}`),
	);
});
