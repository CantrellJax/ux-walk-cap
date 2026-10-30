import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";

test(
	"stale owner recovery cannot unlink another process's newly acquired ownership",
	{ timeout: 15000 },
	async (t) => {
		const root = fs.mkdtempSync("/tmp/uxw-stale-owner-");
		t.after(() => fs.rmSync(root, { recursive: true, force: true }));
		fs.writeFileSync(
			path.join(root, "companion-owner.json"),
			JSON.stringify({
				pid: 2147483647,
				recorderPid: 2147483647,
				token: "old",
			}),
		);
		const childSource = `
import fs from 'node:fs'; import path from 'node:path';
import {CompanionSession,startCompanionServer} from ${JSON.stringify(new URL("../../src/companion.mjs", import.meta.url).href)};
const [root,id]=process.argv.slice(1),read=fs.readFileSync;let blocked=false;
fs.readFileSync=function(file,...args){const result=read.call(fs,file,...args);if(!blocked&&path.resolve(String(file))===path.join(root,'companion-owner.json')){blocked=true;fs.writeSync(1,'READ\\n');while(!fs.existsSync(path.join(root,id+'.release')))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);}return result;};
try {const owner=await startCompanionServer({configDir:root,session:new CompanionSession({recordingId:id,generation:id,backend:'cap',state:()=> 'recording',write:async()=>true,flush:async()=>{}})});fs.writeSync(1,'LIVE\\n');process.stdin.resume();await new Promise(resolve=>process.stdin.once('end',resolve));await owner.close();}catch(error){fs.writeSync(1,'FAILED '+error.message+'\\n');}
`;
		const launch = (id) => {
			const child = spawn(
				process.execPath,
				["--input-type=module", "-e", childSource, root, id],
				{ stdio: ["pipe", "pipe", "pipe"] },
			);
			let firstResolve, outcomeResolve;
			const first = new Promise((resolve) => {
					firstResolve = resolve;
				}),
				outcome = new Promise((resolve) => {
					outcomeResolve = resolve;
				});
			readline.createInterface({ input: child.stdout }).on("line", (line) => {
				firstResolve(line);
				if (line !== "READ") outcomeResolve(line);
			});
			child.on("exit", (code) => {
				if (code) {
					firstResolve(`FAILED exit ${code}`);
					outcomeResolve(`FAILED exit ${code}`);
				}
			});
			t.after(() => {
				child.stdin.end();
				child.kill();
			});
			return { child, id, first, outcome };
		};
		const a = launch("a"),
			b = launch("b"),
			first = await Promise.all([a.first, b.first]);
		if (first.every((line) => line === "READ")) {
			fs.writeFileSync(path.join(root, "a.release"), "");
			await a.outcome;
			fs.writeFileSync(path.join(root, "b.release"), "");
		} else
			for (const child of [a, b])
				fs.writeFileSync(path.join(root, `${child.id}.release`), "");
		const results = await Promise.all([a.outcome, b.outcome]);
		assert.equal(
			results.filter((line) => line === "LIVE").length,
			1,
			results.join("; "),
		);
	},
);
