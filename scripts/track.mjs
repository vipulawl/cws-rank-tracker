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
      const text = (a.innerText || a.getAttribute('aria-label') || '').trim();
      out.push({ id: m[1], name: text.split('\n').map((t) => t.trim()).filter(Boolean)[0] || '' });
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

async function main() {
  const config = await readJson(path.join(DOCS, 'config.json'), {});
  const allMarkets = await readJson(path.join(DOCS, 'markets.json'), []);
  const mainId = extractId(config.extension);
  if (!mainId) {
    console.log('No extension configured in docs/config.json - nothing to do.');
    return;
  }
  const competitorIds = (config.competitors || []).map(extractId).filter((x) => x && x !== mainId);
  const tracked = [mainId, ...new Set(competitorIds)];
  const keywords = [...new Set((config.keywords || []).map((k) => String(k).trim()).filter(Boolean))];
  const wanted = config.markets === 'all' ? allMarkets.map((m) => m.code) : (config.markets || ['US']);
  const markets = allMarkets.filter((m) => wanted.includes(m.code));
  const depth = Math.max(10, Math.min(Number(config.depth) || 100, 300));
  const concurrency = Math.max(1, Math.min(Number(process.env.CONCURRENCY) || 4, 8));
  if (!keywords.length || !markets.length) {
    console.log('Add at least one keyword and one market in docs/config.json.');
    return;
  }

  const date = new Date().toISOString().slice(0, 10);
  console.log(`Tracking ${tracked.length} extension(s), ${keywords.length} keyword(s), ${markets.length} market(s), depth ${depth}.`);

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
  for (const id of tracked) {
    if (!extensions[id] || extensions[id].name === id || !extensions[id].fetched || extensions[id].fetched < date.slice(0, 7)) {
      extensions[id] = { ...(await fetchMeta(context, id)), fetched: date.slice(0, 7) };
    }
  }

  const jobs = [];
  for (const market of markets) for (const keyword of keywords) jobs.push({ market, keyword });
  const errors = [];
  const started = Date.now();
  const results = await pool(jobs, concurrency, async ({ market, keyword }, idx) => {
    await sleep(jitter(400));
    try {
      const { results } = await search(context, keyword, market, depth);
      const ranks = {};
      for (const id of tracked) {
        const pos = results.findIndex((r) => r.id === id);
        ranks[id] = pos === -1 ? 0 : pos + 1; // 0 = not found within depth
      }
      if (idx % 10 === 0) console.log(`[${idx + 1}/${jobs.length}] ${market.code} "${keyword}" -> ${ranks[mainId] || '-'} (${results.length} results)`);
      return { market: market.code, keyword, ranks, scanned: results.length, top: results.slice(0, 10) };
    } catch (e) {
      errors.push({ market: market.code, keyword, error: String(e.message || e).slice(0, 200) });
      return { market: market.code, keyword, ranks: null, scanned: 0, top: [] };
    }
  });
  await browser.close();

  // ---- history: { dates: [...], series: { keyword: { market: { extId: [rank|null] } } } }
  const history = await readJson(path.join(DATA, 'history.json'), { dates: [], series: {} });
  let di = history.dates.indexOf(date);
  if (di === -1) {
    history.dates.push(date);
    history.dates.sort();
    di = history.dates.indexOf(date);
    // insert a null slot for every existing series at the new position
    for (const k of Object.keys(history.series)) for (const m of Object.keys(history.series[k]))
      for (const id of Object.keys(history.series[k][m])) history.series[k][m][id].splice(di, 0, null);
  }
  for (const r of results) {
    if (!r.ranks) continue; // keep previous value (or null) for failed searches
    const byMarket = (history.series[r.keyword] ||= {});
    const byExt = (byMarket[r.market] ||= {});
    for (const [id, rank] of Object.entries(r.ranks)) {
      const arr = (byExt[id] ||= new Array(history.dates.length).fill(null));
      while (arr.length < history.dates.length) arr.push(null);
      arr[di] = rank;
    }
  }
  history.depth = depth;
  history.updated = new Date().toISOString();

  const latest = {
    date,
    updated: history.updated,
    results: results.map(({ market, keyword, scanned, top, ranks }) => ({ market, keyword, scanned, ok: !!ranks, top })),
  };
  const ok = results.filter((r) => r.ranks).length;
  const status = {
    date,
    updated: history.updated,
    searches: jobs.length,
    succeeded: ok,
    failed: errors.length,
    zeroResults: results.filter((r) => r.ranks && r.scanned === 0).length,
    seconds: Math.round((Date.now() - started) / 1000),
    errors: errors.slice(0, 50),
  };

  await fs.mkdir(DATA, { recursive: true });
  await writeJson(path.join(DATA, 'history.json'), history);
  await writeJson(path.join(DATA, 'latest.json'), latest);
  await writeJson(path.join(DATA, 'extensions.json'), extensions);
  await writeJson(path.join(DATA, 'status.json'), status);
  console.log(`Done: ${ok}/${jobs.length} searches succeeded in ${status.seconds}s.`);
  if (ok === 0) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
