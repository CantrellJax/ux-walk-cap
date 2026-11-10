import { mkdir, readFile, writeFile } from "node:fs/promises";

const source = new URL("../node_modules/rrweb-player/dist/", import.meta.url);
const target = new URL("../public/vendor/", import.meta.url);
const withoutSourceMap = (text) =>
	text.replace(/\n\/[/*][#@] sourceMappingURL=\S+(?: \*\/)?\s*$/, "\n");

await mkdir(target, { recursive: true });
await writeFile(
	new URL("rrweb-player.js", target),
	withoutSourceMap(
		await readFile(new URL("rrweb-player.umd.min.cjs", source), "utf8"),
	),
);

const images = [];
const css = withoutSourceMap(
	await readFile(new URL("style.min.css", source), "utf8"),
).replace(
	/url\((['"]?)data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)\1\)/g,
	(_match, _quote, data) => {
		const name = `rrweb-player-${images.length + 1}.svg`;
		images.push(writeFile(new URL(name, target), Buffer.from(data, "base64")));
		return `url(/vendor/${name})`;
	},
);
if (/url\((['"]?)data:/.test(css))
	throw new Error(
		"rrweb-player CSS has a data: URL the replay CSP would block.",
	);
await Promise.all(images);
await writeFile(new URL("rrweb-player.css", target), css);
