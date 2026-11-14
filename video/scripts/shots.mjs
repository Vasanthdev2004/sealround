// Captures real screens for the video from the testnet-mode app and NearBlocks.
// Usage: node scripts/shots.mjs [name ...]   (APP defaults to http://localhost:3007)
// Saves PNGs at 2x into public/shots/. Read-only: nothing here signs or sends.

import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "../public/shots");
mkdirSync(outDir, { recursive: true });
const APP = process.env.APP ?? "http://localhost:3007";
const NB = "https://testnet.nearblocks.io";

const shots = [
  { name: "landing", url: `${APP}/`, wait: 6000, full: true },
  { name: "sale", url: `${APP}/sale/swarm-11141341`, wait: 12000, full: true },
  { name: "result", url: `${APP}/sale/swarm-11141341/result`, wait: 16000, full: true },
  { name: "token", url: `${APP}/token/swarm-11141341`, wait: 12000, full: true },
  { name: "ember-result", url: `${APP}/sale/ember-11141303/result`, wait: 14000, full: true },
  { name: "ember-token", url: `${APP}/token/ember-11141303`, wait: 12000, full: true },
  { name: "verify", url: `${APP}/verify/swarm-11141341`, wait: 25000, full: true },
  { name: "judges", url: `${APP}/judges`, wait: 4000, full: true, click: "Run all", after: 45000 },
  { name: "win-card", url: `${APP}/api/og/win?sale=swarm-11141341&win=1`, wait: 3000, viewport: { width: 1200, height: 630 }, scale: 2 },
  { name: "r-timeline", url: `${APP}/sale/swarm-11141341/result`, wait: 14000, focus: "Early or late" },
  { name: "r-verified", url: `${APP}/sale/swarm-11141341/result`, wait: 20000, focus: "18 of 18 checks passed", offset: 160 },
  { name: "r-pool", url: `${APP}/sale/swarm-11141341/result`, wait: 14000, focus: "of the raise, opened at the clearing price", offset: 190 },
  { name: "r-fills", url: `${APP}/sale/swarm-11141341/result`, wait: 14000, focus: "Every bid's public outcome", offset: 150 },
  { name: "e-supply", url: `${APP}/sale/ember-11141303/result`, wait: 14000, focus: "Where every token went" },
  { name: "v-checks", url: `${APP}/verify/swarm-11141341`, wait: 25000, focus: "18 of 18 checks passed", offset: 200 },
  { name: "nb-sniper", url: `${NB}/txns/8uqH7EC2EYkbckqKtUzVGh48xmgTphebNJLNv73H7GLe`, wait: 8000 },
  { name: "nb-late", url: `${NB}/txns/8XFzD4Yrtz7A6MzH13yLmQKR5r9RfcyDCsAj2rj1Hz9y`, wait: 8000 },
  { name: "nb-lock", url: `${NB}/address/sealround.itzbeast.testnet`, wait: 8000, full: true },
  { name: "nb-burn", url: `${NB}/txns/9Ut1yPxYms5aD8W8ZaPaRMsP365RxC6Y8CRkGLeLppc5`, wait: 8000, full: true },
];

const only = process.argv.slice(2);
const browser = await chromium.launch({ channel: "msedge", headless: true });
for (const s of shots) {
  if (only.length && !only.includes(s.name)) continue;
  const ctx = await browser.newContext({
    viewport: s.viewport ?? { width: 1440, height: 900 },
    deviceScaleFactor: s.scale ?? 2,
    colorScheme: "dark",
    reducedMotion: "no-preference",
  });
  const page = await ctx.newPage();
  const t0 = Date.now();
  try {
    await page.goto(s.url, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(s.wait);
    await page.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => {});
    if (s.focus) {
      const el = page.getByText(s.focus).first();
      await el.scrollIntoViewIfNeeded({ timeout: 30000 });
      const y = await el.evaluate((n) => n.getBoundingClientRect().top + window.scrollY);
      await page.evaluate((top) => window.scrollTo(0, top), y - (s.offset ?? 110));
      await page.waitForTimeout(2500);
    }
    if (s.click) {
      await page.getByRole("button", { name: s.click }).first().click();
      await page.waitForTimeout(s.after ?? 10000);
    }
    await page.screenshot({ path: join(outDir, `${s.name}.png`) });
    if (s.full) await page.screenshot({ path: join(outDir, `${s.name}-full.png`), fullPage: true });
    const h = await page.evaluate(() => document.documentElement.scrollHeight);
    console.log(`${s.name}: ok in ${((Date.now() - t0) / 1000).toFixed(1)} s, page height ${h}`);
  } catch (e) {
    console.log(`${s.name}: FAILED ${e.message.split("\n")[0]}`);
  }
  await ctx.close();
}
await browser.close();
