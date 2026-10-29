import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const engineDirectory = path.join(root, "vendor", "ux-walk");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const included = [
	".gitignore",
	"LICENSE",
	"package.json",
	"package-lock.json",
	"glossary.example.txt",
	"src",
	"bin",
	"prompts",
	"swift",
	"skills",
	"extension",
	"assets/foot.svg",
	"assets/ux-walk.icns",
	"test/unit/embedded-config.test.mjs",
	"test/unit/start-link.test.mjs",
	"test/unit/cap-editor-handoff.test.mjs",
	"test/unit/transcript-only.test.mjs",
	"test/unit/transcript-words.test.mjs",
	"test/unit/companion.test.mjs",
	"test/unit/companion-owner-race.test.mjs",
	"test/unit/companion-page.test.mjs",
	"test/unit/companion-start.test.mjs",
	"test/unit/companion-utf8.test.mjs",
	"test/unit/companion-controller.test.mjs",
	"test/unit/companion-install.test.mjs",
	"test/unit/meet-attribution.test.mjs",
];

export async function verifyUxWalkSource(directory = engineDirectory) {
	const manifest = JSON.parse(
		await fs.readFile(path.join(directory, "SOURCE.json"), "utf8"),
	);
	for (const [file, hash] of Object.entries(manifest.files)) {
		if (path.isAbsolute(file) || file.split("/").includes(".."))
			throw new Error("Invalid engine source path");
		if (digest(await fs.readFile(path.join(directory, file))) !== hash)
			throw new Error(`Pinned UX Walk source changed: ${file}`);
	}
	const entries = await fs.readdir(directory, {
		recursive: true,
		withFileTypes: true,
	});
	for (const entry of entries) {
		const relative = path
			.relative(directory, path.join(entry.parentPath, entry.name))
			.split(path.sep)
			.join("/");
		if (relative === "node_modules" || relative.startsWith("node_modules/"))
			continue;
		if (entry.isSymbolicLink())
			throw new Error(`Unexpected engine symlink: ${relative}`);
		if (
			entry.isFile() &&
			relative !== "SOURCE.json" &&
			!Object.hasOwn(manifest.files, relative)
		)
			throw new Error(`Unexpected engine source file: ${relative}`);
	}
	return manifest;
}

async function synchronize(source, revision) {
	if (!/^[a-f0-9]{40}$/.test(revision))
		throw new Error("Use the full reviewed engine commit SHA");
	try {
		await fs.access(engineDirectory);
		await verifyUxWalkSource();
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		const entries = await fs.readdir(engineDirectory).catch(() => []);
		if (entries.length)
			throw new Error("Refusing to replace an unmanaged engine directory");
	}
	const list = execFileSync("git", [
		"-C",
		source,
		"ls-tree",
		"-rz",
		"--name-only",
		revision,
		"--",
		...included,
	])
		.toString()
		.split("\0")
		.filter(Boolean);
	if (!list.includes("LICENSE") || !list.includes("src/record.mjs"))
		throw new Error("Incomplete engine source");
	const files = {};
	const staged = `${engineDirectory}.staged-${process.pid}`;
	await fs.mkdir(staged, { recursive: false });
	try {
		for (const file of list) {
			const bytes = execFileSync(
				"git",
				["-C", source, "show", `${revision}:${file}`],
				{ maxBuffer: 16 * 1024 * 1024 },
			);
			const target = path.join(staged, file);
			await fs.mkdir(path.dirname(target), { recursive: true });
			await fs.writeFile(target, bytes);
			if (file.startsWith("bin/")) await fs.chmod(target, 0o755);
			files[file] = digest(bytes);
		}
		await fs.writeFile(
			path.join(staged, "SOURCE.json"),
			`${JSON.stringify({ name: "UX Walk", repository: "https://github.com/CantrellJax/ux-walk", revision, license: "AGPL-3.0-only", files }, null, 2)}\n`,
		);
		await verifyUxWalkSource(staged);
		await fs.rm(engineDirectory, { recursive: true, force: true });
		await fs.rename(staged, engineDirectory);
	} finally {
		await fs.rm(staged, { recursive: true, force: true });
	}
	console.log(`Exported ${list.length} reviewed engine files at ${revision}`);
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const [source, revision] = process.argv.slice(2);
	if (!source || !revision)
		throw new Error(
			"Usage: node scripts/sync-ux-walk.mjs <canonical-checkout> <reviewed-40-character-sha>",
		);
	synchronize(source, revision).catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
