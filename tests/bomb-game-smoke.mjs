import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import assert from "node:assert/strict";

const root = process.cwd();
const bombHtml = await readFile(resolve(root, "bomb.html"), "utf8");
const indexHtml = await readFile(resolve(root, "index.html"), "utf8");

const bombTile = indexHtml.indexOf('id="bombEntry"');
assert.ok(bombTile >= 0, "The Games menu must include the Pass the Bomb tile.");
assert.ok(indexHtml.includes('href="./bomb.html?v=20261025-bomb1"'),
  "The game link should remain stable.");
assert.ok(indexHtml.indexOf('id="durakEntry"') < bombTile &&
  bombTile < indexHtml.indexOf('id="unoEntry"'),
  "Pass the Bomb should appear in the first row after Durak.");
assert.ok(bombHtml.includes("function startGame()") && bombHtml.includes("function passBombFromBot(target)"),
  "The standalone game must include its start and bot-pass logic.");
assert.ok(bombHtml.includes('<svg class="mine-scene"') &&
  bombHtml.includes('data-map="copper"') && bombHtml.includes('data-map="crystal"'),
  "The game should include original inline mine artwork and two selectable original maps.");
assert.ok(!/<img[^>]+src=["']https?:\/\//i.test(bombHtml),
  "The mine artwork should not depend on copied or remotely hosted image assets.");

const server = createServer((req, res) => {
  const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
  if (pathname === "/" || pathname === "/bomb.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(bombHtml);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found");
});
await new Promise((resolveListen) => server.listen(4175, "127.0.0.1", resolveListen));

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true
  });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("https://telegram.org/**", (route) => route.fulfill({
    status: 200,
    contentType: "application/javascript",
    body: "window.Telegram = { WebApp: { ready(){}, expand(){}, BackButton: { show(){}, hide(){}, onClick(){} } } };"
  }));
  await page.goto("http://127.0.0.1:4175/bomb.html", {
    waitUntil: "domcontentloaded",
    timeout: 30000
  });
  assert.equal(await page.title(), "Передай бомбу — ALLCOINS");
  assert.equal(await page.locator("#setupView").isVisible(), true);
  assert.equal(await page.locator("#startGame").isVisible(), true);
  assert.equal(await page.locator("#mapControl [data-map]").count(), 2,
    "The lobby should offer two original selectable map cards.");
  await page.locator('#mapControl [data-map="crystal"]').click();
  assert.equal(await page.locator('#mapControl [data-map="crystal"]').getAttribute("aria-pressed"), "true",
    "Selecting a map should visibly update the selected state.");

  for (const count of [2, 3, 4]) {
    await page.locator('#playerCountControl button[data-count="' + count + '"]').click();
    await page.locator('#modeControl button[data-mode="local"]').click();
    await page.locator("#startGame").click();
    await page.locator("#gameView").waitFor({ state: "visible" });
    assert.equal(await page.locator("#seats .seat").count(), count,
      "Selecting " + count + " players should create exactly " + count + " seats.");
    const arena = await page.locator("#arena").boundingBox();
    assert.ok(arena && arena.width >= 300, "The game arena should fit a mobile viewport.");
    assert.equal(await page.locator("#arena").getAttribute("data-map"), "crystal",
      "The selected map should be applied to the full-screen game arena.");
    await page.locator("#gameBack").click();
  }

  await page.locator('#playerCountControl button[data-count="4"]').click();
  await page.locator('#modeControl button[data-mode="local"]').click();
  await page.locator("#startGame").click();
  const previousHolder = await page.locator("#seats .seat.current").getAttribute("data-player");
  const target = previousHolder !== "0" ? "0" : "1";
  const beforePass = await page.locator("#bomb").boundingBox();
  await page.locator('#seats .seat[data-player="' + target + '"]').click();
  await page.waitForTimeout(600);
  assert.equal(await page.locator("#seats .seat.current").getAttribute("data-player"), target,
    "Passing the bomb should transfer possession to the selected player.");
  const afterPass = await page.locator("#bomb").boundingBox();
  assert.ok(beforePass && afterPass, "The bomb should remain visible during and after a pass.");

  const heartsBefore = await page.locator(
    '#seats .seat[data-player="' + target + '"] .lives .heart.on'
  ).count();
  // The fuse lasts at most 15.4 seconds. Allow extra time for the result overlay.
  await page.waitForTimeout(16300);
  assert.equal(await page.locator("#resultOverlay").isVisible(), true,
    "The fuse should end with an explosion result.");
  assert.ok(["БУМ!", "ПОБЕДА!"].includes(await page.locator("#resultTitle").innerText()));
  const heartsAfter = await page.locator(
    '#seats .seat[data-player="' + target + '"] .lives .heart.on'
  ).count();
  assert.equal(heartsAfter, heartsBefore - 1,
    "The player who holds the bomb at explosion must visibly lose one heart.");
  assert.equal(await page.locator("#resultPrimary").innerText(), "Следующий раунд");
  await page.locator("#resultPrimary").click();
  assert.equal(await page.locator("#roundLabel").innerText(), "2",
    "The next round should start and be numbered correctly.");

  await page.locator("#gameBack").click();
  await page.locator('#playerCountControl button[data-count="4"]').click();
  await page.locator('#modeControl button[data-mode="bots"]').click();
  await page.evaluate(() => { Math.random = () => 0.9999; });
  await page.locator("#startGame").click();
  const botHolder = await page.locator("#seats .seat.current").getAttribute("data-player");
  assert.ok(["1", "2", "3"].includes(botHolder), "Deterministic setup should start with a bot holding the bomb.");
  await page.waitForTimeout(2200);
  const nextHolder = await page.locator("#seats .seat.current").getAttribute("data-player");
  assert.notEqual(nextHolder, botHolder, "A bot should automatically pass the bomb after its decision delay.");

  await page.setViewportSize({ width: 320, height: 700 });
  const dimensions = await page.locator("#gameView").evaluate((el) => ({
    clientWidth: el.clientWidth,
    scrollWidth: el.scrollWidth
  }));
  assert.ok(dimensions.scrollWidth <= dimensions.clientWidth + 2,
    "The game should not create horizontal overflow on a narrow phone.");
  await page.locator("#gameBack").click();
  assert.equal(await page.locator("#setupView").isVisible(), true,
    "The game should return to setup without leaving the app page.");
  assert.deepEqual(pageErrors, [], "The game should not throw browser runtime errors.");
  console.log("Pass the Bomb smoke test passed: lobby, 2/3/4 seats, transfer, explosion/lives, next round, bot transfer and 320px mobile layout.");
} finally {
  if (browser) await browser.close();
  await new Promise((resolveClose, rejectClose) => server.close((err) => err ? rejectClose(err) : resolveClose()));
}
