// Chrome Web Store keyword rank tracker.
// Reads docs/config.json, searches the Chrome Web Store for every keyword in
// every market, records where the tracked extensions appear, and updates the
// data files the dashboard reads (docs/data/*.json).
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');
const DATA = path.join(DOCS, 'data');
const STORE = process.env.CWS_BASE || 'https://chromewebstore.google.com';
const ID_RE = /\/detail\/(?:[^/?#]+\/)?([a-p]{32})(?:[/?#]|$)/;

const readJson = async (file, fallback) => {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
};
const writeJson = (file, obj) => fs.writeFile(file, JSON.stringify(obj, null, 1) + '\n');

export function extractId(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^[a-p]{32}$/.test(s)) return s;
  const m = s.match(/([a-p]{32})/);
  return m ? m[1] : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (base) => base + Math.floor(Math.random() * base);

async function acceptConsentIfShown(page) {
  if (!/consent\./.test(page.url())) return;
  const buttons = page.locator('form[action*="consent"] button, button');
  const n = await buttons.count();
  // The "Accept all" button is the last submit button on Google's consent page.
  for (let i = n - 1; i >= 0; i--) {
    const b = buttons.nth(i);
    if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); break; }
  }
  await page.waitForURL(/chromewebstore\.google\.com/, { timeout: 20000 }).catch(() => {});
}

// Collect result ids in on-page order (each result card links to /detail/<slug>/<id>).
async function collectResults(page) {
  return page.evaluate((reSrc) => {
    const re = new RegExp(reSrc);
    const seen = new Set();
    const out = [];
    for (const a of document.querySelectorAll('a[href*="/detail/"]')) {
      const m = (a.getAttribute('href') || '').match(re);
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);
      // The name may sit outside the link: climb to the largest ancestor that holds only this result.
      let card = a;
      while (card.parentElement) {
        const ids = new Set([...card.parentElement.querySelectorAll('a[href*="/detail/"]')]
          .map((x) => ((x.getAttribute('href') || '').match(re) || [])[1]).filter(Boolean));
        if (ids.size > 1) break;
        card = card.parentElement;
      }
      const lines = [a.getAttribute('aria-label'), a.innerText, card.innerText]
        .flatMap((t) => String(t || '').split('\n')).map((t) => t.trim())
        .filter((t) => t.length > 1 && !/^[\d.,\s★()kKmM+]+$/.test(t));
      out.push({ id: m[1], name: lines[0] || '' });
    }
    return out;
  }, ID_RE.source);
}

// The results page shows a first batch and a "load more" button below it.
// The button label is localized, so we click the first visible button below the last result.
async function clickLoadMore(page) {
  return page.evaluate((reSrc) => {
    const re = new RegExp(reSrc);
    const anchors = [...document.querySelectorAll('a[href*="/detail/"]')].filter((a) => re.test(a.getAttribute('href') || ''));
    if (!anchors.length) return false;
    const last = anchors[anchors.length - 1];
    last.scrollIntoView({ block: 'center' });
    const lastBottom = last.getBoundingClientRect().bottom + window.scrollY;
    const btn = [...document.querySelectorAll('button')].find((b) => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.top + window.scrollY > lastBottom - 5 && (b.innerText || '').trim().length > 0;
    });
    if (!btn) return false;
    btn.scrollIntoView({ block: 'center' });
    btn.click();
    return true;
  }, ID_RE.source);
}

async function searchOnce(context, keyword, market, depth) {
  const page = await context.newPage();
  try {
    const url = `${STORE}/search/${encodeURIComponent(keyword)}?hl=${market.hl}&gl=${market.gl}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await acceptConsentIfShown(page);
    await page.waitForSelector('a[href*="/detail/"]', { timeout: 25000 }).catch(() => {});
    await sleep(800);
    let results = await collectResults(page);
    let stalls = 0;
    while (results.length < depth && stalls < 2) {
      const clicked = await clickLoadMore(page);
      if (!clicked) {
        // fall back to infinite-scroll behaviour
        await page.mouse.wheel(0, 6000);
      }
      await sleep(1500);
      const next = await collectResults(page);
      if (next.length > results.length) { results = next; stalls = 0; } else { stalls++; }
    }
    if (process.env.DEBUG_DIR) {
      await fs.mkdir(process.env.DEBUG_DIR, { recursive: true });
      const f = path.join(process.env.DEBUG_DIR, `${market.code}-${keyword.replace(/\W+/g, '_')}`);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: f + '.png', fullPage: false }).catch(() => {});
      await fs.writeFile(f + '.txt', results.map((r, i) => `${i + 1}. ${r.id} ${r.name}`).join('\n'));
    }
    return { results: results.slice(0, depth) };
  } finally {
    await page.close().catch(() => {});
  }
}

async function search(context, keyword, market, depth) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await searchOnce(context, keyword, market, depth);
      if (r.results.length > 0 || attempt === 3) return r;
      lastErr = new Error('no results on page');
    } catch (e) { lastErr = e; }
    await sleep(jitter(3000 * attempt));
  }
  throw lastErr;
}

async function fetchMeta(context, id) {
  const page = await context.newPage();
  try {
    await page.goto(`${STORE}/detail/${id}?hl=en`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await acceptConsentIfShown(page);
    const meta = await page.evaluate(() => {
      const og = (p) => document.querySelector(`meta[property="og:${p}"]`)?.content || '';
      return { title: og('title') || document.title, image: og('image') };
    });
    const name = meta.title.replace(/\s*[-–]\s*Chrome Web Store\s*$/i, '').trim();
    return { name: name || id, icon: meta.image || '', url: `${STORE}/detail/${id}` };
  } catch {
    return { name: id, icon: '', url: `${STORE}/detail/${id}` };
  } finally {
    await page.close().catch(() => {});
  }
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }));
  return out;
}

// Accepts both the multi-extension format { projects: [...] } and the original single-extension format.
export function normalizeProjects(config) {
  const list = Array.isArray(config.projects) ? config.projects : config.extension ? [config] : [];
  const seen = new Set();
  return list.map((p) => ({ ...p, id: extractId(p.extension) })).filter((p) => p.id && !seen.has(p.id) && seen.add(p.id));
}

function addDate(history, date) {
  let di = history.dates.indexOf(date);
  if (di !== -1) return di;
  history.dates.push(date);
  history.dates.sort();
  di = history.dates.indexOf(date);
  // insert a null slot for every existing series at the new position
  for (const k of Object.keys(history.series)) for (const m of Object.keys(history.series[k]))
    for (const id of Object.keys(history.series[k][m])) history.series[k][m][id].splice(di, 0, null);
  return di;
}

async function main() {
  const config = await readJson(path.join(DOCS, 'config.json'), {});
  const allMarkets = await readJson(path.join(DOCS, 'markets.json'), []);
  const concurrency = Math.max(1, Math.min(Number(process.env.CONCURRENCY) || 4, 8));
  const projects = normalizeProjects(config).map((p) => {
    const wanted = p.markets === 'all' ? allMarkets.map((m) => m.code) : (p.markets || ['US']);
    return {
      id: p.id,
      tracked: [p.id, ...new Set((p.competitors || []).map(extractId).filter((x) => x && x !== p.id))],
      keywords: [...new Set((p.keywords || []).map((k) => String(k).trim()).filter(Boolean))],
      markets: allMarkets.filter((m) => wanted.includes(m.code)).map((m) => m.code),
      depth: Math.max(10, Math.min(Number(p.depth) || 100, 300)),
    };
  }).filter((p) => p.keywords.length && p.markets.length);
  if (!projects.length) {
    console.log('No extension with keywords and markets in docs/config.json - nothing to do.');
    return;
  }

  // One search per unique keyword x market, shared by every extension that tracks it.
  const jobMap = new Map();
  for (const p of projects) for (const m of p.markets) for (const k of p.keywords) {
    const key = `${k}\u0000${m}`;
    const job = jobMap.get(key) || { keyword: k, market: allMarkets.find((x) => x.code === m), depth: 0, ids: new Set() };
    job.depth = Math.max(job.depth, p.depth);
    p.tracked.forEach((id) => job.ids.add(id));
    jobMap.set(key, job);
  }
  const jobs = [...jobMap.values()];
  const date = new Date().toISOString().slice(0, 10);
  console.log(`Tracking ${projects.length} extension(s): ${jobs.length} unique searches.`);

  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 900 },
  });
  // Skip heavy resources; we only need the DOM.
  await context.route('**/*', (route) => {
    const t = route.request().resourceType();
    return ['image', 'media', 'font'].includes(t) ? route.abort() : route.continue();
  });

  // Extension names / icons
  const extensions = await readJson(path.join(DATA, 'extensions.json'), {});
  for (const id of new Set(projects.flatMap((p) => p.tracked))) {
    if (!extensions[id] || extensions[id].name === id || !extensions[id].fetched || extensions[id].fetched < date.slice(0, 7)) {
      extensions[id] = { ...(await fetchMeta(context, id)), fetched: date.slice(0, 7) };
    }
  }

  const errors = [];
  const started = Date.now();
  const results = await pool(jobs, concurrency, async ({ market, keyword, depth, ids }, idx) => {
    await sleep(jitter(400));
    try {
      const { results } = await search(context, keyword, market, depth);
      const ranks = {};
      for (const id of ids) {
        const pos = results.findIndex((r) => r.id === id);
        ranks[id] = pos === -1 ? 0 : pos + 1; // 0 = not found within depth
      }
      if (idx % 10 === 0) console.log(`[${idx + 1}/${jobs.length}] ${market.code} "${keyword}" (${results.length} results)`);
      return { market: market.code, keyword, ranks, scanned: results.length, top: results.slice(0, 20) };
    } catch (e) {
      errors.push({ market: market.code, keyword, error: String(e.message || e).slice(0, 200) });
      return { market: market.code, keyword, ranks: null, scanned: 0, top: [] };
    }
  });
  await browser.close();
  const updated = new Date().toISOString();

  // ---- per-extension history: docs/data/projects/<id>.json
  //      { dates: [...], series: { keyword: { market: { extId: [rank|null per date] } } } }
  await fs.mkdir(path.join(DATA, 'projects'), { recursive: true });
  const legacyFile = path.join(DATA, 'history.json');
  const legacy = await readJson(legacyFile, null);
  for (const [pi, p] of projects.entries()) {
    const file = path.join(DATA, 'projects', `${p.id}.json`);
    let history = await readJson(file, null);
    if (!history && legacy && pi === 0) history = legacy; // migrate data from the single-extension version
    history ||= { dates: [], series: {} };
    const di = addDate(history, date);
    for (const r of results) {
      if (!r.ranks || !p.keywords.includes(r.keyword) || !p.markets.includes(r.market)) continue; // failed searches keep null
      const byExt = ((history.series[r.keyword] ||= {})[r.market] ||= {});
      for (const id of p.tracked) {
        const arr = (byExt[id] ||= new Array(history.dates.length).fill(null));
        while (arr.length < history.dates.length) arr.push(null);
        arr[di] = r.ranks[id] ?? null;
      }
    }
    history.depth = p.depth;
    history.updated = updated;
    await writeJson(file, history);
  }
  if (legacy) await fs.rm(legacyFile, { force: true });

  // ---- latest top results, shared by all extensions
  const latest = {
    date,
    updated,
    results: results.map(({ market, keyword, scanned, top, ranks }) => ({ market, keyword, scanned, ok: !!ranks, top })),
  };
  const ok = results.filter((r) => r.ranks).length;
  const status = {
    date,
    updated,
    searches: jobs.length,
    succeeded: ok,
    failed: errors.length,
    zeroResults: results.filter((r) => r.ranks && r.scanned === 0).length,
    seconds: Math.round((Date.now() - started) / 1000),
    errors: errors.slice(0, 50),
  };

  await writeJson(path.join(DATA, 'latest.json'), latest);
  await writeJson(path.join(DATA, 'extensions.json'), extensions);
  await writeJson(path.join(DATA, 'status.json'), status);
  console.log(`Done: ${ok}/${jobs.length} searches succeeded in ${status.seconds}s.`);
  if (ok === 0) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
