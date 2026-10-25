import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('editing opens the recorder app and preserves the original project', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-ux-editor-'));
  try {
    const project = path.join(directory, 'evidence.cap');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'screen.mp4'), 'evidence master');
    fs.writeFileSync(path.join(project, 'recording-meta.json'), JSON.stringify({ status: { status: 'Complete' }, segments: [{ display: { path: 'screen.mp4' } }] }));
    const tools = path.join(directory, 'tools');
    fs.mkdirSync(tools);
    const argsFile = path.join(directory, 'open-args.json');
    fs.writeFileSync(path.join(tools, 'open'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.FAKE_OPEN_RESULT, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
    const app = path.join(directory, 'Cap-UX Preview.app');
    const output = execFileSync(process.execPath, ['bin/ux-walk', 'cap', 'edit', project], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      env: { ...process.env, PATH: `${tools}:${process.env.PATH}`, UXW_CAP_BINARY: path.join(app, 'Contents/MacOS/cap-cli'), CAP_UX_WALK_CONFIG_DIR: path.join(directory, 'config'), FAKE_OPEN_RESULT: argsFile },
      encoding: 'utf8',
    });
    const edited = JSON.parse(output);
    assert.deepEqual(JSON.parse(fs.readFileSync(argsFile, 'utf8')), ['-a', app, edited.project]);
    assert.notEqual(edited.project, project);
    assert.equal(fs.readFileSync(path.join(project, 'screen.mp4'), 'utf8'), 'evidence master');
    assert.equal(fs.readFileSync(path.join(edited.project, 'screen.mp4'), 'utf8'), 'evidence master');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
