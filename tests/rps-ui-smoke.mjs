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
await new Promise(resolveListen => server.listen(4174, "127.0.0.1", resolveListen));

let browser;
const contexts = [];
try {
  browser = await chromium.launch({ headless: true });

  async function newPlayerPage(userId, firstName) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    contexts.push(context);
    const page = await context.newPage();
    const pageErrors = [];
    const apiCalls = [];
    let mockBotAdded = false;
    let mockChoiceMade = false;
    page.on("pageerror", error => pageErrors.push(error.message));

    await page.route("https://telegram.org/**", route => route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: "window.Telegram={WebApp:{initData:'mock-user-" + userId + "',initDataUnsafe:{user:{id:" +
        userId + ",first_name:" + JSON.stringify(firstName) +
        "}},ready(){},expand(){},colorScheme:'dark'}};"
    }));
    await page.route("https://allcoins-server.onrender.com/**", async route => {
      const request = route.request();
      const url = new URL(request.url());
      let body = {};
      try { body = request.postDataJSON() || {}; } catch {}
      apiCalls.push({ path: url.pathname, body });

      const json = (data, status = 200) => route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(data)
      });
      if (url.pathname === "/api/auth") {
        return json({ ok: true, player: {
          telegram_id: String(userId), first_name: firstName, balance: 10000, energy: 100
        } });
      }
      if (url.pathname === "/api/rps/rooms/list") {
        const rooms = userId === 303 ? [{
          id: "77", name: "Комната КНБ", stake: 100, status: "playing",
          currentRound: 3, playersCount: 2, maxPlayers: 3, isMember: false, isOwner: false
        }] : [];
        return json({ ok: true, balance: 10000, rooms });
      }
      if (url.pathname === "/api/rps/rooms/create") {
        return json({ ok: true, roomId: "42", message: "Комната создана." });
      }
      if (url.pathname === "/api/rps/rooms/join") {
        return json({ ok: true, roomId: String(body.roomId), joinedRound: 4 });
      }
      if (url.pathname === "/api/rps/rooms/add-bot") {
        mockBotAdded = true;
        return json({ ok: true, roomId: String(body.roomId), message: "Бот добавлен; баланс не меняется." });
      }
      if (url.pathname === "/api/rps/rooms/state") {
        if (String(body.roomId) === "42" && userId === 101) {
          if (!mockBotAdded) {
            return json({
              ok: true, balance: 10000,
              room: {
                id: "42", name: "Комната КНБ", ownerTelegramId: "101", stake: 500,
                maxPlayers: 3, status: "waiting", currentRound: 1, playersCount: 1,
                isOwner: true, hasBot: false, testMode: false,
                players: [{
                  telegramId: "101", displayName: "Первый Игрок", joinedRound: 1,
                  isMe: true, isOwner: true, isBot: false, inCurrentRound: false, waitingNextRound: false,
                  hasSubmitted: false
                }]
              },
              round: null, lastResult: null
            });
          }
          return json({
            ok: true, balance: 10000,
            room: {
              id: "42", name: "Комната КНБ", ownerTelegramId: "101", stake: 500,
              maxPlayers: 3, status: "playing", currentRound: mockChoiceMade ? 2 : 1, playersCount: 2,
              isOwner: true, hasBot: true, testMode: true,
              players: [
                { telegramId: "101", displayName: "Первый Игрок", joinedRound: 1,
                  isMe: true, isOwner: true, isBot: false, inCurrentRound: true, waitingNextRound: false, hasSubmitted: false },
                { telegramId: "0", displayName: "🤖 Бот проверки", joinedRound: 1,
                  isMe: false, isOwner: false, isBot: true, inCurrentRound: true, waitingNextRound: false, hasSubmitted: false }
              ]
            },
            round: { number: mockChoiceMade ? 2 : 1, status: "playing", participantIds: ["101", "0"], submittedIds: [], submittedCount: 0, submittedByMe: false, canChoose: true },
            lastResult: mockChoiceMade ? {
              roundNumber: 1, outcome: "win", winningChoice: "rock",
              winnerTelegramIds: ["101"], winnerLabels: ["Первый Игрок"],
              choices: [
                { telegramId: "101", label: "Первый Игрок", choice: "rock", choiceLabel: "Камень", symbol: "✊" },
                { telegramId: "0", label: "🤖 Бот проверки", choice: "scissors", choiceLabel: "Ножницы", symbol: "✌️" }
              ],
              pot: 0, stake: 500, testMode: true, payouts: [], finishedAt: new Date().toISOString()
            } : null
          });
        }
        if (String(body.roomId) === "77" && userId === 303) {
          return json({
            ok: true, balance: 10000,
            room: {
              id: "77", name: "Комната КНБ", ownerTelegramId: "101", stake: 100,
              maxPlayers: 3, status: "playing", currentRound: 3, playersCount: 3,
              isOwner: false,
              players: [
                { telegramId: "101", displayName: "Первый Игрок", joinedRound: 1,
                  isMe: false, isOwner: true, inCurrentRound: true, waitingNextRound: false, hasSubmitted: true },
                { telegramId: "202", displayName: "Второй Игрок", joinedRound: 1,
                  isMe: false, isOwner: false, inCurrentRound: true, waitingNextRound: false, hasSubmitted: false },
                { telegramId: "303", displayName: "Третий Игрок", joinedRound: 4,
                  isMe: true, isOwner: false, inCurrentRound: false, waitingNextRound: true, hasSubmitted: false }
              ]
            },
            round: {
              number: 3, status: "playing", participantIds: ["101", "202"],
              submittedIds: ["101"], submittedCount: 1, submittedByMe: false, canChoose: false
            },
            lastResult: null
          });
        }
        return json({ ok: false, error: "Unexpected room id" }, 404);
      }
      if (url.pathname === "/api/rps/rooms/leave") {
        return json({ ok: true, message: "Ты вышел из комнаты." });
      }
      if (url.pathname === "/api/rps/rooms/choose") {
        mockChoiceMade = true;
        return json({ ok: true, resolved: true, result: { testMode: true } });
      }
      return json({ ok: true, balance: 10000, rooms: [] });
    });
    return { page, apiCalls, pageErrors };
  }

  // The new entry must open as its own page from the existing Games grid.
  const owner = await newPlayerPage(101, "Первый Игрок");
  await owner.page.goto("http://127.0.0.1:4174/index.html", { waitUntil: "domcontentloaded" });
  await owner.page.locator('.nav button[data-page="games"]').click();
  assert.equal(await owner.page.locator("#rpsEntry").count(), 1, "Новая игра должна быть в сетке игр");
  await Promise.all([
    owner.page.waitForURL(/\/rps\.html\?/),
    owner.page.locator("#openRps").click()
  ]);
  await owner.page.locator("#stakeInput").waitFor();
  await owner.page.locator("#stakeInput").fill("500");
  await owner.page.locator("#createRoom").click();
  await owner.page.getByText("Ждём второго игрока", { exact: false }).waitFor();
  const createCall = owner.apiCalls.find(call => call.path === "/api/rps/rooms/create");
  assert.equal(createCall?.body?.stake, 500, "Комната должна получать заданную ставку числом");
  assert.equal(await owner.page.locator("#roomNumber").innerText(), "Комната #42");
  await owner.page.locator("[data-add-bot]").click();
  await owner.page.locator("[data-choice]").first().waitFor();
  assert.ok(owner.apiCalls.some(call => call.path === "/api/rps/rooms/add-bot"), "Кнопка должна отправить запрос добавления бота");
  assert.equal(await owner.page.getByText("Бот проверки", { exact: false }).count() > 0, true, "Бот должен отображаться среди игроков");
  assert.equal(await owner.page.locator("[data-choice]").count(), 3, "После добавления бота должны отображаться три жеста");
  await owner.page.locator('[data-choice="rock"]').click();
  await owner.page.getByText("Тестовый раунд с ботом. Баланс AC не изменён.", { exact: false }).waitFor();
  assert.equal(await owner.page.locator("#topBalance").innerText(), "10 000",
    "Тестовый раунд с ботом не должен менять баланс пользователя");
  assert.ok(owner.apiCalls.some(call => call.path === "/api/rps/rooms/choose"),
    "Ход пользователя должен быть отправлен на API");
  assert.deepEqual(owner.pageErrors, [], "Не должно быть ошибок JavaScript в сценарии создания комнаты, бота и тестового раунда");

  // A third entrant can join an active room but is not offered a move until the next round.
  const third = await newPlayerPage(303, "Третий Игрок");
  await third.page.goto("http://127.0.0.1:4174/rps.html?v=test");
  await third.page.locator('[data-join-room="77"]').click();
  await third.page.getByText("Со следующего раунда", { exact: false }).first().waitFor();
  await third.page.getByText("Ты подключился во время текущего раунда", { exact: false }).waitFor();
  assert.equal(await third.page.locator("[data-choice]").count(), 0,
    "Третий игрок не должен получать ход в середине уже начавшегося раунда");
  assert.ok(third.apiCalls.some(call => call.path === "/api/rps/rooms/join"),
    "Присоединение к комнате должно быть отправлено на API");
  assert.deepEqual(third.pageErrors, [], "Не должно быть ошибок JavaScript у третьего игрока");

  console.log("PASS: RPS game opens from Games, creates a room, adds the test bot, finishes a practice round without changing AC, and keeps a third player for the next round.");
} finally {
  if (browser) await browser.close();
  await Promise.all(contexts.map(context => context.close().catch(() => {})));
  await new Promise(resolveClose => server.close(resolveClose));
}
