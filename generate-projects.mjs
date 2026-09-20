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
 * NOTE: keep `categoryOf()` in sync with the category inference in index.html.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const USER = process.env.GH_USER || 'abderhmenlaroussi';
const TOKEN = process.env.GITHUB_TOKEN || '';
const OUT = join(process.cwd(), 'projects.json');
const MAX_REPOS = 24;

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

async function main() {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'portfolio-sync' };
  if (TOKEN) headers.Authorization = 'Bearer ' + TOKEN;

  const res = await fetch(`https://api.github.com/users/${USER}/repos?sort=pushed&per_page=100`, { headers });
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