import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { chromium } from "playwright";
import assert from "node:assert/strict";

const root = process.cwd();
const html = await readFile(resolve(root, "index.html"));
const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
});
await new Promise((resolveListen) => server.listen(4173, "127.0.0.1", resolveListen));

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.route("https://telegram.org/**", (route) => route.fulfill({
    status: 200,
    contentType: "application/javascript",
    body: "window.Telegram = { WebApp: { initData: '', initDataUnsafe: {}, ready(){}, expand(){}, colorScheme:'dark' } };"
  }));
  await page.route("https://sad.adsgram.ai/**", (route) => route.fulfill({
    status: 200, contentType: "application/javascript", body: ""
  }));
  await page.route("https://allcoins-server.onrender.com/**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: false, rooms: [], player: null })
  }));

  await page.goto("http://127.0.0.1:4173", { waitUntil: "domcontentloaded" });
  await page.locator("#tapButton").waitFor();

  // Main clicker updates balance and energy in demo mode.
  const initialBalance = Number((await page.locator("#balance").innerText()).replace(/\D/g, ""));
  const initialEnergy = Number((await page.locator("#energy").innerText()).replace(/\D/g, ""));
  await page.locator("#tapButton").click();
  await page.waitForFunction(() => document.querySelector("#energy")?.textContent?.trim() === "99");
  const newBalance = Number((await page.locator("#balance").innerText()).replace(/\D/g, ""));
  assert.equal(newBalance, initialBalance + 100, "tap should add 100 AC");
  assert.equal(Number((await page.locator("#energy").innerText()).replace(/\D/g, "")), initialEnergy - 1, "tap should consume 1 energy");

  // Bottom navigation must open each section.
  for (const section of ["games", "withdraw", "profile", "home"]) {
    await page.locator(`.nav button[data-page="${section}"]`).click();
    assert.equal(await page.locator(`#${section}`).evaluate((el) => el.classList.contains("hidden")), false,
      `navigation should show #${section}`);
  }

  // Durak test controls and table container must exist.
  await page.locator('.nav button[data-page="games"]').click();
  assert.equal(await page.locator("#durakGame").count(), 1, "Durak game section should exist");
  assert.equal(await page.locator("#durakTable").count(), 1, "Durak table should exist");
  assert.equal(await page.locator("#durakAddBotButton").count(), 1, "test bot button should exist");

  assert.deepEqual(pageErrors, [], "page should not produce JavaScript errors");
  console.log("PASS: clicker, energy, bottom navigation, Durak table, bot control, no page errors");
} finally {
  if (browser) await browser.close();
  await new Promise((resolveClose, rejectClose) => server.close((err) => err ? rejectClose(err) : resolveClose()));
}
