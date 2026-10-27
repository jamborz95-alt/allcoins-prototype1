import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createCheckersGame, applyCheckersStep } from "../server/checkers-game.js";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

async function startStaticServer() {
  const server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
      const path = resolve(root, "." + pathname);
      if (!path.startsWith(root)) {
        res.writeHead(403).end();
        return;
      }
      const data = await readFile(path);
      res.writeHead(200, { "Content-Type": mime[extname(path)] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(data);
    } catch {
      res.writeHead(404).end("Not found");
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

function makeRoom(shared, userId) {
  const room = shared.room;
  return {
    id: "SH-" + room.id,
    roomId: String(room.id),
    name: "Комната шашек",
    stake: 100,
    owner: room.ownerName,
    isOwner: String(userId) === String(room.ownerId),
    status: room.status === "waiting" ? "Ожидает игрока" : room.status === "playing" ? "Партия идёт" : "Завершена",
    statusCode: room.status,
    playersCount: room.players.length,
    maxPlayers: 2,
    createdAt: "2026-10-27T05:00:00.000Z"
  };
}

function publicGame(shared, userId) {
  const game = shared.game;
  if (!game) return null;
  const me = game.players.find(player => String(player.telegramId) === String(userId));
  const current = game.players.find(player => String(player.telegramId) === String(game.turnTelegramId));
  return {
    board: game.board,
    turn: game.turn,
    status: game.status,
    winner: game.winner || null,
    lastMove: game.lastMove || null,
    mustContinue: game.mustContinue || null,
    updatedAt: game.updatedAt,
    players: game.players.map(player => ({
      name: player.name,
      color: player.color,
      isYou: String(player.telegramId) === String(userId),
      isOwner: Boolean(player.isOwner)
    })),
    myColor: me?.color || null,
    currentPlayerIsMe: game.status === "playing" && String(game.turnTelegramId) === String(userId),
    currentPlayerLabel: current?.name || "Игрок",
    message: game.status === "finished"
      ? (game.winner === me?.color ? "Ты победил!" : "Партия завершена.")
      : (String(game.turnTelegramId) === String(userId) ? "Твой ход." : "Ход соперника.")
  };
}

async function wireApi(page, shared, user) {
  await page.addInitScript(({ id, name }) => {
    window.Telegram = {
      WebApp: {
        initData: "fake-telegram-user-" + id,
        initDataUnsafe: { user: { id, first_name: name, username: name.toLowerCase() } },
        ready() {},
        expand() {},
        BackButton: { show() {}, hide() {}, onClick() {} }
      }
    };
  }, user);

  await page.route("https://telegram.org/**", route => route.abort());
  await page.route("https://allcoins-server.onrender.com/**", async route => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace("/api/checkers", "");
    let body = {};
    try { body = route.request().postDataJSON() || {}; } catch {}
    const id = String(user.id);
    const reply = (data, status = 200) => route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(data)
    });
    if (body.initData !== "fake-telegram-user-" + id) return reply({ ok: false, error: "Bad test identity" }, 401);

    if (path === "/rooms/list") {
      const rooms = shared.room && shared.room.status === "waiting" && shared.room.players.length < 2
        ? [makeRoom(shared, id)]
        : [];
      return reply({ ok: true, rooms });
    }
    if (path === "/rooms/create") {
      if (shared.room) return reply({ ok: false, error: "Room already created" }, 409);
      shared.room = {
        id: "77",
        ownerId: id,
        ownerName: user.name,
        status: "waiting",
        players: [{ telegramId: id, name: user.name, isOwner: true }]
      };
      return reply({ ok: true, room: makeRoom(shared, id) });
    }
    if (path === "/rooms/join") {
      if (!shared.room || String(body.roomId) !== String(shared.room.id) || shared.room.status !== "waiting") {
        return reply({ ok: false, error: "Room not available" }, 409);
      }
      if (!shared.room.players.some(player => String(player.telegramId) === id)) {
        if (shared.room.players.length >= 2) return reply({ ok: false, error: "Room full" }, 409);
        shared.room.players.push({ telegramId: id, name: user.name, isOwner: false });
      }
      return reply({ ok: true, room: makeRoom(shared, id), playersCount: shared.room.players.length });
    }
    if (path === "/rooms/state") {
      if (!shared.room || !shared.room.players.some(player => String(player.telegramId) === id)) {
        return reply({ ok: false, error: "Not a member" }, 403);
      }
      return reply({
        ok: true,
        room: makeRoom(shared, id),
        players: shared.room.players.map(player => ({
          name: player.name,
          isYou: String(player.telegramId) === id,
          isOwner: Boolean(player.isOwner)
        })),
        game: publicGame(shared, id)
      });
    }
    if (path === "/rooms/start") {
      if (!shared.room || id !== String(shared.room.ownerId)) return reply({ ok: false, error: "Only owner" }, 403);
      if (shared.room.players.length !== 2) return reply({ ok: false, error: "Need two players" }, 409);
      shared.game = createCheckersGame(shared.room.players.map(player => ({
        telegramId: player.telegramId,
        name: player.name,
        isOwner: player.isOwner
      })));
      shared.room.status = "playing";
      return reply({ ok: true, room: makeRoom(shared, id), game: publicGame(shared, id) });
    }
    if (path === "/game/state") {
      if (!shared.room || !shared.game || !shared.room.players.some(player => String(player.telegramId) === id)) {
        return reply({ ok: false, error: "No game" }, 409);
      }
      return reply({ ok: true, room: makeRoom(shared, id), game: publicGame(shared, id) });
    }
    if (path === "/game/action") {
      if (!shared.room || !shared.game || String(body.roomId) !== String(shared.room.id)) {
        return reply({ ok: false, error: "No game" }, 409);
      }
      if (!shared.room.players.some(player => String(player.telegramId) === id)) return reply({ ok: false, error: "Not a member" }, 403);
      try {
        shared.game = applyCheckersStep(shared.game, id, body.from, body.to);
        // Guarantee a visible revision even if two moves happen within the same millisecond.
        shared.game.updatedAt = new Date(Date.now() + 5000).toISOString();
        if (shared.game.status === "finished") shared.room.status = "finished";
        return reply({ ok: true, room: makeRoom(shared, id), game: publicGame(shared, id) });
      } catch (error) {
        return reply({ ok: false, error: error.message }, error.statusCode || 400);
      }
    }
    if (path === "/rooms/leave") return reply({ ok: true });
    return reply({ ok: false, error: "Unknown test route " + path }, 404);
  });
}

test("two mobile clients join one room, start without a bot, and receive each other's moves", async () => {
  const { server, origin } = await startStaticServer();
  const browser = await chromium.launch({ headless: true });
  const shared = { room: null, game: null };
  const errors = [];
  let creatorContext;
  let guestContext;

  try {
    creatorContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    guestContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const creator = await creatorContext.newPage();
    const guest = await guestContext.newPage();
    creator.on("pageerror", error => errors.push("creator: " + error.message));
    guest.on("pageerror", error => errors.push("guest: " + error.message));
    await wireApi(creator, shared, { id: 100, name: "Создатель" });
    await wireApi(guest, shared, { id: 200, name: "Соперник" });

    await creator.goto(origin + "/checkers.html");
    await creator.locator("#createRoom").click();
    await creator.locator("#createdRoomPanel:not(.hidden)").waitFor();
    await creator.locator("#openCreatedRoom").click();
    await creator.locator("#onlineRoomPanel:not(.hidden)").waitFor();
    assert.equal(await creator.locator("#startOnlineGame").isDisabled(), true, "creator cannot start with one participant");

    await guest.goto(origin + "/checkers.html");
    await guest.locator("#showRooms").click();
    await guest.getByRole("button", { name: "Войти" }).click();
    await guest.locator("#onlineRoomPanel:not(.hidden)").waitFor();
    await creator.waitForFunction(() => {
      const button = document.getElementById("startOnlineGame");
      return button && !button.disabled;
    }, null, { timeout: 8000 });

    await creator.locator("#startOnlineGame").click();
    await creator.locator("#gameScreen:not(.hidden)").waitFor();
    await creator.waitForFunction(() => document.querySelectorAll("#board .piece").length === 24);
    await guest.waitForFunction(() => !document.getElementById("gameScreen").classList.contains("hidden"), null, { timeout: 8000 });

    assert.equal(await creator.locator("#opponentName").textContent(), "Соперник");
    assert.equal(await guest.locator("#opponentName").textContent(), "Создатель");
    assert.notEqual(await guest.locator("#opponentName").textContent(), "🤖 Тестовый бот");
    assert.equal(await guest.locator("#board .piece").count(), 24);

    await creator.locator('#board .square[data-r="5"][data-c="0"]').click();
    await creator.locator('#board .square[data-r="4"][data-c="1"]').click();
    await creator.waitForFunction(() => document.getElementById("turnStatus").textContent.includes("Ход соперника"));
    await guest.waitForFunction(() => document.getElementById("turnStatus").textContent.includes("Твой ход"), null, { timeout: 8000 });
    assert.equal(shared.game.turn, "b");

    await guest.locator('#board .square[data-r="2"][data-c="1"]').click();
    await guest.locator('#board .square[data-r="3"][data-c="0"]').click();
    await guest.waitForFunction(() => document.getElementById("turnStatus").textContent.includes("Ход соперника"));
    await creator.waitForFunction(() => document.getElementById("turnStatus").textContent.includes("Твой ход"), null, { timeout: 8000 });
    assert.equal(shared.game.turn, "w");
    assert.deepEqual(errors, [], "no browser JavaScript exceptions should occur");
  } finally {
    await creatorContext?.close().catch(() => {});
    await guestContext?.close().catch(() => {});
    await browser.close().catch(() => {});
    await new Promise(resolveClose => server.close(resolveClose));
  }
});
