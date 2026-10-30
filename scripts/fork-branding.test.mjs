import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const desktop = new URL("../apps/desktop-gpui/", import.meta.url);
const read = (relative) => readFileSync(new URL(relative, desktop));
const text = (relative) => read(relative).toString("utf8");

const protectedCopies = [
	["assets/icons/logo-full.svg", "assets/branding/logo-full.svg"],
	["assets/icons/logo-full-dark.svg", "assets/branding/logo-full-dark.svg"],
	["assets/icons/logo-mark.svg", "assets/branding/logo-mark.svg"],
	["assets/dock-icon.png", "assets/branding/dock-icon.png"],
	["icons/macos/icon.icns", "assets/branding/cap-ux.icns"],
];

const references = [
	["src/main_window.rs", '"icons/logo-full.svg"'],
	["src/main_window.rs", '"icons/logo-full-dark.svg"'],
	["src/screenshot_editor.rs", '"icons/logo-mark.svg"'],
	["src/main.rs", '"../assets/dock-icon.png"'],
	["src/permission_guide.rs", '"../assets/dock-icon.png"'],
];

const protectedByAttributes = [
	[
		"assets/.gitattributes",
		[
			"icons/logo-full.svg",
			"icons/logo-full-dark.svg",
			"icons/logo-mark.svg",
			"dock-icon.png",
		],
	],
	["icons/.gitattributes", ["macos/icon.icns"]],
];

test("upstream asset paths carry the fork art", () => {
	for (const [upstream, master] of protectedCopies) {
		assert.ok(
			read(upstream).equals(read(master)),
			`apps/desktop-gpui/${upstream} no longer matches apps/desktop-gpui/${master}. ` +
				`Re-copy the master over it (an upstream merge brought back Cap art), ` +
				`or update the master if the fork art changed on purpose.`,
		);
	}
});

test("the code still draws the protected asset paths", () => {
	for (const [source, path] of references) {
		assert.ok(
			text(source).includes(path),
			`apps/desktop-gpui/${source} stopped naming ${path}. Upstream moved or ` +
				`renamed this asset: put the fork master at the new path, add it to the ` +
				`nested .gitattributes, and update this guard.`,
		);
	}
	const config = JSON.parse(text("tauri.conf.json"));
	assert.ok(
		config.bundle.icon.includes("icons/macos/icon.icns"),
		"tauri.conf.json no longer bundles icons/macos/icon.icns. Copy " +
			"assets/branding/cap-ux.icns over the icns it names now and update this guard.",
	);
});

test("protected asset paths keep the fork side on upstream merges", () => {
	for (const [file, paths] of protectedByAttributes) {
		const lines = text(file).split("\n");
		for (const path of paths) {
			assert.ok(
				lines.includes(`${path} merge=ours`),
				`apps/desktop-gpui/${file} must keep "${path} merge=ours".`,
			);
		}
	}
});
