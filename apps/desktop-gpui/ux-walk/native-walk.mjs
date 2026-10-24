import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const local = new URL("./src/cap.mjs", import.meta.url);
const engine = fs.existsSync(local)
	? new URL("./src/", import.meta.url)
	: new URL("../../../vendor/ux-walk/src/", import.meta.url);
const { CapClient, capManifest, checkCapProject, copyCapProject } =
	await import(new URL("cap.mjs", engine));
const { chapterName } = await import(new URL("naming.mjs", engine));
const run = promisify(execFile);

function save(file, value) {
	const temporary = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
		mode: 0o600,
	});
	fs.renameSync(temporary, file);
}

function readJournal(file) {
	const journal = JSON.parse(fs.readFileSync(file, "utf8"));
	if (
		journal.schemaVersion !== 1 ||
		journal.state !== "complete" ||
		!(journal.durationMs > 0) ||
		!Number.isSafeInteger(journal.startedAtMs)
	)
		throw new Error("Native capture must be complete before processing");
	if (
		path.resolve(journal.request.directory) !== path.dirname(path.resolve(file))
	)
		throw new Error("Walk folder does not match its journal");
	let previous = 0;
	for (const event of journal.events) {
		if (
			!["note", "chapter"].includes(event.kind) ||
			typeof event.text !== "string" ||
			!Number.isSafeInteger(event.offsetMs) ||
			event.offsetMs < previous ||
			event.offsetMs > journal.durationMs
		)
			throw new Error("Invalid native walk event or clock");
		previous = event.offsetMs;
	}
	return journal;
}

export function snapshotNativeWalk(file) {
	const journal = readJournal(file);
	const media = path.join(journal.request.directory, "media");
	const source = path.join(media, "source.cap");
	if (fs.existsSync(source)) {
		checkCapProject(source);
		return source;
	}
	checkCapProject(journal.sourceProject);
	if (
		path
			.resolve(media)
			.startsWith(`${path.resolve(journal.sourceProject)}${path.sep}`)
	)
		throw new Error("Walk output must be outside its source project");
	fs.mkdirSync(media, { recursive: true });
	const temporary = path.join(media, `.snapshot-${randomUUID()}.cap`);
	copyCapProject(journal.sourceProject, temporary);
	checkCapProject(temporary);
	fs.renameSync(temporary, source);
	return source;
}

async function clip(input, output, start, duration) {
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
		"0:v:0",
		"-map",
		"0:a?",
		"-c:v",
		"libx264",
		"-threads",
		"2",
		"-preset",
		"veryfast",
		"-crf",
		"23",
		"-c:a",
		"aac",
		output,
	]);
}

export async function finishNativeWalk(file, cfg, dependencies = {}) {
	const journal = readJournal(file);
	const directory = journal.request.directory;
	const lock = path.join(directory, ".processing-lock");
	fs.mkdirSync(lock);
	const progress = (state, error) =>
		save(path.join(directory, "processing.json"), {
			state,
			...(error ? { error } : {}),
		});
	try {
		progress("processing");
		const project = snapshotNativeWalk(file);
		const video = path.join(directory, "media/video.mp4");
		const exportInfo = path.join(directory, "media/export.json");
		const client = dependencies.client ?? new CapClient();
		let info;
		if (fs.existsSync(exportInfo) && fs.existsSync(video))
			info = JSON.parse(fs.readFileSync(exportInfo, "utf8"));
		else {
			info = await client.export(project, video);
			if (!(info.durationS > 0))
				throw new Error("Cap export has no positive duration");
			await capManifest(project, video, info, {
				source: "Cap native elapsed clock; excludes pauses",
				exactFirstFrame: false,
			});
			save(exportInfo, info);
		}
		const durationMs = Math.min(
			journal.durationMs,
			Math.round(info.durationS * 1000),
		);
		const boundaries = [
			{ text: "Walkthrough", offsetMs: 0 },
			...journal.events.filter(
				(event) =>
					event.kind === "chapter" &&
					event.offsetMs > 0 &&
					event.offsetMs < durationMs,
			),
		];
		const unique = boundaries.filter(
			(event, index) =>
				index === boundaries.length - 1 ||
				event.offsetMs !== boundaries[index + 1].offsetMs,
		);
		const { resolveGlossaries } = await import(new URL("glossary.mjs", engine));
		const glossaries = resolveGlossaries(cfg.glossary || "");
		const session = {
			topic: journal.request.topic,
			url: journal.request.url,
			kind: "native-cap",
			dir: directory,
			startedAt: new Date(journal.startedAtMs).toISOString(),
			speakers: journal.request.speakers,
			glossaries,
			chapters: [],
			coverage: {
				window:
					"Cap native capture; notes use elapsed time, first-frame alignment is approximate",
				dom: "not captured",
				network: "not captured",
				console: "not captured",
			},
		};
		const actions = journal.events
			.filter((event) => event.kind === "note")
			.map((event, index) => ({
				ev: "note",
				id: index + 1,
				mode: "walk",
				t: journal.startedAtMs + event.offsetMs,
				text: event.text,
			}));
		fs.writeFileSync(
			path.join(directory, "actions.jsonl"),
			actions.map((event) => JSON.stringify(event)).join("\n") +
				(actions.length ? "\n" : ""),
			{ mode: 0o600 },
		);
		const processing = await import(new URL("process.mjs", engine));
		const { writeReport } = await import(new URL("report.mjs", engine));
		for (const [index, boundary] of unique.entries()) {
			const end = unique[index + 1]?.offsetMs ?? durationMs;
			const name = chapterName(index + 1, boundary.text);
			const chapterDir = path.join(directory, name);
			fs.mkdirSync(chapterDir, { recursive: true });
			const row = {
				n: index + 1,
				name: boundary.text,
				dir: name,
				startMs: journal.startedAtMs + boundary.offsetMs,
				endMs: journal.startedAtMs + end,
				status: "processing",
			};
			session.chapters.push(row);
			save(path.join(directory, "session.json"), session);
			save(path.join(chapterDir, "chapter.json"), {
				...row,
				topic: session.topic,
				url: session.url,
				kind: session.kind,
				speakers: session.speakers,
				glossaries,
				actions: "../actions.jsonl",
				sourceProject: "../media/source.cap",
				sourceRange: { startS: boundary.offsetMs / 1000, endS: end / 1000 },
			});
			const output = path.join(chapterDir, "video.mp4");
			if (!fs.existsSync(output)) {
				const temporary = path.join(chapterDir, "video.tmp.mp4");
				await (dependencies.clip ?? clip)(
					video,
					temporary,
					boundary.offsetMs / 1000,
					(end - boundary.offsetMs) / 1000,
				);
				fs.renameSync(temporary, output);
			}
			try {
				const summary = await (
					dependencies.processChapter ?? processing.processChapter
				)(chapterDir, cfg, { brief: cfg.brief === true, log: () => {} });
				row.status = summary?.transcriptError ? "no transcript" : "ready";
			} catch (error) {
				row.status = "failed";
				save(path.join(directory, "session.json"), session);
				throw error;
			}
			save(path.join(directory, "session.json"), session);
		}
		(dependencies.writeIndex ?? processing.writeIndex)(directory);
		(dependencies.writeReport ?? writeReport)(directory);
		progress("ready");
		return directory;
	} catch (error) {
		progress("failed", error.message);
		throw error;
	} finally {
		fs.rmdirSync(lock);
	}
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const [command, file] = process.argv.slice(2);
	try {
		if (command === "snapshot") snapshotNativeWalk(file);
		else if (command === "process") {
			const { loadConfig } = await import(new URL("config.mjs", engine));
			await finishNativeWalk(file, loadConfig());
		} else
			throw new Error(
				"Usage: native-walk.mjs snapshot|process <native-walk.json>",
			);
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
