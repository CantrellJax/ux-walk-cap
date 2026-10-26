import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const ticks = (seconds) => Math.round(seconds * 254016000000);

export async function runTool(binary, args, options = {}) {
	if (binary.includes("/") || binary.includes("\\"))
		binary = path.resolve(binary);
	try {
		return await exec(binary, args, {
			encoding: "utf8",
			timeout: 15 * 60 * 1000,
			maxBuffer: 8 * 1024 * 1024,
			...options,
		});
	} catch (error) {
		throw new Error(
			`${path.basename(binary)} failed: ${error.stderr?.trim() || error.message}`,
			{ cause: error },
		);
	}
}

function jsonOutput(stdout) {
	const start = stdout.search(/[[{]/);
	if (start < 0) throw new Error("Editor returned no JSON result");
	return JSON.parse(stdout.slice(start));
}

export async function probeVideo(file) {
	const { stdout } = await runTool("ffprobe", [
		"-v",
		"error",
		"-show_streams",
		"-show_format",
		"-of",
		"json",
		file,
	]);
	const info = JSON.parse(stdout);
	const video = info.streams.find((stream) => stream.codec_type === "video");
	const [num, den] = String(video?.avg_frame_rate).split("/").map(Number);
	const fps = num / den;
	const duration = Number(video?.duration ?? info.format?.duration);
	if (
		!(
			video?.width > 0 &&
			video.height > 0 &&
			fps > 0 &&
			fps <= 120 &&
			duration > 0 &&
			duration <= 21600
		)
	)
		throw new Error(
			"Source must be a playable video of at most six hours and 120 fps",
		);
	return {
		width: video.width,
		height: video.height,
		fps,
		frames: Number(video.nb_frames) || Math.round(duration * fps),
		hasAudio: info.streams.some((stream) => stream.codec_type === "audio"),
	};
}

export async function exportCap(
	project,
	output,
	binary = process.env.CAP_BIN || "cap",
) {
	const { stdout } = await runTool(binary, [
		"project",
		"validate",
		project,
		"--json",
	]);
	if (!JSON.parse(stdout).valid)
		throw new Error("Cap source is incomplete or missing media");
	await runTool(binary, [
		"export",
		project,
		"--output",
		output,
		"--format",
		"mp4",
		"--quality",
		"web",
	]);
}

export async function renderGraphic(directory, spec, media, binary) {
	const project = "graphic.ecproj";
	const duration = spec.durationFrames / media.fps;
	const commands = [
		"comp.new",
		JSON.stringify({
			name: "Graphic",
			width: media.width,
			height: media.height,
			frameRate: media.fps,
			duration,
			background: spec.background || "#101827",
		}),
		"layer.newShape",
		JSON.stringify({
			name: "Accent",
			kind: "rect",
			size: [media.width * 0.1, media.height * 0.012],
			position: [media.width * 0.13, media.height * 0.3],
			fill: spec.accent || "#4b85ff",
			strokeWidth: 0,
		}),
		"layer.newText",
		JSON.stringify({
			name: "Title",
			text: spec.title,
			box: [
				media.width * 0.08,
				media.height * 0.36,
				media.width * 0.84,
				media.height * 0.28,
			],
			justify: "left",
			size: media.height * 0.08,
			fill: "#ffffff",
			font: "Helvetica",
		}),
	];
	if (spec.subtitle)
		commands.push(
			"layer.newText",
			JSON.stringify({
				name: "Subtitle",
				text: spec.subtitle,
				box: [
					media.width * 0.08,
					media.height * 0.69,
					media.width * 0.84,
					media.height * 0.18,
				],
				justify: "left",
				size: media.height * 0.035,
				fill: "#c2cbd8",
				font: "Helvetica",
			}),
		);
	await runTool(
		binary,
		["--empty", "--save-as", project, "run", ...commands, "--json"],
		{ cwd: directory },
	);
	for (const [time, value] of [
		[0, 0],
		[Math.min(0.3, duration / 4), 100],
	]) {
		await runTool(
			binary,
			[
				"--project",
				project,
				"--save",
				"set",
				"Graphic",
				"Title",
				"transform/opacity",
				String(value),
				"--time",
				String(time),
				"--json",
			],
			{ cwd: directory },
		);
	}
	await runTool(
		binary,
		[
			"--project",
			project,
			"render",
			"--out",
			"graphic.mp4",
			"--format",
			"h264",
			"--audio",
			"off",
			"--json",
		],
		{ cwd: directory },
	);
	return "graphic.mp4";
}

export async function renderFilmcraft(
	directory,
	video,
	edit,
	media,
	binary,
	hasCaptions,
) {
	const project = "draft.fcproj";
	const call = async (args) =>
		jsonOutput((await runTool(binary, args, { cwd: directory })).stdout);
	const command = (id, params) =>
		call(["--project", project, "--save", "exec", id, JSON.stringify(params)]);
	await call([
		"--save-as",
		project,
		"exec",
		"file.newSequence",
		JSON.stringify({
			name: "Demo draft",
			width: media.width,
			height: media.height,
			fps: media.fps,
			video: 2,
			audio: 1,
		}),
	]);
	const inputs = edit.titleCard ? ["graphic.mp4", video] : [video];
	const imported = await call([
		"--project",
		project,
		"--save",
		"import",
		...inputs,
	]);
	if (imported.errors?.length || imported.items?.length !== inputs.length)
		throw new Error(
			`FilmCraft could not import all media: ${JSON.stringify(imported.errors)}`,
		);
	let cursor = 0;
	const place = (item, start, duration, audio) =>
		command("timeline.place", {
			item,
			track: "V1",
			audioTrack: "A1",
			time: ticks(cursor / media.fps),
			sourceIn: ticks(start / media.fps),
			duration: ticks(duration / media.fps),
			insert: false,
			audio,
		});
	if (edit.titleCard) {
		await place(imported.items[0], 0, edit.titleCard.durationFrames, false);
		cursor += edit.titleCard.durationFrames;
	}
	for (const clip of edit.clips) {
		await place(
			imported.items.at(-1),
			clip.inFrame,
			clip.outFrame - clip.inFrame,
			media.hasAudio,
		);
		cursor += clip.outFrame - clip.inFrame;
	}
	if (hasCaptions)
		await command("captions.import", {
			path: "captions.srt",
			name: "Reviewed captions",
		});
	await command("file.exportMedia", {
		path: "demo.mp4",
		format: "h264",
		width: media.width,
		height: media.height,
		fps: media.fps,
		hardwareEncoding: "off",
		burnCaptions: hasCaptions,
		wait: true,
	});
	await runTool(
		binary,
		[
			"--project",
			project,
			"render",
			"--seconds",
			String(Math.min(1, cursor / media.fps / 2)),
			"--out",
			"preview.png",
		],
		{ cwd: directory },
	);
	return project;
}
