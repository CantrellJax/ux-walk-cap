import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { durableJson, sha256 } from "./checkpoint-store.mjs";
import { reuseCheckpointTranscript } from "./checkpoint-transcript.mjs";

test("final transcript reuses source-qualified jobs with display spans, offsets and partial coverage", async (t) => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), "uxw-cache-")); t.after(() => fs.rmSync(root, {recursive:true,force:true}));
 fs.mkdirSync(path.join(root,"checkpoints/jobs"),{recursive:true});
 durableJson(path.join(root,"checkpoints/final-layout.json"),{displaySpans:[10,8],meta:{segments:[{display:{start_time:0},mic:{start_time:0}},{display:{start_time:1},mic:{start_time:0}}]},config:{clips:[{index:1,offsets:{mic:1}}]}});
 const result={source:"segment-1:microphone",sourceStartMs:0,sourceEndMs:4000,words:[{start:1.5,end:2,text:"retained",speaker:"chunk-local-0"}]};
 const id="a".repeat(64); const resultFile=path.join(root,`checkpoints/jobs/${id}.words.json`);durableJson(resultFile,result);
 durableJson(path.join(root,`checkpoints/jobs/${id}.json`),{jobId:id,source:result.source,sourceStartMs:0,sourceEndMs:4000,state:"complete",resultHash:sha256(fs.readFileSync(resultFile))});
 const rows=[{dir:"chapter",startMs:9000,endMs:13000}];fs.mkdirSync(path.join(root,"chapter"));
 const reused=await reuseCheckpointTranscript(root,rows,0);
 assert.equal(reused.handled,true);assert.match(reused.results.get("chapter").transcriptError,/partial/i);
 const srt=fs.readFileSync(path.join(root,"chapter/transcript.srt"),"utf8");assert.match(srt,/00:00:01,500 --> 00:00:02,000/);assert.match(srt,/retained/);
 assert.equal(JSON.parse(fs.readFileSync(resultFile)).words[0].start,1.5);
});
