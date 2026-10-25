import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

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

test('embedded assets resolve from an app path containing spaces', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'Cap UX # assets '));
  try {
    fs.mkdirSync(path.join(directory, 'src'));
    fs.copyFileSync(new URL('../../src/config.mjs', import.meta.url), path.join(directory, 'src/config.mjs'));
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      const { ROOT } = await import(process.env.TEST_CONFIG_URL);
      console.log(ROOT);
    `], {
      env: { ...process.env, TEST_CONFIG_URL: pathToFileURL(path.join(directory, 'src/config.mjs')).href },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    assert.equal(output, fs.realpathSync(directory));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
