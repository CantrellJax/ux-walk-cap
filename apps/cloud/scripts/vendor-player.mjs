import { mkdir, readFile, writeFile } from "node:fs/promises";

const source = new URL("../node_modules/rrweb-player/dist/", import.meta.url);
const target = new URL("../public/vendor/", import.meta.url);
const withoutSourceMap = (text) =>
	text.replace(/\n\/[/*][#@] sourceMappingURL=\S+(?: \*\/)?\s*$/, "\n");

await mkdir(target, { recursive: true });
for (const [from, to] of [
	["rrweb-player.umd.min.cjs", "rrweb-player.js"],
	["style.min.css", "rrweb-player.css"],
])
	await writeFile(
		new URL(to, target),
		withoutSourceMap(await readFile(new URL(from, source), "utf8")),
	);
