// Cap stays an independently installed app. These checks observe its bundled CLI;
// only updateCap explicitly invokes Cap's own official installer.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { CapClient } from './cap.mjs';
import { CONFIG_DIR } from './config.mjs';

const exec = promisify(execFile);
const REQUIRED = [
  ['doctor', 'singleJson'], ['targets', 'singleJson'],
  ['record start', 'ndjson', ['started', 'stopped', 'error']],
  ['record stop', 'ndjson', ['stopped', 'error']], ['record status', 'singleJson'],
  ['export', 'ndjson', ['Progress', 'Completed', 'Error']],
  ['screenshot', 'singleJson'], ['project inspect', 'singleJson'],
  ['project validate', 'alwaysJson'], ['automations list', 'singleJson'], ['update', 'singleJson'],
];

/** Read-only installed-contract check. Permission readiness is deliberately separate. */
export async function checkCapCompatibility({ client = new CapClient(), clock = Date.now } = {}) {
  const problems = [], commands = [];
  let doctor = null, guide = null;
  try { doctor = await client.json(['doctor']); }
  catch (e) { problems.push(`doctor: ${e.message}`); }
  try { guide = await client.json(['guide']); }
  catch (e) { problems.push(`guide: ${e.message}`); }
  if (!doctor || typeof doctor !== 'object') problems.push('doctor must return an object');
  if (!guide || typeof guide !== 'object') problems.push('guide must return an object');
  if (doctor && doctor.schemaVersion !== 2) problems.push(`Unsupported doctor schema ${doctor.schemaVersion}; expected 2`);
  if (doctor && typeof doctor.captureReady !== 'boolean') problems.push('doctor.captureReady must be boolean');
  if (guide && guide.schemaVersion !== 3) problems.push(`Unsupported guide schema ${guide.schemaVersion}; expected 3`);
  if (guide && !Array.isArray(guide.commands)) problems.push('guide.commands must be an array');
  for (const [name, outputMode, tags = []] of REQUIRED) {
    const command = Array.isArray(guide?.commands) ? guide.commands.find((c) => c?.command === name) : null;
    const errors = [];
    if (!command) errors.push('missing command');
    else {
      if (command.outputMode !== outputMode) errors.push(`expected ${outputMode} output`);
      if (command.requiresTty !== false) errors.push('requiresTty must be false');
      if (command.requiresDuration !== false) errors.push('requiresDuration must be false');
      if (tags.some((tag) => !Array.isArray(command.eventTags) || !command.eventTags.includes(tag))) errors.push(`expected event tags ${tags.join(', ')}`);
    }
    commands.push({ command: name, supported: errors.length === 0 });
    for (const error of errors) problems.push(`${name}: ${error}`);
  }
  const compatible = problems.length === 0;
  return {
    schemaVersion: 1, operation: 'compatibility', ok: compatible, compatible,
    checkedAt: new Date(clock()).toISOString(), binary: client.binary || null,
    installed: doctor?.version ? {
      cliVersion: doctor.version.version ?? null,
      desktopVersion: doctor.version.bundle?.version ?? null,
      bundlePath: doctor.version.bundle?.path ?? null,
      distribution: doctor.version.distribution ?? null,
    } : null,
    captureReady: typeof doctor?.captureReady === 'boolean' ? doctor.captureReady : null,
    contract: { doctorSchema: doctor?.schemaVersion ?? null, guideSchema: guide?.schemaVersion ?? null, commands },
    capabilities: {
      recording: compatible, detachedAttachment: compatible, screenshots: compatible,
      projectInspection: compatible, export: compatible, explicitUpdate: compatible,
      isolatedWindowVideo: false, // A protocol pass does not clear the known video-isolation defect.
    },
    problems,
  };
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { if (e.code === 'ESRCH') return false; if (e.code === 'EPERM') return true; throw e; }
}

async function nativeCapProcesses() {
  const { stdout } = await exec('ps', ['-axo', 'pid=,comm='], { encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
  return stdout.split('\n').flatMap((line) => {
    const row = line.trim().match(/^(\d+)\s+(.+)$/);
    return row && /(?:^|\/)Cap\.app\/Contents\/MacOS\/Cap$/.test(row[2]) ? [{ pid: Number(row[1]), executable: row[2] }] : [];
  });
}

async function updateBlockers({ client, configDir, isAlive, listNativeProcesses }) {
  const blockers = [];
  try {
    const active = JSON.parse(fs.readFileSync(path.join(configDir, 'active.json'), 'utf8'));
    if (!Number.isInteger(active?.pid) || active.pid <= 0) blockers.push({ kind: 'ux-walk-state', message: 'active.json has no valid recorder PID; cannot establish that updating is safe' });
    else if (await isAlive(active.pid)) blockers.push({ kind: 'ux-walk-recorder', pid: active.pid, message: 'End the live ux-walk session before updating Cap' });
  } catch (e) { if (e.code !== 'ENOENT') blockers.push({ kind: 'ux-walk-state', message: `Cannot verify ux-walk recorder state: ${e.message}` }); }
  try {
    const rows = await client.json(['record', 'status']);
    if (!Array.isArray(rows) || rows.some((r) => !r || typeof r.alive !== 'boolean' || !['recording', 'stopped', 'error'].includes(r.status))) {
      blockers.push({ kind: 'cap-recording-state', message: 'Unsupported Cap session status; cannot establish that updating is safe' });
    } else for (const row of rows) {
      if (row.alive || row.status === 'recording') blockers.push({ kind: 'cap-recording', recordingId: row.recordingId ?? null, pid: row.pid ?? null, message: 'Stop the detached Cap recording before updating' });
    }
  } catch (e) { blockers.push({ kind: 'cap-recording-state', message: `Cannot verify Cap recordings: ${e.message}` }); }
  try {
    const processes = await listNativeProcesses();
    if (!Array.isArray(processes)) throw new Error('Process list is not an array');
    for (const row of processes) blockers.push({ kind: 'cap-desktop', pid: row.pid, message: 'Quit Cap Desktop before updating; ux-walk will not close it for you' });
  } catch (e) { blockers.push({ kind: 'cap-process-state', message: `Cannot verify Cap Desktop processes: ${e.message}` }); }
  return blockers;
}

/** Explicit mutation: delegates to the installed Cap updater, never on start/doctor. */
export async function updateCap({ client = new CapClient(), configDir = CONFIG_DIR,
  isAlive = processAlive, listNativeProcesses = nativeCapProcesses,
  timeout = 10 * 60 * 1000, clock = Date.now } = {}) {
  const before = await checkCapCompatibility({ client, clock });
  const base = { schemaVersion: 1, operation: 'update', before, updateAttempted: false, updated: false };
  const blockers = await updateBlockers({ client, configDir, isAlive, listNativeProcesses });
  if (!before.compatible) blockers.push({ kind: 'cap-contract', message: 'The installed Cap CLI is unsupported; use the official Cap Desktop update route and check compatibility again' });
  if (blockers.length) return { ...base, ok: false, refused: true, blockers };
  // Check again immediately before invoking the installer, after the initial protocol/process probes.
  const finalBlockers = await updateBlockers({ client, configDir, isAlive, listNativeProcesses });
  if (finalBlockers.length) return { ...base, ok: false, refused: true, blockers: finalBlockers };
  let update = null, error = null;
  try {
    update = await client.json(['update'], timeout);
    if (update?.started !== true || update?.completed !== true) throw new Error('Cap did not report a completed update');
  } catch (e) { error = e.message; }
  const after = await checkCapCompatibility({ client, clock });
  return {
    ...base, ok: !error && after.compatible, refused: false, updateAttempted: true,
    updated: error ? null : true, update, after,
    ...(error ? { error, outcome: 'unknown; the installer may have changed files; inspect before retrying' } : {}),
  };
}
