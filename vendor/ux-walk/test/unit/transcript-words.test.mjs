import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as transcription from '../../src/transcribe.mjs';

test('live word requests accept successful silence and do not retry ambiguous submissions', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ux-walk-word-job-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const audio = path.join(dir, 'synthetic.m4a');
  fs.writeFileSync(audio, 'synthetic mocked request body');
  const old = process.env.ELEVENLABS_API_KEY;
  process.env.ELEVENLABS_API_KEY = 'synthetic-test-key';
  t.after(() => { if (old === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = old; });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(JSON.stringify({ words: [] })); });
  assert.deepEqual(await transcription.transcribeWords(audio, { transcriber: 'elevenlabs' }, { log: () => {} }), []);
  assert.equal(calls, 1);
  globalThis.fetch = async () => { calls++; throw new Error('Ambiguous dropped response'); };
  await assert.rejects(transcription.transcribeWords(audio, { transcriber: 'elevenlabs' }, { log: () => {} }), /Ambiguous/);
  assert.equal(calls, 2);
  assert.equal(fs.existsSync(path.join(dir, 'transcript.srt')), false);
});

test('disabled provider makes no request and unsupported word providers are explicit', async (t) => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected network'); });
  assert.deepEqual(await transcription.transcribeWords('unused', { transcriber: 'none' }), []);
  await assert.rejects(transcription.transcribeWords('unused', { transcriber: 'descript' }), /word|supported/);
});

test('live requests carry real cancellation to the provider fetch', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ux-walk-cancel-job-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const audio = path.join(dir, 'synthetic.m4a');
  fs.writeFileSync(audio, 'synthetic mocked request body');
  const old = process.env.ELEVENLABS_API_KEY;
  process.env.ELEVENLABS_API_KEY = 'synthetic-test-key';
  t.after(() => { if (old === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = old; });
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.signal, controller.signal);
    return new Promise((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      controller.abort(new Error('Synthetic cancelled request'));
    });
  });
  await assert.rejects(transcription.transcribeWords(audio, { transcriber: 'elevenlabs' }, { signal: controller.signal, log: () => {} }), /Synthetic cancelled/);
});
