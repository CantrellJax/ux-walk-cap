import { build } from "esbuild";

await build({
	entryPoints: [new URL("./auth-client.js", import.meta.url).pathname],
	outfile: new URL("../public/app/auth-client.js", import.meta.url).pathname,
	bundle: true,
	format: "esm",
	platform: "browser",
	target: "es2022",
	minify: true,
	legalComments: "linked",
	logLevel: "warning",
});
