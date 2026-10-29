import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const toleranceS = 0.15;

function mediaPath(project, relative) {
	const file = path.resolve(project, relative);
	if (!file.startsWith(`${path.resolve(project)}${path.sep}`))
		throw new Error("Audio source must stay inside its Cap project");
	return file;
}

export async function prepareNativeAudio(project, directory) {
	const meta = JSON.parse(
		fs.readFileSync(path.join(project, "recording-meta.json"), "utf8"),
	);
	if (!Array.isArray(meta.segments) || !meta.segments.length) return null;
	const configFile = path.join(project, "project-config.json");
	const config = fs.existsSync(configFile)
		? JSON.parse(fs.readFileSync(configFile, "utf8"))
		: {};
	const timeline = config.timeline;
	if (
		config.audio?.mute ||
		(config.audio?.micStereoMode != null &&
			config.audio.micStereoMode !== "stereo") ||
		["transitions", "audioSegments"].some((key) => timeline?.[key]?.length) ||
		timeline?.textSegments?.some(
			(segment) =>
				segment.enabled &&
				segment.layout === "fullscreen" &&
				segment.end > segment.start,
		)
	)
		return null;
	const segments = [];
	for (const [index, segment] of meta.segments.entries()) {
		if (!segment.display?.path) return null;
		const { stdout } = await run("ffprobe", [
			"-v",
			"error",
			"-show_entries",
			"format=duration",
			"-of",
			"json",
			mediaPath(project, segment.display.path),
		]);
		const durationS = Number(JSON.parse(stdout).format?.duration);
		if (!(durationS > 0)) return null;
		const span = timeline?.segments?.[index];
		if (
			timeline &&
			(!span ||
				timeline.segments.length !== meta.segments.length ||
				span.recordingSegment !== index ||
				span.start !== 0 ||
				span.timescale !== 1 ||
				(span.volume ?? 1) !== 1 ||
				span.speedAudioMode != null ||
				!Number.isFinite(span.end) ||
				Math.abs(span.end - durationS) > toleranceS)
		)
			return null;
		const tracks = [
			segment.display,
			segment.camera,
			segment.mic,
			segment.system_audio,
		].filter(Boolean);
		const latest = tracks.every((track) => Number.isFinite(track.start_time))
			? Math.max(...tracks.map((track) => track.start_time))
			: null;
		const clip = config.clips?.find((item) => item.index === index);
		segments.push({
			segment,
			durationS: span?.end ?? durationS,
			offsets: Object.fromEntries(
				["mic", "system_audio"].map((side) => {
					const offset =
						clip?.offsets?.[side] ??
						(latest == null
							? 0
							: latest - (segment[side]?.start_time ?? latest));
					return [side, offset];
				}),
			),
		});
	}
	if (
		segments.some(({ offsets }) =>
			Object.values(offsets).some((offset) => !Number.isFinite(offset)),
		)
	)
		return null;
	const gain = {
		mic: config.audio?.micVolumeDb ?? 0,
		system_audio: config.audio?.systemVolumeDb ?? 0,
	};
	if (Object.values(gain).some((value) => !Number.isFinite(value))) return null;
	const sides = ["mic", "system_audio"].filter(
		(side) =>
			gain[side] > -30 && segments.some(({ segment }) => segment[side]?.path),
	);
	if (!sides.length) return null;
	if (sides.includes("system_audio") && !sides.includes("mic"))
		sides.unshift("mic");
	const output = path.join(directory, "media/source-audio.m4a");
	const durationS = segments.reduce(
		(total, segment) => total + segment.durationS,
		0,
	);
	if (fs.existsSync(output)) return { path: output, durationS };
	if (
		segments.length === 1 &&
		sides.every(
			(side) =>
				gain[side] === 0 &&
				segments[0].offsets[side] === 0 &&
				segments[0].segment[side]?.path,
		)
	) {
		const inputs = sides.map((side) =>
			mediaPath(project, segments[0].segment[side].path),
		);
		const durations = await Promise.all(
			inputs.map(async (file) => {
				const { stdout } = await run("ffprobe", [
					"-v",
					"error",
					"-show_entries",
					"format=duration",
					"-of",
					"json",
					file,
				]);
				return Number(JSON.parse(stdout).format?.duration);
			}),
		);
		if (durations.every((duration) => Math.abs(duration - durationS) <= 0.02)) {
			const temporary = `${output}.${process.pid}.tmp.m4a`;
			try {
				await run("ffmpeg", [
					"-v",
					"error",
					"-nostdin",
					"-y",
					...inputs.flatMap((file) => ["-i", file]),
					...inputs.flatMap((_, index) => ["-map", `${index}:a:0`]),
					"-c:a",
					"copy",
					temporary,
				]);
				fs.renameSync(temporary, output);
			} finally {
				fs.rmSync(temporary, { force: true });
			}
			return { path: output, durationS };
		}
	}
	const args = ["-v", "error", "-nostdin", "-y"];
	const filters = [];
	let input = 0;
	for (const [index, { segment, durationS, offsets }] of segments.entries()) {
		for (const side of sides) {
			const label = `${side}${index}`;
			if (gain[side] > -30 && segment[side]?.path) {
				args.push("-i", mediaPath(project, segment[side].path));
				const offset = offsets[side];
				filters.push(
					`[${input++}:a:0]atrim=start=${Math.max(0, offset)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=mono,volume=${gain[side]}dB,adelay=${Math.max(0, -offset) * 1000},apad,atrim=duration=${durationS}[${label}]`,
				);
			} else
				filters.push(
					`anullsrc=r=48000:cl=mono,atrim=duration=${durationS}[${label}]`,
				);
		}
	}
	for (const side of sides)
		filters.push(
			`${segments.map((_, index) => `[${side}${index}]`).join("")}concat=n=${segments.length}:v=0:a=1[${side}]`,
		);
	args.push("-filter_complex", filters.join(";"));
	for (const side of sides) args.push("-map", `[${side}]`);
	const temporary = `${output}.${process.pid}.tmp.m4a`;
	try {
		args.push("-c:a", "aac", "-b:a", "96k", "-threads", "2", temporary);
		await run("ffmpeg", args);
		fs.renameSync(temporary, output);
	} finally {
		fs.rmSync(temporary, { force: true });
	}
	return { path: output, durationS };
}

export async function clipNativeAudio(input, output, start, duration) {
	await run("ffmpeg", [
		"-v",
		"error",
		"-nostdin",
		"-y",
		"-ss",
		String(start),
		"-i",
		input,
		"-t",
		String(duration),
		"-map",
		"0:a",
		"-vn",
		"-c:a",
		"copy",
		output,
	]);
}
