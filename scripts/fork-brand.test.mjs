import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relative) =>
	readFileSync(new URL(relative, import.meta.url), "utf8");
const brand = JSON.parse(read("../crates/fork-brand/brand.json"));
const config = JSON.parse(read("../apps/desktop-gpui/tauri.conf.json"));
const plist = read("../apps/desktop-gpui/Info.plist");

const plistString = (key) =>
	plist.match(
		new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`),
	)?.[1];

test("the bundle config carries the identity in brand.json", () => {
	assert.equal(config.productName, brand.display_name);
	assert.equal(config.identifier, brand.bundle_id);
	assert.deepEqual(config.plugins["deep-link"].desktop.schemes, [
		brand.url_scheme,
	]);
	assert.equal(config.bundle.createUpdaterArtifacts, false);
	assert.equal(config.bundle.longDescription, brand.long_description);
	assert.deepEqual(config.bundle.icon, brand.icon);
});

test("Info.plist carries the name and usage strings in brand.json", () => {
	assert.equal(plistString("CFBundleDisplayName"), brand.display_name);
	assert.equal(
		plistString("CFBundleTypeName"),
		brand.macos.document_type_name,
	);
	assert.equal(
		plistString("NSCameraUsageDescription"),
		brand.macos.camera_usage,
	);
	assert.equal(
		plistString("NSMicrophoneUsageDescription"),
		brand.macos.microphone_usage,
	);
	assert.equal(
		plistString("NSScreenCaptureUsageDescription"),
		brand.macos.screen_capture_usage,
	);
});
