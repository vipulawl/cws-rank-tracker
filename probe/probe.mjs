import { chromium } from 'playwright';
import fs from 'node:fs/promises';
const out = 'probe/out'; await fs.mkdir(out, { recursive: true });
const log = []; const L = (...a) => { log.push(a.map((x) => typeof x === 'string' ? x : JSON.stringify(x, null, 1)).join(' ')); };
const b = await chromium.launch();
const ctx = await b.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', viewport: { width: 1366, height: 900 } });
const p = await ctx.newPage();
// 1. search cards
await p.goto('https://chromewebstore.google.com/search/aeo%20audit?hl=en&gl=US', { waitUntil: 'domcontentloaded' });
await p.waitForSelector('a[href*="/detail/"]', { timeout: 25000 }).catch(() => {});
await p.waitForTimeout(1500);
L('=== SEARCH PAGE TEXT (first 2500) ===', (await p.evaluate(() => document.body.innerText)).slice(0, 2500));
L('=== FIRST CARD HTML ===', await p.evaluate(() => { const a = document.querySelector('a[href*="/detail/"]'); let c = a; for (let i = 0; i < 6 && c.parentElement; i++) c = c.parentElement; return c.outerHTML.slice(0, 5000); }));
L('=== RESULT COUNT TEXT ===', await p.evaluate(() => [...document.querySelectorAll('h1,h2,[role=heading]')].map((h) => h.innerText).slice(0, 10)));
await p.screenshot({ path: out + '/search.png' });
// 2. detail pages
for (const id of ['mmiagdcijcmncoifmehfodelnkdbfcoo', 'chphlpgkkbolifaimnlloiipkdnihall']) {
  await p.goto(`https://chromewebstore.google.com/detail/${id}?hl=en`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2000);
  L(`=== DETAIL ${id} TEXT ===`, (await p.evaluate(() => document.body.innerText)).slice(0, 2500));
  L('=== DETAIL META ===', await p.evaluate(() => [...document.querySelectorAll('meta')].map((m) => (m.getAttribute('property') || m.getAttribute('name') || m.getAttribute('itemprop')) + '=' + (m.content || '').slice(0, 150)).filter((x) => !x.startsWith('null'))));
  L('=== JSON-LD ===', await p.evaluate(() => [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent.slice(0, 1500))));
}
// 3. autocomplete
const net = [];
p.on('response', async (r) => { const u = r.url(); if (/batchexecute|suggest|complete/i.test(u)) { let body = ''; try { body = (await r.text()).slice(0, 1500); } catch {} net.push({ u: u.slice(0, 300), post: (r.request().postData() || '').slice(0, 600), body }); } });
for (const [hl, q] of [['en', 'reddit'], ['de', 'tab']]) {
  net.length = 0;
  await p.goto(`https://chromewebstore.google.com/?hl=${hl}`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2500);
  const inputs = await p.evaluate(() => [...document.querySelectorAll('input')].map((i) => ({ type: i.type, aria: i.getAttribute('aria-label'), ph: i.placeholder, vis: !!i.offsetParent })));
  L(`=== INPUTS (${hl}) ===`, inputs);
  const input = p.locator('input[type="search"], input[aria-label*="earch"], input[aria-label*="uche"], input').first();
  await input.click().catch((e) => L('click err', String(e)));
  await input.pressSequentially(q, { delay: 150 }).catch((e) => L('type err', String(e)));
  await p.waitForTimeout(2500);
  L(`=== SUGGESTION DOM (${hl} "${q}") ===`, await p.evaluate(() => [...document.querySelectorAll('[role=option], [role=listbox] li, li[data-suggestion], ul li')].map((o) => (o.innerText || '').trim()).filter(Boolean).slice(0, 30)));
  L('=== SUGGEST NET ===', net.slice(-6));
  await p.screenshot({ path: out + `/suggest-${hl}.png` });
}
await b.close();
await fs.writeFile(out + '/log.txt', log.join('\n\n'));
