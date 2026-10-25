// Descript transcription: upload the audio to a private project, wait, export SRT with speaker labels.
// Token: env DESCRIPT_API_TOKEN, else the macOS Keychain item named in config (descriptKeychainItem).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const API = 'https://descriptapi.com/v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function descriptToken(item) {
  if (process.env.DESCRIPT_API_TOKEN) return process.env.DESCRIPT_API_TOKEN;
  try {
    return execFileSync('security', ['find-generic-password', '-a', process.env.USER, '-s', item, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    throw new Error(`no Descript token: run "ux-walk setup" (Keychain item "${item}") or set DESCRIPT_API_TOKEN`);
  }
}

async function call(token, method, url, body) {
  const r = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`Descript ${method} ${url.replace(API, '')} -> ${r.status}: ${text.slice(0, 300)}`);
  return text;
}

// Writes transcript.srt next to the audio. Reuses the project if descript-project-id exists.
export async function transcribe(audio, { token, projectName, log = console.log }) {
  const dir = path.dirname(audio), name = path.basename(audio);
  const idFile = path.join(dir, 'descript-project-id');
  let project = fs.existsSync(idFile) ? fs.readFileSync(idFile, 'utf8').trim() : null;
  if (!project) {
    const size = fs.statSync(audio).size;
    const ct = name.endsWith('.m4a') ? 'audio/mp4' : name.endsWith('.wav') ? 'audio/wav' : 'video/mp4';
    const res = JSON.parse(await call(token, 'POST', `${API}/jobs/import/project_media`, {
      project_name: projectName, team_access: 'none',
      add_media: { [name]: { content_type: ct, file_size: size, language: 'en' } },
      add_compositions: [{ name: 'walkthrough', clips: [{ media: name }] }],
    }));
    project = res.project_id;
    fs.writeFileSync(idFile, project);
    const upload = Object.values(res.upload_urls)[0].upload_url;
    const put = await fetch(upload, { method: 'PUT', headers: { 'Content-Type': ct, 'Content-Length': String(size) }, body: fs.createReadStream(audio), duplex: 'half' });
    if (!put.ok) throw new Error(`upload failed: ${put.status}`);
    log(`uploaded to Descript; job ${res.job_id}`);
    for (let i = 0; i < 240; i++) {
      const st = JSON.parse(await call(token, 'GET', `${API}/jobs/${res.job_id}`));
      const state = `${st.job_state} ${st.result?.status || ''}`.trim();
      if (state === 'stopped success' || state === 'stopped partial') break;
      if (/^(stopped|cancelled)/.test(state)) throw new Error(`Descript import failed: ${JSON.stringify(st).slice(0, 300)}`);
      await sleep(5000);
    }
  }
  // Transcription can trail the import job; retry the export until it has text.
  for (let i = 0; i < 120; i++) {
    const srt = await call(token, 'POST', `${API}/export/transcript`, { project_id: project, format: 'srt', include_speaker_labels: 'every_paragraph' }).catch(() => '');
    if (srt.includes('-->')) {
      fs.writeFileSync(path.join(dir, 'transcript.srt'), srt);
      return path.join(dir, 'transcript.srt');
    }
    await sleep(5000);
  }
  throw new Error(`transcript not ready; Descript project ${project}. Rerun later: ux-walk process ${dir}`);
}
