#!/usr/bin/env node
/**
 * Generates `projects.json` for the portfolio from the GitHub API.
 *
 * Run locally (no token needed for public repos):
 *   node generate-projects.mjs
 *
 * Run inside GitHub Actions (uses GITHUB_TOKEN for higher rate limits):
 *   GITHUB_TOKEN=... node generate-projects.mjs
 *
 * The portfolio loads `projects.json` instead of calling the GitHub API
 * directly, so there are no client-side rate limits.
 *
 * AUTO-DESCRIPTIONS
 * ----------------
 * Repos without a description are scanned automatically the moment the
 * pipeline runs. The scan works in two steps:
 *   1. README first  - if the repo has a README, the first meaningful
 *                      paragraph is extracted and used as the description.
 *   2. File tree     - otherwise the repository tree is analysed
 *                      (Arduino sketches, C/C++/Python/JS source files,
 *                      package.json, index.html, SDL2 usage, Docker, ...)
 *                      and a short human-readable description is composed.
 * Auto-built descriptions are flagged with `descAuto: true` in
 * projects.json; real ones written by the author are left untouched.
 *
 * NOTE: keep `categoryOf()` in sync with the category inference in index.html.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const USER = process.env.GH_USER || 'abderhmenlaroussi';
const TOKEN = process.env.GITHUB_TOKEN || '';
const OUT = join(process.cwd(), 'projects.json');
const MAX_REPOS = 24;
const API = 'https://api.github.com';

const WEB_LANGS = ['javascript', 'typescript', 'html', 'css', 'php', 'ruby', 'scss'];
const WEB_KEYWORDS = ['web', 'site', 'portfolio', 'frontend', 'react', 'vue', 'api', 'php', 'html', 'css', 'website'];
const EMBED_KEYWORDS = ['arduino', 'embedded', 'iot', 'firmware', 'microcontroller', 'esp', 'stm', 'sensor', 'serial', 'sdl', 'game'];

function categoryOf(repo) {
  const lang = (repo.language || '').toLowerCase();
  const hay = (repo.name + ' ' + (repo.description || '')).toLowerCase();
  if (EMBED_KEYWORDS.some((k) => hay.includes(k))) return 'embedded';
  if (WEB_LANGS.includes(lang) || WEB_KEYWORDS.some((k) => hay.includes(k))) return 'web';
  return 'software';
}

function truncate(s, n) {
  if (s.length <= n) return s;
  const cut = s.slice(0, n).replace(/\s+\S*$/, '');
  return cut + '…';
}

/* ---------- Step 1: extract a summary paragraph from the README ---------- */

function markdownSummary(md) {
  let text = String(md || '')
    .replace(/\r\n/g, '\n')
    .replace(/^---[\s\S]*?^\s*---\s*$/m, '') // YAML/TOML front matter
    .replace(/```[\s\S]*?```/g, ' ') // code blocks
    .replace(/^#{1,6}\s+.*$/gm, ' ') // headings
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
    .replace(/\[([^\]]*)\]\([^)\s]*\)/g, '$1') // links
    .replace(/`([^`]*)`/g, '$1') // inline code
    .replace(/[*_~>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length < 30) return null; // too thin to be useful
  // Reject repetitive/robot READMEs (activity logs, commit dumps) by
  // unique-word ratio — a real sentence uses varied vocabulary.
  const words = text.split(/\s+/);
  const unique = new Set(words.map((w) => w.toLowerCase()));
  if (unique.size / words.length < 0.5) return null;
  return truncate(text, 200);
}

async function fetchReadmeSummary(owner, repo, headers) {
  const res = await fetch(`${API}/repos/${owner}/${repo}/readme`, { headers });
  if (!res.ok) return null; // 404 = no README, other codes = fall through to tree
  const data = await res.json();
  const text = data.encoding === 'base64'
    ? Buffer.from(data.content || '', 'base64').toString('utf8')
    : (data.content || '');
  return markdownSummary(text);
}

/* ---------- Step 2: build a description from the file tree ---------- */

function cap(n) {
  return n > 10 ? '10+' : String(n);
}

function describeTree(lang, flags, totalFiles, name) {
  const bits = [];
  if (flags.ino > 0) bits.push(`${cap(flags.ino)} Arduino sketch${flags.ino > 1 ? 'es' : ''}`);
  if (flags.c > 0) bits.push(`${cap(flags.c)} C file${flags.c > 1 ? 's' : ''}`);
  if (flags.cpp > 0) bits.push(`${cap(flags.cpp)} C++ file${flags.cpp > 1 ? 's' : ''}`);
  if (flags.py > 0) bits.push(`${cap(flags.py)} Python file${flags.py > 1 ? 's' : ''}`);
  if (flags.ts > 0) bits.push('TypeScript');
  if (flags.js > 0 && flags.ts === 0) bits.push('JavaScript');
  if (flags.php > 0) bits.push('PHP');
  if (flags.html > 0) bits.push('HTML');
  if (flags.css > 0) bits.push('CSS');
  if (flags.pkgJson) bits.push('Node.js package');
  if (flags.reqTxt) bits.push('Python dependencies');
  if (flags.makefile) bits.push('Makefile build');
  if (flags.dockerfile) bits.push('Docker');
  if (flags.sdl && (flags.c > 0 || flags.cpp > 0)) bits.push('SDL2');
  if (flags.indexHtml && flags.html > 0) bits.push('static web page');

  if (name && /portfolio/i.test(name) && flags.html > 0) {
    return 'Personal portfolio website — single-file HTML/CSS/JS with GitHub auto-sync.';
  }
  if (flags.md > 0 && flags.md === totalFiles) {
    return 'Documentation-only repository (README).';
  }
  if (!bits.length) {
    const l = (lang || '').trim();
    return totalFiles > 0
      ? `A ${l ? l + ' ' : ''}project — ${totalFiles} file${totalFiles > 1 ? 's' : ''}.`
      : `A small ${l ? l + ' ' : ''}project.`;
  }
  const s = bits.join(', ');
  return s.charAt(0).toUpperCase() + s.slice(1) + '.';
}

async function treeSummary(owner, repo, language, headers) {
  const res = await fetch(`${API}/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`, { headers });
  if (!res.ok) return null;
  const tree = await res.json();
  const flags = {
    ino: 0, c: 0, cpp: 0, py: 0, js: 0, ts: 0, php: 0, html: 0, css: 0, md: 0,
    pkgJson: false, reqTxt: false, makefile: false, dockerfile: false,
    indexHtml: false, sdl: false,
  };
  let total = 0;
  for (const e of tree.tree || []) {
    if (e.type !== 'blob') continue;
    const lower = (e.path || '').toLowerCase();
    if (lower.includes('node_modules') || lower.includes('.venv') || lower.includes('/vendor/')) continue;
    total++;

    if (lower === 'package.json') { flags.pkgJson = true; continue; }
    if (lower === 'requirements.txt' || lower === 'pyproject.toml') { flags.reqTxt = true; continue; }
    if (lower === 'makefile') { flags.makefile = true; continue; }
    if (lower === 'dockerfile') { flags.dockerfile = true; continue; }
    if (lower.endsWith('index.html') || lower.endsWith('index.htm')) { flags.indexHtml = true; }
    if (lower.includes('sdl')) { flags.sdl = true; }

    if (lower.endsWith('.ino')) { flags.ino++; continue; }
    const i = lower.lastIndexOf('.');
    const ext = i > 0 ? lower.slice(i) : '';
    if (ext === '.c' || ext === '.h') flags.c++;
    else if (ext === '.cpp' || ext === '.hpp' || ext === '.cc' || ext === '.cxx') flags.cpp++;
    else if (ext === '.py') flags.py++;
    else if (ext === '.ts' || ext === '.tsx') flags.ts++;
    else if (ext === '.js' || ext === '.mjs' || ext === '.jsx') flags.js++;
    else if (ext === '.php') flags.php++;
    else if (ext === '.html' || ext === '.htm') flags.html++;
    else if (ext === '.css' || ext === '.scss' || ext === '.sass' || ext === '.less') flags.css++;
    else if (ext === '.md') flags.md++;
  }
  return describeTree(language, flags, total, repo);
}

/* ---------- per-repo scan (README first, then file tree) ---------- */

async function autoDescribe(owner, repoName, repo, headers) {
  try {
    const fromReadme = await fetchReadmeSummary(owner, repoName, headers);
    if (fromReadme) return { desc: fromReadme, auto: true };

    const fromTree = await treeSummary(owner, repoName, repo.language, headers);
    if (fromTree) return { desc: fromTree, auto: true };
  } catch (err) {
    console.warn(`  ! could not scan ${repoName}: ${err.message}`);
  }
  return null;
}

/* ---------- main ---------- */

async function main() {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'portfolio-sync' };
  if (TOKEN) headers.Authorization = 'Bearer ' + TOKEN;

  const res = await fetch(`${API}/users/${USER}/repos?sort=pushed&per_page=100`, { headers });
  if (!res.ok) throw new Error(`GitHub API responded with ${res.status} ${res.statusText}`);

  const repos = await res.json();
  const items = repos
    .filter((r) => !r.fork && !r.archived && !r.private)
    .map((r) => ({
      name: r.name,
      desc: r.description || '',
      url: r.html_url,
      lang: r.language || '',
      updated: r.pushed_at || r.created_at || '',
      category: categoryOf(r),
    }))
    .sort((a, b) => new Date(b.updated) - new Date(a.updated))
    .slice(0, MAX_REPOS);

  // Auto-scan repos that have no author-written description.
  const missing = items.filter((i) => !(i.desc && i.desc.trim()));
  console.log(`${items.length} repos in the feed, ${missing.length} without a description — scanning...`);
  for (let i = 0; i < missing.length; i += 5) {
    const results = await Promise.all(
      missing.slice(i, i + 5).map((r) => autoDescribe(USER, r.name, repos.find((x) => x.name === r.name) || {}, headers))
    );
    results.forEach((r, j) => {
      if (!r) return;
      const item = missing[i + j];
      item.desc = r.desc;
      item.descAuto = true;
      console.log(`  - ${item.name}: "${item.desc}"`);
    });
    await new Promise((done) => setTimeout(done, 150)); // be polite to the API
  }

  const payload = {
    generated: new Date().toISOString(),
    source: `https://github.com/${USER}`,
    repos: items,
  };

  writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n');
  console.log(`Wrote ${OUT} — ${items.length} repos (generated ${payload.generated})`);
}

main().catch((err) => {
  console.error('Sync failed:', err.message);
  process.exit(1);
});