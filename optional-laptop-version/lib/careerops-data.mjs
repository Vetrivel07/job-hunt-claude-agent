// Read-only parsers for career-ops files. Kept independent of the repo's
// internal modules so a career-ops update can't break the daily agent.

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, resolve, dirname } from 'path';

export const readText = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

export function normUrl(u) {
  if (!u) return '';
  try {
    const url = new URL(u.trim());
    for (const k of [...url.searchParams.keys()]) {
      if (/^(utm_|gh_src|source|ref|lever-origin|trk)/i.test(k)) url.searchParams.delete(k);
    }
    url.hash = url.hash.match(/^#\/jobs?\//) ? url.hash : '';
    return (url.host.toLowerCase().replace(/\.$/, '') + url.pathname.replace(/\/+$/, '') + (url.search || '') + url.hash).toLowerCase();
  } catch {
    return u.trim().toLowerCase();
  }
}

const PENDING_HEADINGS = /^##\s+(pending|pendientes|pendentes|offen|en attente|in attesa|in afwachting|afventer|venter)\s*$/i;

/** Unchecked "- [ ] url | company | title | location | ..." lines in the Pending section. */
export function pendingEntries(pipelineText) {
  const out = [];
  let inPending = false;
  for (const line of pipelineText.split(/\r?\n/)) {
    if (/^##\s+/.test(line)) { inPending = PENDING_HEADINGS.test(line.trim()); continue; }
    if (!inPending) continue;
    const m = /^\s*-\s*\[\s\]\s+(\S+)(.*)$/.exec(line);
    if (!m) continue;
    const parts = m[2].split('|').map((s) => s.trim());
    // parts[0] is '' (text between url and first pipe)
    out.push({
      url: m[1],
      company: parts[1] || '',
      title: parts[2] || '',
      location: parts[3] || '',
      extra: parts.slice(4).filter(Boolean).join(' | '),
      line: line.trim(),
    });
  }
  return out;
}

function splitRow(line) {
  const cells = line.split('|').map((s) => s.trim());
  if (cells[0] === '') cells.shift();
  if (cells.length && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

const linkHref = (cell) => {
  const m = /\]\(([^)\s]+)\)/.exec(cell || '');
  if (m) return m[1];
  const u = /(https?:\/\/\S+)/.exec(cell || '');
  return u ? u[1] : '';
};

/** Parse data/applications.md into row objects. */
export function parseTracker(trackerPath) {
  const text = readText(trackerPath);
  const rows = [];
  let cols = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trimStart().startsWith('|')) continue;
    const cells = splitRow(line);
    if (!cols) {
      const lower = cells.map((c) => c.toLowerCase());
      if (lower.includes('company') && lower.includes('role')) {
        cols = {};
        lower.forEach((h, i) => {
          const key = h === '#' ? 'num' : h.replace(/[^a-z]/g, '');
          cols[key] = i;
        });
      }
      continue;
    }
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    const at = (k) => (cols[k] != null ? cells[cols[k]] ?? '' : '');
    const num = parseInt(at('num'), 10);
    if (Number.isNaN(num)) continue;
    const reportCell = at('report');
    const reportHref = linkHref(reportCell);
    const reportNumMatch = /\[(\d+)\]/.exec(reportCell);
    const scoreMatch = /(\d+(?:\.\d+)?)\s*\/\s*5/.exec(at('score'));
    rows.push({
      num,
      date: at('date'),
      company: at('company'),
      role: at('role'),
      score: scoreMatch ? parseFloat(scoreMatch[1]) : null,
      scoreRaw: at('score'),
      status: at('status').replace(/\*/g, ''),
      pdf: at('pdf'),
      reportNum: reportNumMatch ? parseInt(reportNumMatch[1], 10) : null,
      reportPath: reportHref ? resolve(dirname(trackerPath), reportHref) : '',
      notes: at('notes'),
      location: at('location'),
      url: linkHref(at('url')) || at('url'),
    });
  }
  return rows;
}

/** batch/batch-state.tsv -> Map(id -> row) */
export function parseBatchState(path) {
  const map = new Map();
  for (const line of readText(path).split(/\r?\n/)) {
    if (!line || line.startsWith('id\t')) continue;
    const p = line.split('\t');
    if (p.length < 3) continue;
    map.set(p[0], {
      id: p[0], url: p[1], status: p[2], started: p[3] || '', completed: p[4] || '',
      reportNum: p[5] && /\d/.test(p[5]) ? parseInt(p[5], 10) : null,
      score: p[6] && /\d/.test(p[6]) ? parseFloat(p[6]) : null,
      error: p[7] || '', retries: p[8] || '',
    });
  }
  return map;
}

/** batch/batch-input.tsv -> rows */
export function parseBatchInput(path) {
  const rows = [];
  for (const line of readText(path).split(/\r?\n/)) {
    if (!line || line.startsWith('id\t')) continue;
    const p = line.split('\t');
    if (p.length >= 2) rows.push({ id: p[0], url: p[1], source: p[2] || '', notes: p[3] || '' });
  }
  return rows;
}

export function findReportFile(reportsDir, num) {
  if (num == null || !existsSync(reportsDir)) return '';
  const pad = String(num).padStart(3, '0');
  const f = readdirSync(reportsDir).find((n) => (n.startsWith(`${pad}-`) || n.startsWith(`${num}-`)) && n.endsWith('.md'));
  return f ? join(reportsDir, f) : '';
}

/** Pull a few header fields out of an evaluation report. */
export function reportFacts(reportText) {
  const field = (name) => {
    const m = new RegExp(`\\*\\*${name}:\\*\\*\\s*(.+)`, 'i').exec(reportText);
    return m ? m[1].trim() : '';
  };
  const title = (/^#\s+(.+)$/m.exec(reportText) || [])[1] || '';
  const pdf = field('PDF');
  const pdfPath = (/(output\/[^\s)]+\.pdf)/.exec(pdf) || [])[1] || '';
  // first non-empty paragraph under "## Verdict"
  const verdict = (/##\s+Verdict[^\n]*\n+([\s\S]*?)(\n##\s|$)/i.exec(reportText) || [])[1] || '';
  return {
    title,
    url: field('URL'),
    score: field('Score'),
    legitimacy: field('Legitimacy'),
    pdfPath,
    verdict: verdict.replace(/\s+/g, ' ').trim().slice(0, 400),
  };
}

export const slugify = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'company';
