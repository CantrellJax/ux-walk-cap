import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('an embedded app and the CLI use the same explicitly isolated preferences', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-ux-config-'));
  try {
    const file = path.join(directory, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ transcriber: 'assemblyai', me: 'Alex', agent: 'copy' }));
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('UXW_')));
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { CONFIG_FILE, loadConfig } from './src/config.mjs';
      assert.equal(CONFIG_FILE, process.env.EXPECTED_CONFIG_FILE);
      const config = loadConfig();
      assert.equal(config.transcriber, 'assemblyai');
      assert.equal(config.me, 'Alex');
      assert.equal(loadConfig({ transcriber: 'none' }).transcriber, 'none');
      console.log('isolated config and command-line precedence verified');
    `], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      env: { ...environment, CAP_UX_WALK_CONFIG_DIR: directory, EXPECTED_CONFIG_FILE: file },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.match(output, /verified/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
