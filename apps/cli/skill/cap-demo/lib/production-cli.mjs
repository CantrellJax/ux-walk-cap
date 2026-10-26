import path from "node:path";
import {
	prepareProduction,
	readProduction,
	renderProduction,
} from "./production.mjs";
import { runTool } from "./production-tools.mjs";

export async function productionMain(argv) {
	const [command, ...args] = argv;
	const values = {};
	let input;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (
			["--out", "--captions", "--cap", "--filmcraft", "--effectcraft"].includes(
				arg,
			)
		) {
			if (!args[i + 1] || args[i + 1].startsWith("--"))
				throw new Error(`Missing value for ${arg}`);
			values[arg.slice(2)] = args[++i];
		} else if (arg === "--help" || arg === "-h") {
			console.log(
				"cap-demo prepare <recording.cap|native-walk.json|video> --out <new-folder> [--captions transcript.srt]\ncap-demo inspect <folder>\ncap-demo render <folder> [--filmcraft <binary>] [--effectcraft <binary>]\ncap-demo doctor",
			);
			return;
		} else if (arg.startsWith("-") || input)
			throw new Error(`Unexpected argument: ${arg}`);
		else input = arg;
	}
	let result;
	if (command === "doctor") {
		result = [];
		for (const [name, binary] of [
			[
				"FilmCraft",
				values.filmcraft || process.env.FILMCRAFT_BIN || "filmcraft-cli",
			],
			[
				"EffectCraft",
				values.effectcraft || process.env.EFFECTCRAFT_BIN || "effectcraft-cli",
			],
			["FFmpeg", "ffmpeg"],
			["FFprobe", "ffprobe"],
		]) {
			try {
				const { stdout } = await runTool(
					binary,
					[name.startsWith("FF") ? "-version" : "--version"],
					{ timeout: 10000 },
				);
				result.push({
					name,
					ready: true,
					version: stdout.trim().split("\n")[0],
				});
			} catch (error) {
				result.push({ name, ready: false, error: error.message });
			}
		}
	} else {
		if (!input)
			throw new Error(`Missing input for ${command}; use ${command} --help`);
		if (command === "prepare") {
			if (!values.out) throw new Error("Choose a new output folder with --out");
			result = await prepareProduction(input, values.out, values);
		} else if (command === "inspect")
			result = await readProduction(path.resolve(input));
		else if (command === "render")
			result = await renderProduction(input, values);
		else throw new Error(`Unknown production command: ${command}`);
	}
	console.log(JSON.stringify(result, null, 2));
}
