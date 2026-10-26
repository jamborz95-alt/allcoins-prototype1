import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { chromium } from "playwright";
import assert from "node:assert/strict";

const root = process.cwd();
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const absolute = resolve(root, relative);
    if (!absolute.startsWith(root + "/")) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    const data = await readFile(absolute);
    const ext = extname(absolute);
    const type = ext === ".html" ? "text/html; charset=utf-8" :
      ext === ".js" || ext === ".mjs" ? "text/javascript; charset=utf-8" :
      ext === ".css" ? "text/css; charset=utf-8" : "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});
await new Promise(resolveListen => server.listen(4175, "127.0.0.1", resolveListen));

let browser;
const contexts = [];
try {
  browser = await chromium.launch({ headless: true });

  async function makePage(userId, firstName) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    contexts.push(context);
    const page = await context.newPage();
    const pageErrors = [];
    const apiCalls = [];
    page.on("pageerror", error => pageErrors.push(error.message));

    await page.route("https://telegram.org/**", route => route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: "window.Telegram={WebApp:{initData:'mock-user-" + userId +
        "',initDataUnsafe:{user:{id:" + userId + ",first_name:" + JSON.stringify(firstName) +
        ",username:'tester" + userId + "'}},ready(){},expand(){},colorScheme:'dark'," +
        "HapticFeedback:{selectionChanged(){},notificationOccurred(){}}}};"
    }));
    await page.route("https://sad.adsgram.ai/**", route => route.fulfill({
      status: 200, contentType: "application/javascript", body: ""
    }));
    await page.route("https://allcoins-server.onrender.com/**", async route => {
      const request = route.request();
      const url = new URL(request.url());
      let body = {};
      try { body = request.postDataJSON() || {}; } catch {}
      apiCalls.push({ path: url.pathname, body });
      const json = (data, status = 200) => route.fulfill({
        status, contentType: "application/json", body: JSON.stringify(data)
      });

      if (url.pathname === "/api/auth") {
        return json({ ok: true, player: {
          telegram_id: String(userId), first_name: firstName, username: "tester" + userId,
          balance: 10000, energy: 100
        } });
      }
      if (url.pathname === "/api/admin/summary") {
        if (userId !== 999) return json({ ok: false, error: "Доступ только для администратора." }, 403);
        return json({
          ok: true, admin: true, totalCommission: 0, totalGross: 0, gamesCount: 0,
          adminBalance: 10000, recent: []
        });
      }
      if (url.pathname === "/api/support/submit") {
        return json({ ok: true, ticketId: "15", status: "open", message: "Обращение сохранено." }, 201);
      }
      if (url.pathname === "/api/support/admin/list") {
        if (userId !== 999) return json({ ok: false, error: "Доступ только для администратора." }, 403);
        return json({
          ok: true, admin: true,
          counts: { total: 1, open: 1, in_progress: 0, resolved: 0 },
          tickets: [{
            id: "15", telegram_id: "123", username: "player123", first_name: "Игрок",
            category: "Зависание / тормоза",
            description: "Во время хода противника анимация зависает.",
            status: "open",
            ai_summary: "Приоритет: средний\nКратко: похоже на проблему анимации.\nЧто проверить: шаги воспроизведения.\nНужен разработчик: да",
            ai_severity: "средний", needs_developer: true,
            notification_status: "sent", created_at: "2026-10-26T10:00:00.000Z"
          }]
        });
      }
      if (url.pathname === "/api/support/admin/status") {
        if (userId !== 999) return json({ ok: false, error: "Доступ только для администратора." }, 403);
        return json({ ok: true, ticketId: String(body.ticketId), status: body.status });
      }
      if (url.pathname === "/api/health") return json({ ok: true, database: "connected" });
      if (url.pathname === "/api/durak/rooms/list") return json({ ok: true, rooms: [] });
      return json({ ok: true, rooms: [], balance: 10000 });
    });
    return { page, apiCalls, pageErrors };
  }

  // Player flow: open support form and submit a report, without exposing API secrets.
  const player = await makePage(123, "Игрок");
  await player.page.goto("http://127.0.0.1:4175/index.html", { waitUntil: "domcontentloaded" });
  await player.page.locator("#profileName").waitFor();
  await player.page.locator('.nav button[data-page="profile"]').click();
  await player.page.locator("#supportOpenButton").click();
  await player.page.locator("#supportFormPanel:not(.hidden)").waitFor();
  await player.page.locator("#supportCategory").selectOption("Карты / анимация");
  await player.page.locator("#supportDescription").fill("В УНО карта исчезает на секунду и появляется снова.");
  await player.page.locator("#supportSubmitButton").click();
  await player.page.getByText(/Заявка #15 принята/).waitFor();
  const submitCall = player.apiCalls.find(item => item.path === "/api/support/submit");
  assert.equal(submitCall?.body?.category, "Карты / анимация");
  assert.equal(submitCall?.body?.description, "В УНО карта исчезает на секунду и появляется снова.");
  assert.equal(submitCall?.body?.initData, "mock-user-123");
  assert.deepEqual(player.pageErrors, [], "Player support form should not produce JavaScript errors.");

  // Owner flow: support inbox is admin-only, shows AI triage and report-copy/status actions.
  const owner = await makePage(999, "Владелец");
  await owner.page.goto("http://127.0.0.1:4175/index.html", { waitUntil: "domcontentloaded" });
  await owner.page.locator("#profileName").waitFor();
  await owner.page.locator('.nav button[data-page="profile"]').click();
  await owner.page.locator("#adminSupportCard:not(.hidden)").waitFor();
  await owner.page.getByText("Диагностика ALLCOINS ИИ:", { exact: false }).waitFor();
  assert.equal(await owner.page.getByRole("button", { name: "📋 Копировать отчёт для ChatGPT" }).count(), 1);
  await owner.page.getByRole("button", { name: "✓ Решено" }).click();
  await owner.page.waitForFunction(() =>
    document.querySelector("#adminSupportStatus")?.textContent.includes("Статус обращения #15 обновлён.")
  );
  assert.ok(owner.apiCalls.some(item => item.path === "/api/support/admin/list"));
  assert.ok(owner.apiCalls.some(item => item.path === "/api/support/admin/status" && item.body.status === "resolved"));
  assert.deepEqual(owner.pageErrors, [], "Owner support inbox should not produce JavaScript errors.");

  console.log("PASS: support UI opens, submits a player issue, and lets the authorized owner review AI triage, copy a ChatGPT-ready report, and resolve the ticket.");
} finally {
  if (browser) await browser.close();
  await Promise.all(contexts.map(context => context.close().catch(() => {})));
  await new Promise(resolveClose => server.close(resolveClose));
}
