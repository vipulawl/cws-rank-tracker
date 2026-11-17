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
      const name = lines[0] || '';
      // the card's short description is its longest line of text
      const desc = lines.filter((t) => t !== name && t.length > 25).sort((x, y) => y.length - x.length)[0] || '';
      out.push({ id: m[1], name, desc });
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

// Read an extension's store page (in English): name, icon, users, ratings, category.
export function parseDetailText(text) {
  const num = (s, suffix) => {
    const n = parseFloat(String(s).replace(/,/g, ''));
    return Math.round(n * ({ K: 1e3, M: 1e6, B: 1e9 }[String(suffix || '').toUpperCase()] || 1));
  };
  const u = text.match(/([\d,]+)\+?\s+users?\b/i);
  const rc = text.match(/\(\s*([\d.,]+)\s*([KMB]?)\s+ratings?\s*\)/i);
  const rv = text.match(/(?:^|\n)\s*(\d(?:\.\d)?)\s*\n\s*\(\s*[\d.,]+\s*[KMB]?\s+ratings?/i);
  const lines = text.split('\n').map((t) => t.trim()).filter(Boolean);
  const ei = lines.findIndex((l) => /^(Extension|Theme)$/.test(l));
  const cat = ei >= 0 && lines[ei + 1] && !/users?$/i.test(lines[ei + 1]) ? lines[ei + 1] : '';
  return {
    users: u ? num(u[1]) : 0,
    ratings: rc ? num(rc[1], rc[2]) : 0,
    rating: rv ? parseFloat(rv[1]) : null,
    category: cat,
  };
}

async function fetchMeta(context, id) {
  const page = await context.newPage();
  try {
    await page.goto(`${STORE}/detail/${id}?hl=en`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await acceptConsentIfShown(page);
    await page.waitForFunction(() => /\busers?\b/i.test(document.body.innerText), null, { timeout: 10000 }).catch(() => {});
    const meta = await page.evaluate(() => {
      const og = (p) => document.querySelector(`meta[property="og:${p}"]`)?.content || '';
      return { title: og('title') || document.title, image: og('image'), text: document.body.innerText };
    });
    const name = meta.title.replace(/\s*[-–]\s*Chrome Web Store\s*$/i, '').trim();
    return { name: name || id, icon: meta.image || '', url: `${STORE}/detail/${id}`, ...parseDetailText(meta.text), ok: true };
  } catch {
    return { name: id, icon: '', url: `${STORE}/detail/${id}`, ok: false };
  } finally {
    await page.close().catch(() => {});
  }
}

// The store's search box suggests extensions (not search phrases) while you type.
// We type the keyword and read the suggestion response: names (+ ids when given).
async function storeSuggestions(context, keyword) {
  const page = await context.newPage();
  const found = [];
  try {
    page.on('response', async (r) => {
      if (!/rpcids=QcU9bc/.test(r.url())) return;
      let typed = null;
      try { typed = JSON.parse(JSON.parse(new URLSearchParams(r.request().postData() || '').get('f.req'))[0][0][1])[0]; } catch {}
      if (typeof typed !== 'string' || typed.trim().toLowerCase() !== keyword.trim().toLowerCase()) return;
      try {
        const body = await r.text();
        const line = body.split('\n').find((l) => l.startsWith('[["wrb.fr"'));
        const payload = JSON.parse(JSON.parse(line)[0][2]);
        found.length = 0;
        for (const e of payload[0] || []) {
          if (e && e[0] && e[0][0]) found.push({ name: e[0][0] });
          else if (e && e[1]) found.push({ name: e[1][0], id: e[1][1] });
        }
      } catch {}
    });
    await page.goto(`${STORE}/?hl=en`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await acceptConsentIfShown(page);
    const input = page.locator('input[aria-label="Search Chrome Web Store"]').first();
    await input.waitFor({ state: 'visible', timeout: 15000 });
    await input.click();
    await input.pressSequentially(keyword, { delay: 90 });
    for (let t = 0; t < 10 && !found.length; t++) await sleep(500);
    if (!found.length) {
      // fall back to reading the dropdown itself
      const opts = await page.evaluate(() => [...document.querySelectorAll('[role=option]')].map((o) => (o.innerText || '').split('\n')[0].trim()).filter(Boolean)).catch(() => []);
      opts.forEach((name) => found.push({ name }));
    }
    return [...found];
  } catch {
    return [...found];
  } finally {
    await page.close().catch(() => {});
  }
}

// ---- keyword ideas: phrases that many of the store's relevant extensions use in their name or description
const STOP = new Set(('a an and are as at be by for from get has have in into is it its of on or our the this to with your you all any can more most one only than that their them then there these they using use via will just also very new now best free top easy fast simple quick one-click click chrome extension extensions browser tool tools app apps plugin addon add-on page pages web website site sites online ' +
  'see make help helps let lets want need know like over every each other within without about after before while when what which who how why where here instantly automatically directly ' +
  'de la le les et des du en un une el los las y para con por die der das und für mit von zu ein eine').split(/\s+/));
export function mineKeywordIdeas(docs, tracked, limit = 40) {
  // docs: [{ id, text, weight }]; returns phrases (1-3 words) used by several distinct extensions
  const have = new Set(tracked.map((k) => k.toLowerCase()));
  const score = new Map();
  for (const d of docs) {
    const words = d.text.toLowerCase().replace(/[^a-z0-9.+#\s-]/g, ' ').split(/\s+/).map((w) => w.replace(/^[.\-]+|[.\-]+$/g, '')).filter(Boolean);
    const seen = new Set();
    for (let n = 1; n <= 3; n++) for (let i = 0; i + n <= words.length; i++) {
      const g = words.slice(i, i + n);
      if (g.some((w) => STOP.has(w) || w.length < 2 || /^\d+$/.test(w))) continue;
      // single words are too broad, e.g. google or checker; keep only technical ones such as llms.txt
      if (n === 1 && !/[.+#\d]/.test(g[0])) continue;
      if (new Set(g.map((w) => w.slice(0, 5))).size < n) continue; // repeated stems, e.g. scraper scrape
      seen.add(g.join(' '));
    }
    for (const ph of seen) {
      const s = score.get(ph) || { phrase: ph, extensions: 0, weight: 0 };
      s.extensions++; s.weight += d.weight; score.set(ph, s);
    }
  }
  return [...score.values()]
    // skip what you already track, and bare parts of it ("audit" when you track "geo audit")
    .filter((s) => s.extensions >= 3 && !have.has(s.phrase) && ![...have].some((k) => (' ' + k + ' ').includes(' ' + s.phrase + ' ')))
    .sort((a, b) => b.weight - a.weight)
    // drop phrases that are just a part of a stronger phrase used by the same extensions
    .filter((s, i, arr) => !arr.slice(0, i).some((t) => t.phrase.includes(s.phrase) && t.extensions >= s.extensions * 0.8))
    .slice(0, limit);
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
  const descs = new Map(); // short descriptions from English search cards, used for keyword ideas
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
      for (const r of results.slice(0, 20)) if (r.desc && !descs.has(r.id) && market.hl.startsWith('en')) descs.set(r.id, r.desc);
      return { market: market.code, keyword, ranks, scanned: results.length, top: results.slice(0, 20).map(({ id, name }) => ({ id, name })) };
    } catch (e) {
      errors.push({ market: market.code, keyword, error: String(e.message || e).slice(0, 200) });
      return { market: market.code, keyword, ranks: null, scanned: 0, top: [] };
    }
  });

  // ---- store page stats (users, ratings) for the extensions in every top 10; refreshed weekly
  const stats = await readJson(path.join(DATA, 'stats.json'), {});
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const statsLimit = Number(process.env.STATS_LIMIT) || 900;
  let statsFetched = 0;
  const refreshStats = async (ids) => {
    const todo = [...new Set(ids)].filter((id) => !stats[id] || !stats[id].fetched || stats[id].fetched < weekAgo)
      .sort((a, b) => (stats[a] ? 1 : 0) - (stats[b] ? 1 : 0)) // never-seen first
      .slice(0, Math.max(0, statsLimit - statsFetched));
    statsFetched += todo.length;
    await pool(todo, concurrency, async (id) => {
      await sleep(jitter(300));
      const m = await fetchMeta(context, id);
      if (m.ok) stats[id] = { name: m.name, users: m.users, ratings: m.ratings, rating: m.rating, category: m.category, fetched: date };
      else if (stats[id]) stats[id].fetched = date; // gone or unavailable: keep old numbers, retry next week
    });
  };
  await refreshStats([...projects.flatMap((p) => p.tracked), ...results.flatMap((r) => r.top.slice(0, 10).map((t) => t.id))]);
  for (const id of new Set(projects.flatMap((p) => p.tracked))) {
    if (stats[id] && extensions[id]) Object.assign(extensions[id], { name: stats[id].name || extensions[id].name });
  }
  for (const [id, d] of descs) if (stats[id]) stats[id].desc = d;
  console.log(`Store page stats: ${statsFetched} pages read, ${Object.keys(stats).length} extensions known.`);

  // ---- keyword ideas per extension, from an English-language market
  await fs.mkdir(path.join(DATA, 'ideas'), { recursive: true });
  const ideaEvalCount = Math.max(0, Number(process.env.IDEAS_TO_TEST) || 12);
  for (const p of projects) {
    const code = p.markets.includes('US') ? 'US' : p.markets.find((c) => (allMarkets.find((m) => m.code === c) || {}).hl?.startsWith('en')) || p.markets[0];
    const market = allMarkets.find((m) => m.code === code);
    try {
      const suggested = {};
      for (const k of p.keywords) suggested[k] = await storeSuggestions(context, k);
      await refreshStats(Object.values(suggested).flat().map((s) => s.id).filter(Boolean));
      const weight = (id) => Math.log10(((stats[id] && stats[id].users) || 0) + 10);
      const docs = new Map();
      for (const r of results) if (r.market === code && p.keywords.includes(r.keyword))
        for (const t of r.top) docs.set(t.id, { id: t.id, text: `${t.name} ${(stats[t.id] && stats[t.id].desc) || descs.get(t.id) || ''}`, weight: weight(t.id) });
      for (const s of Object.values(suggested).flat()) {
        const key = s.id || 'name:' + s.name;
        if (!docs.has(key)) docs.set(key, { id: key, text: s.name, weight: s.id ? weight(s.id) : 1.5 });
      }
      const ideas = mineKeywordIdeas([...docs.values()], p.keywords, 40);
      // test the strongest ideas with a real search to measure demand and your position
      await pool(ideas.slice(0, ideaEvalCount), concurrency, async (idea) => {
        try {
          const { results: res } = await search(context, idea.phrase, market, 50);
          const pos = res.findIndex((r) => r.id === p.id);
          idea.tested = { date, market: code, scanned: res.length, top: res.slice(0, 10).map((r) => r.id), your_rank: pos === -1 ? null : pos + 1 };
          for (const r of res.slice(0, 10)) if (r.desc && stats[r.id] && !stats[r.id].desc) stats[r.id].desc = r.desc;
        } catch {}
      });
      await refreshStats(ideas.flatMap((i) => (i.tested ? i.tested.top : [])));
      const prev = await readJson(path.join(DATA, 'ideas', `${p.id}.json`), null);
      await writeJson(path.join(DATA, 'ideas', `${p.id}.json`), {
        date, market: code,
        ideas: ideas.map((i) => {
          const old = prev && prev.ideas && prev.ideas.find((o) => o.phrase === i.phrase);
          return { ...i, weight: +i.weight.toFixed(2), tested: i.tested || (old && old.tested) || null };
        }),
        store_suggestions: Object.fromEntries(Object.entries(suggested).map(([k, v]) => [k, v.map((s) => s.name)])),
      });
      console.log(`Keyword ideas for ${p.id}: ${ideas.length} found, ${ideas.filter((i) => i.tested).length} tested in ${code}.`);
    } catch (e) {
      console.log(`Keyword ideas for ${p.id} failed: ${e.message || e}`);
    }
  }
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
  await writeJson(path.join(DATA, 'stats.json'), stats);
  await writeJson(path.join(DATA, 'status.json'), status);
  console.log(`Done: ${ok}/${jobs.length} searches succeeded in ${status.seconds}s.`);
  if (ok === 0) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
