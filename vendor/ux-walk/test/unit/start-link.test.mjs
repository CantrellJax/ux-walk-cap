import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('app links select setup only and reject command, path and device injection', { skip: process.platform !== 'darwin' }, () => {
  const source = fs.readFileSync(new URL('../../swift/uxw-menubar.swift', import.meta.url), 'utf8');
  const begin = source.indexOf('// MARK: - Fixed URL handoff');
  const end = source.indexOf('// MARK: - The menu bar app', begin);
  assert.ok(begin >= 0 && end > begin, 'compile the actual pure route helper from the app');
  const cases = [
    ['ux-walk://start', 'instructions'], ['ux-walk://start?capture=cap', 'cap'],
    ['UX-WALK://START?capture=cap', 'cap'],
    ...['https://start?capture=cap', 'ux-walk://record?capture=cap', 'ux-walk://start/',
      'ux-walk://start?capture=cap&cmd=record', 'ux-walk://start?capture=cap&path=/tmp/recording',
      'ux-walk://start?camera=device', 'ux-walk://start?capture=cap&capture=cap',
      'ux-walk://start?capture=cap&screen-id=1', 'ux-walk://start?%63apture=cap',
      'ux-walk://start?capture=%63ap', 'ux-walk://user@start?capture=cap',
      'ux-walk://start:123?capture=cap', 'ux-walk://start#', 'ux-walk://start?',
      'ux-walk://%73tart?capture=cap', 'ux-walk:///start?capture=cap',
      'ux-walk://start?capture=cap%0A--upload'].map((url) => [url, null]),
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uxw-link-'));
  try {
    const file = path.join(dir, 'routes.swift');
    const checks = cases.map(([url, route]) => `precondition(walkStartRoute(URL(string: ${JSON.stringify(url)})!) == ${route ? `.${route}` : 'nil'}, ${JSON.stringify(url)})`).join('\n');
    fs.writeFileSync(file, `import Foundation\n${source.slice(begin, end)}\n${checks}\nprint("route contract passed")\n`);
    assert.match(execFileSync('swift', [file], { encoding: 'utf8', timeout: 30000 }), /route contract passed/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
