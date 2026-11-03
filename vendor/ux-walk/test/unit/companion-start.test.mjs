import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
	CompanionSession,
	startCompanionServer,
} from "../../src/companion.mjs";

test(
	"rejected recording startup preserves the current active pointer and never reaches capture",
	{ timeout: 10000 },
	async (t) => {
		const root = fs.mkdtempSync("/tmp/uxw-start-owner-"),
			configDir = path.join(root, "config"),
			outDir = path.join(root, "recordings");
		fs.mkdirSync(configDir);
		fs.mkdirSync(outDir);
		t.after(() => fs.rmSync(root, { recursive: true, force: true }));
		const startedAt = new Date().toISOString(),
			original = {
				pid: process.pid,
				startedAt,
				dir: path.join(root, "original"),
			};
		const owner = await startCompanionServer({
			configDir,
			session: new CompanionSession({
				recordingId: `${process.pid}:${startedAt}`,
				generation: "original",
				backend: "standalone",
				state: () => "recording",
				write: async () => true,
				flush: async () => {},
			}),
		});
		t.after(() => owner.close());
		fs.writeFileSync(
			path.join(configDir, "active.json"),
			JSON.stringify(original),
		);
		const loader = path.join(root, "loader.mjs"),
			stub =
				'export const HELPER=""; export class WindowCapture {async start(){throw Error("CAPTURE_FORBIDDEN")}} export class ScreenCapture extends WindowCapture {} export function createCaptureHealth(){return {event:()=>false}}';
		fs.writeFileSync(
			loader,
			`export async function resolve(specifier,context,next){if(context.parentURL.endsWith('/src/record.mjs')){if(specifier==='./capture.mjs')return {url:${JSON.stringify(`data:text/javascript,${encodeURIComponent(stub)}`)},shortCircuit:true};if(specifier==='./browser.mjs')return {url:'data:text/javascript,export async function openBrowser(){throw Error("BROWSER_FORBIDDEN")}',shortCircuit:true};}return next(specifier,context);}`,
		);
		const source = `import fs from 'node:fs';import {record} from ${JSON.stringify(new URL("../../src/record.mjs", import.meta.url).href)};let error;try{await record({capture:'window',outDir:${JSON.stringify(outDir)},evidenceOnly:true,me:'Synthetic',askSpeakers:false,glossary:'',transcriber:'none'},{topic:'Rejected',url:'https://example.invalid/',windowId:55,noBrowser:true,ipc:false});}catch(caught){error=caught.message;}let active;try{active=JSON.parse(fs.readFileSync(${JSON.stringify(path.join(configDir, "active.json"))}));}catch{}console.log('RESULT '+JSON.stringify({error,active,entries:fs.readdirSync(${JSON.stringify(outDir)})}));process.exit(0);`;
		const child = spawn(
			process.execPath,
			[
				"--no-warnings",
				"--experimental-loader",
				loader,
				"--input-type=module",
				"-e",
				source,
			],
			{
				env: { ...process.env, CAP_UX_WALK_CONFIG_DIR: configDir },
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let output = "",
			errors = "";
		child.stdout.on("data", (data) => {
			output += data;
		});
		child.stderr.on("data", (data) => {
			errors += data;
		});
		const code = await new Promise((resolve) => child.once("close", resolve));
		assert.equal(code, 0, errors);
		const result = JSON.parse(
			output
				.split("\n")
				.find((line) => line.startsWith("RESULT "))
				.slice(7),
		);
		assert.deepEqual(result.active, original);
		assert.deepEqual(result.entries, []);
		assert.match(result.error, /owner|active|recording/i);
		assert.doesNotMatch(result.error, /CAPTURE_FORBIDDEN/);
	},
);
