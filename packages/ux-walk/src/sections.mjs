// Sections: where a long chapter changes topic, so an agent can read one part at a time and a person
// can jump to it in the video. Like YouTube's automatic chapters, but with better signals than a
// video has: page changes, the main heading changing and markers mark where the SCREEN changed
// (screenSections); a short Claude pass over the timeline finds where the CONVERSATION moved on,
// which can happen on one page (Studio was one URL for 38 minutes). Nothing is cut: the video stays
// whole and the timelines get "## mm:ss title" headers.
import fs from 'node:fs';
import path from 'node:path';
import { runClaude } from './brief.mjs';
import { clock } from './timeline.mjs';

const PROMPT = `Below is the timeline of one recorded walkthrough of a web app: speech (SAY), page changes
(NAV), the main heading changing (VIEW), notes the speaker pinned on the page (NOTE), messages the app
showed (NOTICE), clicks and errors, with times from the start. Split it into sections where the topic or the task changes, the way a video
gets chapters.

Rules:
- Between 3 and 12 sections. Each at least 2 minutes long unless the topic clearly changes sooner.
- The first section starts at 00:00.
- Prefer a start time on a NAV, VIEW or MARK line, or where someone says they are moving on.
- Each title is 2 to 6 plain words saying what happens in that section, in the speakers' terms
  ("Setting up classes", "Generate times out"). No numbering, no quotes.
- Reply with JSON only, no prose: [{"at": "mm:ss", "title": "..."}]

Screen changes already detected: {CANDIDATES}

Timeline:
`;

const secs = (mmss) => { const [m, s] = String(mmss).split(':').map(Number); return m * 60 + s; };

export async function topicSections(dir, shortText, screen, cfg, durationS) {
  const file = path.join(dir, 'sections.json');
  if (fs.existsSync(file)) {
    try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(j.sections)) return j.sections; } catch {}
  }
  const candidates = screen.map((s) => `${clock(s.t)} ${s.title}`).join('; ') || 'none';
  // The timeline-short body is enough; trim very long ones from the middle of each SAY line.
  const body = shortText.split('\n').filter((l) => /^\d\d:\d\d  /.test(l)).map((l) => l.replace(/\s+\(shots\/[^)]+\)/, '').slice(0, 220)).join('\n');
  const out = await runClaude(PROMPT.replace('{CANDIDATES}', candidates) + body, { cwd: dir, model: cfg.sectionsModel || 'haiku' });
  const json = out.slice(out.indexOf('['), out.lastIndexOf(']') + 1);
  let list = JSON.parse(json).map((x) => ({ t: secs(x.at), title: String(x.title || '').trim().slice(0, 60) }))
    .filter((x) => Number.isFinite(x.t) && x.title && x.t < durationS).sort((a, b) => a.t - b.t);
  if (!list.length) throw new Error('no sections in the reply');
  list[0].t = 0;
  list = list.filter((x, i) => i === 0 || x.t - list[i - 1].t >= 20);
  fs.writeFileSync(file, JSON.stringify({ source: 'claude', model: cfg.sectionsModel || 'haiku', sections: list }, null, 2));
  return list;
}
