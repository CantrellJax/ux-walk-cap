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

const escapeHTML = (value) =>
	String(value ?? "").replace(
		/[&<>"']/g,
		(character) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				character
			],
	);

function writeNativeReport(directory, session, journal) {
	const report = path.join(directory, "report.html");
	if (fs.existsSync(report))
		fs.renameSync(report, path.join(directory, "evidence.html"));
	const clock = (milliseconds) =>
		`${Math.floor(milliseconds / 60000)}:${String(Math.floor(milliseconds / 1000) % 60).padStart(2, "0")}`;
	const link = (chapter, file, title) =>
		fs.existsSync(path.join(directory, chapter.dir, file))
			? `<a href="${encodeURIComponent(chapter.dir)}/${file}">${title}</a>`
			: "";
	const chapters = session.chapters
		.map(
			(chapter) =>
				`<section><h2>${escapeHTML(chapter.name)}</h2><p>${clock(chapter.startMs - journal.startedAtMs)}–${clock(chapter.endMs - journal.startedAtMs)} · ${escapeHTML(chapter.status)}</p><video controls preload="metadata" src="${encodeURIComponent(chapter.dir)}/video.mp4"></video><p>${[link(chapter, "timeline-short.md", "Timeline"), link(chapter, "transcript.srt", "Transcript"), link(chapter, "brief.md", "Brief")].filter(Boolean).join(" · ")}</p></section>`,
		)
		.join("");
	const notes = journal.events
		.filter((event) => event.kind === "note")
		.map(
			(event) =>
				`<li><time>${clock(event.offsetMs)}</time> ${escapeHTML(event.text)}</li>`,
		)
		.join("");
	fs.writeFileSync(
		report,
		`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHTML(session.topic)} · Cap UX</title><style>body{font:16px system-ui;color:#20242c;background:#fafaf9;max-width:960px;margin:48px auto;padding:0 24px;line-height:1.6}h1{font-size:32px;line-height:1.2}h2{margin-top:40px}video{width:100%;border-radius:12px;background:#15171c}a{color:#2467d5}time{color:#666;font-variant-numeric:tabular-nums;margin-right:12px}li{margin:12px 0}.meta{color:#666;font-size:14px}</style><p class="meta">Cap UX · UX Walk</p><h1>${escapeHTML(session.topic)}</h1><p class="meta">${escapeHTML(session.startedAt)}${session.url ? ` · ${escapeHTML(session.url)}` : ""}</p><h2>Notes</h2>${notes ? `<ul>${notes}</ul>` : "<p>No notes added.</p>"}${chapters}<h2>Capture details</h2><p class="meta">Recorded with Cap UX. Notes and chapters use the recorder’s elapsed time, excluding pauses; first-frame alignment is approximate. DOM, network and console events were not captured.</p><p><a href="media/video.mp4">Full recording</a> · <a href="native-walk.json">Saved journal</a> · <a href="session.json">Session</a></p></html>`,
		{ mode: 0o600 },
	);
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
			const temporary = path.join(
				directory,
				`media/export-${randomUUID()}.mp4`,
			);
			info = await client.export(project, temporary);
			fs.renameSync(temporary, video);
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
		writeNativeReport(directory, session, journal);
		progress("ready");
		return directory;
	} catch (error) {
		progress("failed", error.message);
		throw error;
	} finally {
		fs.rmdirSync(lock);
	}
}

export async function handoffNativeWalk(file, cfg) {
	const journal = readJournal(file);
	const directory = journal.request.directory;
	if (!fs.existsSync(path.join(directory, "report.html")))
		throw new Error("Prepare the walk report before opening an agent");
	const prompt = `Review this UX Walk: ${directory}. Read report.html and the chapter timelines, inspect the referenced screenshots and transcript, and propose concrete fixes. This is native screen capture with manual notes; DOM, network and console were not captured.`;
	fs.writeFileSync(path.join(directory, "agent-prompt.txt"), `${prompt}\n`, {
		mode: 0o600,
	});
	const { expand } = await import(new URL("config.mjs", engine));
	const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
	const installed = "/Applications/cmux.app/Contents/Resources/bin/cmux";
	const binary =
		process.env.UXW_CMUX || (fs.existsSync(installed) ? installed : "cmux");
	await run(
		binary,
		[
			"new-workspace",
			"--name",
			`walk: ${journal.request.topic}`.slice(0, 60),
			"--cwd",
			expand(String(cfg.sourceRoot || "~")),
			"--command",
			`claude --model ${quote(cfg.agentModel || "opus")} ${quote(prompt)}`,
			"--focus",
			"true",
		],
		{ encoding: "utf8", timeout: 15000 },
	);
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
		} else if (command === "prepare-edit") {
			const { prepareCapEdit } = await import(new URL("cap.mjs", engine));
			console.log(JSON.stringify(prepareCapEdit(snapshotNativeWalk(file))));
		} else if (command === "handoff") {
			const { loadConfig } = await import(new URL("config.mjs", engine));
			await handoffNativeWalk(file, loadConfig());
		} else
			throw new Error(
				"Usage: native-walk.mjs snapshot|process|handoff <native-walk.json>",
			);
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
