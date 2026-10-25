import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import assert from "node:assert/strict";

const html = await readFile(resolve(process.cwd(), "towers.html"), "utf8");
const index = await readFile(resolve(process.cwd(), "index.html"), "utf8");
assert.ok(index.includes('id="towersEntry"') && index.includes('href="./towers.html?v=20261025-tower-roads2"'),
  "The Games menu should link to Towers Capture.");
assert.ok(html.includes('id="gameView"') && html.includes('id="practice"') &&
  html.includes('id="stakeInput"') && html.includes('id="playersInput"'),
  "The game needs a fullscreen battlefield, bot practice and room options.");
assert.ok(html.includes("Стратегия в реальном времени") && html.includes("function localTick()"),
  "The game should implement real-time tower control and local practice.");

const server = createServer((req, res) => {
  const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
  if (pathname === "/towers.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }
  res.writeHead(404); res.end("Not found");
});
await new Promise(resolveListen => server.listen(4175, "127.0.0.1", resolveListen));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const errors = [];
  await page.route("https://telegram.org/**", route => route.fulfill({
    status: 200, contentType: "application/javascript", body: `
      window.Telegram={WebApp:{initData:"mock-init-data",initDataUnsafe:{user:{id:12345,first_name:"Тестовый игрок"}},ready(){},expand(){},setHeaderColor(){},setBackgroundColor(){},requestFullscreen(){window.__fullscreenRequests=(window.__fullscreenRequests||0)+1;return Promise.resolve();},BackButton:{show(){},hide(){},onClick(){}}}};
    `
  }));
  await page.route("https://allcoins-server.onrender.com/**", route => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, rooms: [] })
  }));
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("http://127.0.0.1:4175/towers.html", { waitUntil: "domcontentloaded" });
  await page.locator("#practice").waitFor();
  await page.locator("#practice").click();
  await page.locator("#gameView:not(.hidden)").waitFor();
  assert.ok(await page.evaluate(() => (window.__fullscreenRequests || 0) >= 1), "Starting a match should request Telegram fullscreen.");
  await page.locator(".tower[data-tower='1']").waitFor();
  assert.equal(await page.locator(".tower").count(), 9, "Practice mode should draw nine towers.");
  await page.locator(".tower[data-tower='1']").click();
  await page.locator(".tower[data-tower='4']").click();
  await page.locator(".fleet").first().waitFor({ timeout: 3000 });
  await page.locator(".tower[data-tower='1']").click();
  await page.locator(".tower[data-tower='5']").click();
  await page.waitForFunction(() => document.querySelectorAll("#fleets .fleet").length >= 2, null, { timeout: 3000 });
  assert.ok(await page.locator("#routeSvg .road-group").count() >= 2, "Multiple attacks should leave multiple asphalt roads on the map.");
  assert.ok(await page.locator("#routeSvg line.road-asphalt").count() >= 2, "Each route should have an asphalt road surface.");
  assert.ok(await page.locator("#fleets .fleet-soldier").count() >= 6, "Armies on multiple roads should contain animated soldier figures.");

  assert.deepEqual(errors, [], "The Towers Capture page should not throw browser errors.");
} finally {
  await browser?.close();
  await new Promise(resolveClose => server.close(resolveClose));
}
console.log("Towers Capture mobile smoke test passed.");
