#!/usr/bin/env node
/**
 * daily-agent.mjs — unattended daily run around career-ops.
 *
 *   1. scan       node scan.mjs                         (zero tokens; finds new postings)
 *   2. triage     one small `claude -p` call            (title/location first glance)
 *   3. evaluate   batch/batch-runner.sh --mode full     (full A-G report + tailored CV PDF)
 *   4. cover      one `claude -p` per strong match      (cover letter PDF via generate-cover-letter.mjs)
 *   5. log        rebuild job-log.xlsx                  (all applications + run history)
 *   6. notify     WhatsApp summary                      (CallMeBot or Twilio)
 *
 * It never submits an application or contacts an employer. You review the
 * shortlist, CVs and letters, then apply yourself.
 *
 * Usage:
 *   node daily-agent.mjs                 full run
 *   node daily-agent.mjs --dry-run       scan + triage + spreadsheet + message, no evaluation/cover letters
 *   node daily-agent.mjs --skip-scan     reuse what is already in data/pipeline.md
 *   node daily-agent.mjs --excel-only    only rebuild the spreadsheet
 *   node daily-agent.mjs --test-whatsapp send a test message and exit
 */

import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, unlinkSync, statSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { writeXlsx, scoreCell, STYLE } from './lib/xlsx.mjs';
import { sendWhatsApp } from './lib/whatsapp.mjs';
import {
  readText, normUrl, pendingEntries, parseTracker, parseBatchState, parseBatchInput,
  findReportFile, reportFacts, slugify,
} from './lib/careerops-data.mjs';

const AUTO_DIR = dirname(fileURLToPath(import.meta.url));
const ARGS = new Set(process.argv.slice(2));
const IS_WIN = process.platform === 'win32';

// ---------------------------------------------------------------- config ---
function loadEnvFile(p) {
  const env = {};
  for (const line of readText(p).split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}
const ENV = { ...loadEnvFile(join(AUTO_DIR, '.env')), ...process.env };
const CFG = {
  repo: resolve(ENV.CAREER_OPS_DIR || join(AUTO_DIR, '..', 'career-ops')),
  maxEvals: Math.max(0, parseInt(ENV.MAX_EVALS_PER_RUN || '8', 10)),
  minScore: parseFloat(ENV.MIN_SCORE || '4.0'),
  parallel: Math.max(1, parseInt(ENV.BATCH_PARALLEL || '2', 10)),
  batchMode: ENV.BATCH_MODE === 'match' ? 'match' : 'full',
  coverLetters: !/^(0|false|no|off)$/i.test(ENV.COVER_LETTERS || 'true'),
  coverTone: ENV.COVER_TONE || 'Direct: plain sentences, gets to the point, professional',
  maxTriage: parseInt(ENV.MAX_TRIAGE_POSTINGS || '250', 10),
  claudeModel: ENV.CLAUDE_MODEL || '',
  excelPath: resolve(ENV.EXCEL_PATH || join(AUTO_DIR, 'job-log.xlsx')),
  tz: ENV.TIMEZONE || 'America/New_York',
  gitBash: ENV.GIT_BASH || '',
};

const STATE_DIR = join(AUTO_DIR, 'state');
const LOG_DIR = join(AUTO_DIR, 'logs');
const TMP_DIR = join(AUTO_DIR, 'tmp');
for (const d of [STATE_DIR, LOG_DIR, TMP_DIR]) mkdirSync(d, { recursive: true });

const started = new Date();
const dateStr = (d = started) => new Intl.DateTimeFormat('en-CA', { timeZone: CFG.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const TODAY = dateStr();
const HHMM = new Intl.DateTimeFormat('en-GB', { timeZone: CFG.tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(started).replace(':', '');
const LOG_FILE = join(LOG_DIR, `${TODAY}_${HHMM}.log`);

function log(...parts) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${parts.join(' ')}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + '\n');
}

// ------------------------------------------------------------ data root ---
let DATA = CFG.repo;
try {
  const pr = await import(pathToFileURL(join(CFG.repo, 'path-resolver.mjs')).href);
  DATA = pr.getCareerOpsRoot();
} catch { /* default layout: data lives in the checkout */ }
const P = {
  pipeline: join(DATA, 'data', 'pipeline.md'),
  tracker: existsSync(join(DATA, 'data', 'applications.md')) ? join(DATA, 'data', 'applications.md') : join(DATA, 'applications.md'),
  reports: join(DATA, 'reports'),
  output: join(DATA, 'output'),
  cv: join(DATA, 'cv.md'),
  profile: join(DATA, 'config', 'profile.yml'),
  brief: join(DATA, 'modes', '_brief.md'),
  profileMd: join(DATA, 'modes', '_profile.md'),
  digest: join(DATA, 'article-digest.md'),
  voice: join(DATA, 'voice-dna.md'),
  batchInput: join(CFG.repo, 'batch', 'batch-input.tsv'),
  batchState: join(CFG.repo, 'batch', 'batch-state.tsv'),
  triaged: join(STATE_DIR, 'triaged.json'),
  runs: join(STATE_DIR, 'runs.json'),
  lock: join(STATE_DIR, 'run.lock'),
};

const readJson = (p, fallback) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } };
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2));

// --------------------------------------------------------------- process ---
function run(cmd, args, { cwd = CFG.repo, input, timeoutMin = 30, label = cmd, shell = false } = {}) {
  log(`$ ${label}`);
  const t0 = Date.now();
  const res = spawnSync(cmd, args, {
    cwd, input, shell, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
    timeout: timeoutMin * 60 * 1000, windowsHide: true,
    env: { ...process.env, CAREER_OPS_HEADLESS: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  const secs = Math.round((Date.now() - t0) / 1000);
  appendFileSync(LOG_FILE, `--- stdout (${label}) ---\n${res.stdout || ''}\n--- stderr ---\n${res.stderr || ''}\n`);
  if (res.error) log(`  ! ${label} failed to start/finished abnormally: ${res.error.message}`);
  log(`  exit=${res.status} in ${secs}s`);
  return res;
}

let launchClaudeImpl = null;
async function claude(prompt, label, timeoutMin = 15) {
  const args = ['-p', '--output-format', 'text', '--permission-mode', 'dontAsk', '--strict-mcp-config'];
  if (CFG.claudeModel) args.push('--model', CFG.claudeModel);
  args.push('--disallowedTools', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task');
  // Prompt goes over stdin: no length limit, and nothing from a job posting ever
  // reaches a command line. cwd is the automation folder, which sits OUTSIDE the
  // career-ops checkout, so Claude doesn't load the 100k-char AGENTS.md here.
  if (launchClaudeImpl === null) {
    try {
      const m = await import(pathToFileURL(join(CFG.repo, 'lib', 'agent-launch.mjs')).href);
      launchClaudeImpl = m.resolveCliLaunch;
    } catch { launchClaudeImpl = false; }
  }
  let res;
  if (launchClaudeImpl) {
    try {
      const l = launchClaudeImpl('claude', args);
      res = run(l.command, l.args, { cwd: AUTO_DIR, input: prompt, timeoutMin, label });
    } catch (err) { log(`  resolveCliLaunch failed: ${err.message}`); }
  }
  if (!res || res.error) res = run('claude', args, { cwd: AUTO_DIR, input: prompt, timeoutMin, label: `${label} (shell)`, shell: IS_WIN });
  if (res.status !== 0) throw new Error(`${label}: claude exited ${res.status}: ${(res.stderr || res.stdout || '').trim().slice(0, 300)}`);
  return res.stdout || '';
}

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in model output');
  return JSON.parse(text.slice(start, end + 1));
}

function fill(template, vars) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, k) => (vars[k] ?? ''));
}

function findGitBash() {
  if (!IS_WIN) return 'bash';
  const cands = [
    CFG.gitBash,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    join(process.env.USERPROFILE || '', 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'),
    join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ].filter(Boolean);
  return cands.find((c) => existsSync(c)) || '';
}

// ------------------------------------------------------------------ lock ---
function acquireLock() {
  if (existsSync(P.lock)) {
    const age = Date.now() - statSync(P.lock).mtimeMs;
    if (age < 6 * 3600 * 1000) throw new Error(`another run is in progress (lock ${P.lock}, ${Math.round(age / 60000)} min old)`);
    log('removing stale lock');
  }
  writeFileSync(P.lock, String(process.pid));
  lockHeld = true;
}
let lockHeld = false;
const releaseLock = () => { if (lockHeld) { try { unlinkSync(P.lock); } catch {} lockHeld = false; } };

// ----------------------------------------------------------------- steps ---
function doctor() {
  const res = run('node', ['doctor.mjs', '--json'], { label: 'node doctor.mjs --json', timeoutMin: 5 });
  let j = {};
  try { j = extractJson(res.stdout || ''); } catch { /* older doctor output */ }
  return j;
}

function scan(summary) {
  const before = new Set(pendingEntries(readText(P.pipeline)).map((e) => normUrl(e.url)));
  const res = run('node', ['scan.mjs'], { label: 'node scan.mjs', timeoutMin: 45 });
  const after = pendingEntries(readText(P.pipeline));
  summary.newPostings = after.filter((e) => !before.has(normUrl(e.url))).length;
  summary.pendingTotal = after.length;
  if (res.status === 2) summary.warnings.push('scan: every job board failed (network?)');
  else if (res.status !== 0) summary.warnings.push(`scan exited ${res.status}`);
  log(`  scan: ${summary.newPostings} new, ${after.length} pending total`);
}

async function triage(summary) {
  const triaged = readJson(P.triaged, {});
  const known = new Set([
    ...parseTracker(P.tracker).map((r) => normUrl(r.url)),
    ...parseBatchInput(P.batchInput).map((r) => normUrl(r.url)),
    ...[...parseBatchState(P.batchState).values()].map((r) => normUrl(r.url)),
    ...Object.keys(triaged),
  ]);
  // "Worth a look" postings from earlier runs that didn't fit under MAX_EVALS_PER_RUN.
  const queuedOrDone = new Set([
    ...parseTracker(P.tracker).map((r) => normUrl(r.url)),
    ...parseBatchInput(P.batchInput).map((r) => normUrl(r.url)),
    ...[...parseBatchState(P.batchState).values()].map((r) => normUrl(r.url)),
  ]);
  const carryOver = Object.entries(triaged)
    .filter(([k, t]) => t.verdict === 'worth' && !queuedOrDone.has(k) && t.date >= dateStr(new Date(Date.now() - 14 * 864e5)))
    .sort(([, a], [, b]) => (a.date || '').localeCompare(b.date || ''))
    .map(([, t]) => ({ url: t.url, company: t.company, title: t.title, location: t.location, reason: t.reason }));
  if (carryOver.length) log(`  carry-over from earlier runs: ${carryOver.length}`);

  const fresh = pendingEntries(readText(P.pipeline)).filter((e) => !known.has(normUrl(e.url)));
  summary.triageInput = fresh.length;
  summary.carryOver = carryOver.length;
  if (!fresh.length) { log('  triage: nothing new to screen'); return carryOver; }
  const batch = fresh.slice(0, CFG.maxTriage);
  if (fresh.length > batch.length) summary.warnings.push(`triage capped at ${CFG.maxTriage} of ${fresh.length} postings (rest next run)`);

  const profile = readText(P.brief) || readText(P.profile).replace(/^\s*#.*$/gm, '').replace(/\n{3,}/g, '\n\n');
  const cv = readText(P.cv);
  const cvSummary = cv.slice(0, 2500) + '\n...\n' + (cv.match(/##\s+(Technical\s+)?Skills[\s\S]*/i) || [''])[0].slice(0, 2500);
  const postings = batch.map((e, i) => `${i + 1}. ${e.url} | ${e.company} | ${e.title} | ${e.location}`.replace(/[<>]/g, '')).join('\n');
  const prompt = fill(readText(join(AUTO_DIR, 'prompts', 'triage.md')), {
    PROFILE: profile.slice(0, 12000), CV: cvSummary, POSTINGS: postings,
  });

  const out = extractJson(await claude(prompt, 'claude triage', 20));
  const byUrl = new Map(batch.map((e) => [normUrl(e.url), e]));
  const clean = (list) => (Array.isArray(list) ? list : [])
    .filter((x) => x && byUrl.has(normUrl(x.url)))           // only URLs we actually gave it
    .map((x) => ({ ...byUrl.get(normUrl(x.url)), reason: String(x.reason || '').slice(0, 140) }));
  const worth = clean(out.worth);
  const maybe = clean(out.maybe);
  summary.worth = worth.length;
  summary.maybe = maybe.length;
  summary.skipped = batch.length - worth.length - maybe.length;
  summary.shortlist = worth.map((w) => ({ company: w.company, title: w.title, url: w.url, reason: w.reason }));
  summary.maybeList = maybe.slice(0, 5).map((w) => ({ company: w.company, title: w.title, url: w.url }));

  const verdictOf = new Map([...worth.map((w) => [normUrl(w.url), ['worth', w.reason]]), ...maybe.map((m) => [normUrl(m.url), ['maybe', m.reason]])]);
  for (const e of batch) {
    const [verdict, reason] = verdictOf.get(normUrl(e.url)) || ['skip', ''];
    triaged[normUrl(e.url)] = { date: TODAY, verdict, reason, url: e.url, company: e.company, title: e.title, location: e.location };
  }
  writeJson(P.triaged, triaged);

  const md = [`# Shortlist ${TODAY}`, '', '## Worth a look', ...worth.map((w) => `- ${w.company} — ${w.title} — ${w.reason}  ${w.url}`),
    '', '## Maybe', ...maybe.map((w) => `- ${w.company} — ${w.title} — ${w.reason}  ${w.url}`)].join('\n');
  writeFileSync(join(STATE_DIR, `shortlist-${TODAY}.md`), md);
  log(`  triage: ${worth.length} worth, ${maybe.length} maybe, ${summary.skipped} skip`);
  return [...carryOver, ...worth];
}

function queueForBatch(worth, summary) {
  const toQueue = worth.slice(0, CFG.maxEvals);
  if (worth.length > toQueue.length) summary.warnings.push(`${worth.length - toQueue.length} more good matches left for tomorrow (MAX_EVALS_PER_RUN=${CFG.maxEvals})`);
  if (!toQueue.length) return 0;
  const existing = parseBatchInput(P.batchInput);
  const stateIds = [...parseBatchState(P.batchState).keys()];
  let next = Math.max(0, ...existing.map((r) => parseInt(r.id, 10) || 0), ...stateIds.map((i) => parseInt(i, 10) || 0)) + 1;
  const clean = (s) => String(s || '').replace(/[\t\r\n]+/g, ' ').trim();
  if (!existsSync(P.batchInput) || !readText(P.batchInput).trim()) writeFileSync(P.batchInput, 'id\turl\tsource\tnotes\n');
  else if (!readText(P.batchInput).endsWith('\n')) appendFileSync(P.batchInput, '\n');
  for (const w of toQueue) appendFileSync(P.batchInput, `${next++}\t${clean(w.url)}\tdaily-agent\t${clean(w.company)} - ${clean(w.title)}\n`);
  log(`  queued ${toQueue.length} postings in batch/batch-input.tsv`);
  return toQueue.length;
}

function evaluate(queued, summary) {
  const bash = findGitBash();
  if (!bash) throw new Error('Git Bash not found. Install Git for Windows or set GIT_BASH in automation/.env');
  const before = parseBatchState(P.batchState);
  const paused = [...before.values()].filter((r) => r.status === 'paused_rate_limit').length;
  const base = ['batch/batch-runner.sh', '--mode', CFG.batchMode, '--min-score', String(CFG.minScore), '--parallel', String(CFG.parallel)];
  if (paused) run(bash, [...base, '--resume-paused'], { label: `batch-runner --resume-paused (${paused})`, timeoutMin: 240 });
  if (queued > 0) {
    const res = run(bash, [...base, '--limit', String(queued)], { label: `batch-runner --limit ${queued}`, timeoutMin: 240 });
    if (res.status !== 0) summary.warnings.push(`batch runner exited ${res.status} (see log)`);
  }
  const after = parseBatchState(P.batchState);
  const changed = [...after.values()].filter((r) => {
    const b = before.get(r.id);
    return !b || b.status !== r.status || b.reportNum !== r.reportNum;
  });
  summary.evaluated = changed.filter((r) => r.status === 'completed').length;
  summary.failed = changed.filter((r) => r.status === 'failed').length;
  summary.dealbreakers = changed.filter((r) => r.status === 'skipped').length;
  summary.rateLimited = [...after.values()].filter((r) => r.status === 'paused_rate_limit').length;
  if (summary.rateLimited) summary.warnings.push(`Claude usage limit hit: ${summary.rateLimited} job(s) paused, resumed next run`);
  return changed;
}

function enrichResults(changed) {
  const tracker = parseTracker(P.tracker);
  const byReport = new Map(tracker.filter((r) => r.reportNum != null).map((r) => [r.reportNum, r]));
  const byUrl = new Map(tracker.map((r) => [normUrl(r.url), r]));
  const input = new Map(parseBatchInput(P.batchInput).map((r) => [r.id, r]));
  return changed.filter((r) => r.status === 'completed' || r.status === 'skipped').map((r) => {
    const t = (r.reportNum != null && byReport.get(r.reportNum)) || byUrl.get(normUrl(r.url)) || {};
    const reportPath = (t.reportPath && existsSync(t.reportPath)) ? t.reportPath : findReportFile(P.reports, r.reportNum);
    const facts = reportPath ? reportFacts(readText(reportPath)) : {};
    const cvPdf = facts.pdfPath && existsSync(join(DATA, facts.pdfPath)) ? join(DATA, facts.pdfPath) : '';
    const [inCompany, inTitle] = (input.get(r.id)?.notes || '').split(' - ');
    return {
      id: r.id, status: r.status, url: r.url, reportNum: r.reportNum,
      score: r.score ?? t.score ?? null,
      company: t.company || inCompany || '', role: t.role || inTitle || '',
      trackerStatus: t.status || '', reportPath, cvPdf, verdict: facts.verdict || '', coverPdf: '', coverMd: '', coverNote: '',
    };
  }).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

async function coverLetters(results, summary) {
  const strong = results.filter((r) => r.status === 'completed' && (r.score ?? 0) >= CFG.minScore && r.reportPath);
  if (!strong.length) return;
  const template = readText(join(AUTO_DIR, 'prompts', 'cover.md'));
  const cv = readText(P.cv);
  const profileYml = readText(P.profile);
  const contact = (profileYml.match(/^candidate:[\s\S]*?(?=^\S)/m) || [profileYml.slice(0, 3000)])[0];
  const voice = readText(P.voice);
  const profileMd = readText(P.profileMd);
  const voiceRules = [
    voice ? `- Follow the candidate's voice rules:\n${voice.slice(0, 5000)}` : '',
    /##\s+Writing Style/i.test(profileMd) ? `- Candidate writing style:\n${(profileMd.match(/##\s+Writing Style[\s\S]*?(?=\n##\s|$)/i) || [''])[0].slice(0, 3000)}` : '',
  ].filter(Boolean).join('\n');

  for (const r of strong) {
    const slug = `${String(r.reportNum ?? r.id).padStart(3, '0')}-${slugify(r.company)}`;
    const relPdf = `output/cover-letters/cover-${slug}.pdf`;
    try {
      const prompt = fill(template, {
        TONE: CFG.coverTone, VOICE: voiceRules, DATE: TODAY,
        CONTACT: contact.slice(0, 3000), CV: cv, PROOF: readText(P.digest).slice(0, 8000) || '(none)',
        REPORT: readText(r.reportPath).slice(0, 40000),
      });
      const payload = extractJson(await claude(prompt, `claude cover ${slug}`, 15));
      payload.user_inputs = [];
      payload.output_path = relPdf;
      mkdirSync(join(DATA, 'output', 'cover-letters'), { recursive: true });

      // Always keep a plain-text copy you can paste into an application form.
      const L = payload.letter || {};
      const md = [
        `# Cover letter: ${L.role_title || r.role} at ${L.company || r.company}`, `_Auto-draft ${TODAY}. Review before sending._`, '',
        L.greeting || '', L.opening, '', L.profile_intro, '',
        ...(L.achievements || []).map((a) => `- **${a.lead},** ${a.impact}`), '',
        L.problems_section, '', L.closing, '', payload.candidate?.name || '',
      ].filter((x) => x !== undefined).join('\n');
      r.coverMd = join(DATA, 'output', 'cover-letters', `cover-${slug}.md`);
      writeFileSync(r.coverMd, md);

      const payloadPath = join(TMP_DIR, `cover-${slug}.json`);
      writeJson(payloadPath, payload);
      const res = run('node', ['generate-cover-letter.mjs', '--payload', payloadPath], { label: `generate-cover-letter ${slug}`, timeoutMin: 10 });
      if (res.status === 0 && existsSync(join(DATA, relPdf))) {
        r.coverPdf = join(DATA, relPdf);
      } else {
        r.coverNote = /block/i.test(res.stdout + res.stderr) ? 'fact-check blocked PDF, text draft saved' : 'PDF render failed, text draft saved';
        summary.warnings.push(`cover ${r.company}: ${r.coverNote}`);
      }
    } catch (err) {
      r.coverNote = `cover letter failed: ${err.message.slice(0, 120)}`;
      summary.warnings.push(`cover ${r.company}: ${r.coverNote}`);
      log(`  ! ${r.coverNote}`);
    }
  }
  summary.covers = strong.filter((r) => r.coverPdf).length;
}

function buildSpreadsheet(summary, results) {
  const fileLink = (p, text) => (p ? { link: pathToFileURL(p).href, text } : '');
  const tracker = parseTracker(P.tracker).sort((a, b) => b.num - a.num);
  const resultsByReport = new Map((results || []).map((r) => [r.reportNum, r]));
  const coverFor = (num, company) => {
    const slug = `${String(num).padStart(3, '0')}-${slugify(company)}`;
    const pdf = join(DATA, 'output', 'cover-letters', `cover-${slug}.pdf`);
    const md = join(DATA, 'output', 'cover-letters', `cover-${slug}.md`);
    return existsSync(pdf) ? pdf : existsSync(md) ? md : '';
  };
  const appRows = tracker.map((t) => {
    const reportPath = t.reportPath && existsSync(t.reportPath) ? t.reportPath : findReportFile(P.reports, t.reportNum);
    const facts = reportPath ? reportFacts(readText(reportPath)) : {};
    const cvPdf = facts.pdfPath && existsSync(join(DATA, facts.pdfPath)) ? join(DATA, facts.pdfPath) : '';
    const cover = coverFor(t.reportNum ?? t.num, t.company);
    const url = t.url || facts.url || '';
    const rec = t.score == null ? '' : t.score >= 4.5 ? 'Strong - apply' : t.score >= CFG.minScore ? 'Good - review gaps' : 'Below bar - skip';
    return [
      t.num, t.date, { value: t.company, style: STYLE.bold }, t.role, scoreCell(t.score), t.status, rec,
      url ? { link: url, text: 'Job posting' } : '',
      fileLink(reportPath, 'Report'), fileLink(cvPdf, 'Tailored CV'), fileLink(cover, cover.endsWith('.pdf') ? 'Cover letter' : 'Cover (text)'),
      resultsByReport.get(t.reportNum)?.verdict || facts.verdict || '', t.notes,
    ];
  });

  const runs = readJson(P.runs, []);
  const runRows = runs.slice().reverse().map((r) => [
    r.date, r.time, r.newPostings ?? '', r.triageInput ?? '', r.worth ?? '', r.maybe ?? '', r.evaluated ?? '',
    r.strong ?? '', r.covers ?? '', r.failed ?? '', r.minutes ?? '', r.status, (r.warnings || []).join(' | '),
  ]);

  const triaged = Object.values(readJson(P.triaged, {})).sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 1500);
  const triageRows = triaged.map((t) => [t.date, t.verdict, t.company, t.title, t.location, t.reason, t.url ? { link: t.url, text: 'Open' } : '']);

  return writeXlsx(CFG.excelPath, [
    { name: 'Applications', rows: appRows, columns: [
      { header: '#', width: 6 }, { header: 'Date', width: 11 }, { header: 'Company', width: 22 }, { header: 'Role', width: 34, wrap: true },
      { header: 'Score', width: 8 }, { header: 'Status', width: 12 }, { header: 'Recommendation', width: 18 },
      { header: 'Job link', width: 12 }, { header: 'Report', width: 9 }, { header: 'Tailored CV', width: 12 }, { header: 'Cover letter', width: 13 },
      { header: 'Verdict', width: 60, wrap: true }, { header: 'Notes', width: 40, wrap: true },
    ] },
    { name: 'Daily runs', rows: runRows, columns: [
      { header: 'Date', width: 11 }, { header: 'Time', width: 8 }, { header: 'New postings', width: 12 }, { header: 'Screened', width: 10 },
      { header: 'Worth a look', width: 12 }, { header: 'Maybe', width: 8 }, { header: 'Evaluated', width: 10 }, { header: `Score >= ${CFG.minScore}`, width: 11 },
      { header: 'Cover letters', width: 12 }, { header: 'Failed', width: 8 }, { header: 'Minutes', width: 9 }, { header: 'Status', width: 10 },
      { header: 'Warnings', width: 80, wrap: true },
    ] },
    { name: 'Screening log', rows: triageRows, columns: [
      { header: 'Date', width: 11 }, { header: 'Verdict', width: 9 }, { header: 'Company', width: 22 }, { header: 'Title', width: 40, wrap: true },
      { header: 'Location', width: 22 }, { header: 'Reason', width: 50, wrap: true }, { header: 'Link', width: 8 },
    ] },
  ]);
}

function buildMessage(summary, results, fatal) {
  const when = new Intl.DateTimeFormat('en-US', { timeZone: CFG.tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(started);
  const L = [];
  if (fatal) {
    L.push(`❌ *career-ops daily run FAILED* (${when})`, `Step: ${summary.step}`, `Error: ${fatal.slice(0, 300)}`);
    if (summary.newPostings != null) L.push(`🔎 New postings found before failure: ${summary.newPostings}`);
    L.push(`Log: automation\\logs\\${LOG_FILE.split(/[\\/]/).pop()}`);
    return L.join('\n');
  }
  const strong = results.filter((r) => r.status === 'completed' && (r.score ?? 0) >= CFG.minScore);
  L.push(`🤖 *career-ops daily run* — ${when}`);
  L.push(`🔎 New postings: ${summary.newPostings ?? 'scan skipped'}`);
  L.push(`🧹 Screened ${summary.triageInput ?? 0} → ${summary.worth ?? 0} worth a look · ${summary.maybe ?? 0} maybe${summary.carryOver ? ` (+${summary.carryOver} from earlier runs)` : ''}`);
  if (summary.dryRun) L.push('🧪 Dry run: no evaluations, CVs or letters this time');
  else L.push(`📊 Evaluated ${summary.evaluated ?? 0} → ✅ ${strong.length} scored ≥${CFG.minScore.toFixed(1)}${summary.dealbreakers ? ` · ⛔ ${summary.dealbreakers} hit a dealbreaker` : ''}`);
  L.push(`⏱ ${summary.minutes} min`);

  if (strong.length) {
    L.push('', '⭐ *Ready for you to review & apply:*');
    strong.slice(0, 6).forEach((r, i) => {
      L.push(`${i + 1}. *${(r.score ?? 0).toFixed(1)}* · ${r.role} — ${r.company}`);
      L.push(`   CV ${r.cvPdf ? '✅' : '❌'} · Cover ${r.coverPdf ? '✅' : r.coverMd ? '📝' : '❌'}`);
      if (r.url) L.push(`   ${r.url}`);
    });
    if (strong.length > 6) L.push(`   …and ${strong.length - 6} more in job-log.xlsx`);
  }
  const weak = results.filter((r) => r.status === 'completed' && (r.score ?? 0) < CFG.minScore);
  if (weak.length) L.push('', `↘️ Below bar: ${weak.slice(0, 4).map((r) => `${r.company} ${(r.score ?? 0).toFixed(1)}`).join(', ')}${weak.length > 4 ? '…' : ''}`);
  if (summary.dryRun && summary.shortlist?.length) {
    L.push('', '📋 *Shortlist (not yet evaluated):*');
    summary.shortlist.slice(0, 6).forEach((s, i) => L.push(`${i + 1}. ${s.title} — ${s.company}\n   ${s.url}`));
  }
  if (summary.warnings.length) L.push('', '⚠️ ' + summary.warnings.slice(0, 5).join('\n⚠️ '));
  L.push('', `📁 ${summary.excel ? 'job-log.xlsx updated' : 'spreadsheet not updated'}${summary.excelLocked ? ' (was open, saved a copy)' : ''}`);
  L.push('👉 Nothing was submitted. Review, then apply yourself.');
  return L.join('\n');
}

// ------------------------------------------------------------------ main ---
async function main() {
  if (ARGS.has('--test-whatsapp')) {
    const r = await sendWhatsApp(`✅ career-ops daily agent: WhatsApp test from ${process.env.COMPUTERNAME || 'your PC'} at ${new Date().toLocaleString('en-US', { timeZone: CFG.tz })}`, ENV);
    console.log(r.ok ? `Sent via ${r.provider}` : `FAILED (${r.provider}): ${r.error}`);
    process.exit(r.ok ? 0 : 1);
  }

  const summary = { step: 'start', warnings: [], dryRun: ARGS.has('--dry-run') };
  let results = [];
  let fatal = null;

  if (ARGS.has('--excel-only')) {
    const x = buildSpreadsheet(summary, []);
    console.log(`Spreadsheet written: ${x.path}`);
    return;
  }

  try {
    acquireLock();
    log(`career-ops repo: ${CFG.repo}`);
    log(`data root:       ${DATA}`);
    if (!existsSync(join(CFG.repo, 'scan.mjs'))) throw new Error(`career-ops not found at ${CFG.repo} (set CAREER_OPS_DIR in automation/.env)`);

    summary.step = 'setup check';
    const doc = doctor();
    if (doc.onboardingNeeded) throw new Error(`career-ops onboarding not finished; missing: ${(doc.missing || []).join(', ')}. Open Claude Code in the career-ops folder and complete onboarding.`);
    if (doc.unpersonalized?.length) summary.warnings.push(`not personalized yet: ${doc.unpersonalized.map((u) => u.path || u).join(', ')}`);

    if (!ARGS.has('--skip-scan')) { summary.step = 'scan'; scan(summary); }

    summary.step = 'triage';
    const worth = await triage(summary);

    if (!summary.dryRun) {
      summary.step = 'evaluate';
      const queued = queueForBatch(worth, summary);
      const changed = evaluate(queued, summary);
      results = enrichResults(changed);
      summary.strong = results.filter((r) => r.status === 'completed' && (r.score ?? 0) >= CFG.minScore).length;

      if (CFG.coverLetters) { summary.step = 'cover letters'; await coverLetters(results, summary); }
    }
  } catch (err) {
    fatal = err.message;
    log(`FATAL at ${summary.step}: ${err.stack || err.message}`);
  }

  summary.minutes = Math.round((Date.now() - started.getTime()) / 60000);
  const runs = readJson(P.runs, []);
  runs.push({
    date: TODAY, time: new Intl.DateTimeFormat('en-US', { timeZone: CFG.tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(started),
    newPostings: summary.newPostings, triageInput: summary.triageInput, worth: summary.worth, maybe: summary.maybe,
    evaluated: summary.evaluated, strong: summary.strong, covers: summary.covers, failed: summary.failed,
    minutes: summary.minutes, status: fatal ? `FAILED (${summary.step})` : summary.dryRun ? 'dry-run' : 'ok', warnings: fatal ? [fatal, ...summary.warnings] : summary.warnings,
  });
  writeJson(P.runs, runs.slice(-400));

  try {
    const x = buildSpreadsheet(summary, results);
    summary.excel = x.path; summary.excelLocked = x.locked;
    log(`spreadsheet: ${x.path}${x.locked ? ' (original was locked/open)' : ''}`);
  } catch (err) {
    summary.warnings.push(`spreadsheet failed: ${err.message}`);
    log(`! spreadsheet failed: ${err.stack}`);
  }

  const message = buildMessage(summary, results, fatal);
  appendFileSync(LOG_FILE, `\n--- WhatsApp message ---\n${message}\n`);
  const sent = await sendWhatsApp(message, ENV);
  log(sent.ok ? `WhatsApp sent via ${sent.provider}` : `! WhatsApp failed (${sent.provider}): ${sent.error}`);

  releaseLock();
  process.exitCode = fatal ? 1 : 0;
}

main().catch((err) => { log(`unhandled: ${err.stack}`); releaseLock(); process.exit(1); });
