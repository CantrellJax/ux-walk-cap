import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { registerCompanion } from "../../src/companion-install.mjs";

test("setup stages the exact extension and fixed host identity in an isolated home and preserves Chrome origin arguments", (t) => {
	const root = fs.mkdtempSync("/tmp/uxw-companion-setup-");
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.mkdirSync(path.join(root, "Library/Application Support/Google/Chrome"), {
		recursive: true,
	});
	const configDir = path.join(root, "config space's"),
		engineDirectory = fileURLToPath(new URL("../..", import.meta.url));
	const result = registerCompanion({
		homeDirectory: root,
		configDir,
		engineDirectory,
	});
	const manifest = JSON.parse(
		fs.readFileSync(
			path.join(
				root,
				"Library/Application Support/Google/Chrome/NativeMessagingHosts/com.onc4ll.uxwalk.json",
			),
		),
	);
	assert.deepEqual(manifest.allowed_origins, [
		"chrome-extension://lcdckhfbhjchfjnnnkmcbjnefdnapelh/",
	]);
	assert.match(fs.readFileSync(manifest.path, "utf8"), /"\$@"/);
	assert.match(
		fs.readFileSync(manifest.path, "utf8"),
		/export CAP_UX_WALK_CONFIG_DIR=/,
	);
	assert.equal(spawnSync("sh", ["-n", manifest.path]).status, 0);
	assert.equal(
		fs.readFileSync(path.join(result.extensionDirectory, "foot.svg"), "utf8"),
		fs.readFileSync(path.join(engineDirectory, "assets/foot.svg"), "utf8"),
	);
	fs.writeFileSync(
		path.join(configDir, "companion-session.json"),
		JSON.stringify({ pid: process.pid, recorderPid: process.pid }),
	);
	assert.throws(
		() =>
			registerCompanion({ homeDirectory: root, configDir, engineDirectory }),
		/recording|active/i,
	);
});
