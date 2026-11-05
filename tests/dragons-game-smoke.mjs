import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import assert from "node:assert/strict";

const root = process.cwd();
const html = await readFile(resolve(root, "dragons.html"), "utf8");
const index = await readFile(resolve(root, "index.html"), "utf8");
const router = await readFile(resolve(root, "server/dragons-router.js"), "utf8");
const serverSource = await readFile(resolve(root, "server/server.js"), "utf8");

assert.match(index, /id="dragonsEntry"/, "Dragons should be accessible from the ALLCOINS games grid.");
assert.match(index, /href="\.\/dragons\.html\?v=/, "The game tile should open dragons.html.");
assert.match(serverSource, /createDragonRouter/);
assert.match(serverSource, /app\.use\("\/api\/dragons", dragonsRouter\)/);
for (const route of ["/state", "/buy-breeder", "/build-incubator", "/incubate", "/expedition"]) {
  assert.ok(router.includes('router.post("' + route + '"'), "Missing API route " + route);
}
assert.match(router, /balance = balance - \$1/);
assert.match(router, /balance = balance \+ \$1/);

let state = {
  balance: 100000,
  profile: { incubatorBuilt: true, incubatorSlots: 2, raidCooldownHours: 8, lastRaidAt: null, nextRaidAt: null },
  stats: { breeders: 1, defenders: 1, attackers: 1, growing: 0, defensePower: 10 },
  creatures: [
    { id: "11", kind: "breeder", stage: "adult", nextEggAt: new Date(Date.now() + 7200000).toISOString() },
    { id: "12", kind: "defender", stage: "adult" },
    { id: "13", kind: "attacker", stage: "adult" }
  ],
  eggs: [{ id: "21", status: "laid", dragonKind: null, laidAt: new Date().toISOString(), hatchAt: null }]
};
const calls = [];
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url || "/", "http://127.0.0.1:4173").pathname;
  if (pathname === "/dragons.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }
  res.writeHead(404);
  res.end("Not found");
});
await new Promise(resolveListen => server.listen(4173, "127.0.0.1", resolveListen));

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.route("https://telegram.org/**", route => route.fulfill({
    status: 200, contentType: "application/javascript",
    body: "window.Telegram={WebApp:{initData:'mock-init-data',ready(){},expand(){}}};"
  }));
  await page.route("https://allcoins-server.onrender.com/**", async route => {
    const url = new URL(route.request().url());
    let body = {};
    try { body = route.request().postDataJSON() || {}; } catch {}
    calls.push({ path: url.pathname, body });
    if (url.pathname === "/api/dragons/state") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, state }) });
    }
    if (url.pathname === "/api/dragons/buy-breeder") {
      state.balance -= 4500;
      state.stats.breeders += 1;
      state.creatures.push({ id: "14", kind: "breeder", stage: "adult", nextEggAt: new Date(Date.now() + 14400000).toISOString() });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, message: "Дракон куплен", state }) });
    }
    if (url.pathname === "/api/dragons/incubate") {
      state.eggs[0] = { ...state.eggs[0], status: "incubating", dragonKind: body.kind, hatchAt: new Date(Date.now() + 1200000).toISOString() };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, message: "Яйцо отправлено в инкубатор", state }) });
    }
    if (url.pathname === "/api/dragons/expedition") {
      state.balance += 380;
      state.profile.lastRaidAt = new Date().toISOString();
      state.profile.nextRaidAt = Date.now() + 28800000;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, message: "Экспедиция завершена", reward: 380, state }) });
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Unknown route" }) });
  });

  await page.goto("http://127.0.0.1:4173/dragons.html");
  await page.getByRole("heading", { name: "ДРАКОНЫ" }).waitFor();
  await page.getByText("100 000 AC").waitFor().catch(() => {});
  assert.match(await page.locator("#content").innerText(), /Питомник/);
  assert.match(await page.locator("#content").innerText(), /Инкубатор активен/);

  await page.locator('[data-action="buy"]').click();
  await page.waitForFunction(() => document.querySelector("#balance")?.textContent.includes("95"));
  assert.ok(calls.some(call => call.path === "/api/dragons/buy-breeder"));

  await page.locator('[data-action="incubate"][data-kind="attacker"]').click();
  await page.waitForFunction(() => document.querySelector("#content")?.innerText.includes("атакующий"));
  assert.ok(calls.some(call => call.path === "/api/dragons/incubate" && call.body.kind === "attacker"));

  await page.locator('[data-action="expedition"]').click();
  await page.waitForFunction(() => document.querySelector("#balance")?.textContent.includes("95"));
  assert.ok(calls.some(call => call.path === "/api/dragons/expedition"));
  assert.deepEqual(pageErrors, [], "Dragons page should not produce browser JavaScript errors.");
} finally {
  if (browser) await browser.close();
  await new Promise(resolveClose => server.close(resolveClose));
}

console.log("Dragons game smoke test passed.");
