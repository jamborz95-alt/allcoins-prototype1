import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

async function startStaticServer() {
  const server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
      const path = resolve(root, "." + pathname);
      if (!path.startsWith(root)) return res.writeHead(403).end();
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
  return { server, origin: "http://127.0.0.1:" + server.address().port };
}

function makeRoom(shared, userId) {
  const room = shared.room;
  return {
    id: "TW-" + room.id,
    roomId: String(room.id),
    ownerName: room.ownerName,
    stake: 100,
    maxPlayers: room.maxPlayers,
    playersCount: room.players.length,
    status: room.status,
    isOwner: String(userId) === String(room.ownerId),
    createdAt: "2026-10-27T05:00:00.000Z"
  };
}

function payload(shared, userId) {
  const room = shared.room;
  const me = room.players.find(p => String(p.id) === String(userId));
  return {
    ok: true,
    room: makeRoom(shared, userId),
    players: room.players.map(p => ({
      id: String(p.id), name: p.name, team: p.team, isYou: String(p.id) === String(userId),
      isOwner: Boolean(p.isOwner), connected: true, disqualified: Boolean(p.disqualified), warnings: Number(p.warnings || 0)
    })),
    me: me ? { id: String(me.id), team: me.team, isOwner: Boolean(me.isOwner), disqualified: Boolean(me.disqualified), warnings: Number(me.warnings || 0) } : null,
    game: shared.game ? {
      phase: shared.game.phase,
      progress: shared.game.progress,
      teamScores: { "1": shared.game.teamScores["1"], "2": shared.game.teamScores["2"] },
      target: shared.game.target,
      winnerTeam: shared.game.winnerTeam,
      totalTaps: shared.game.totalTaps,
      message: shared.game.message,
      warningForMe: Boolean(shared.game.warningUsers && shared.game.warningUsers[String(userId)]),
      disqualifiedForMe: Boolean(me && me.disqualified),
      payout: shared.game.payout || 0,
      commission: shared.game.commission || 0,
      updatedAt: Date.now()
    } : null
  };
}

async function wireApi(page, shared, user) {
  await page.addInitScript(({ id, name }) => {
    window.Telegram = {
      WebApp: {
        initData: "fake-tug-user-" + id,
        initDataUnsafe: { user: { id, first_name: name, username: name.toLowerCase() } },
        ready() {}, expand() {}, setHeaderColor() {}, setBackgroundColor() {}, disableVerticalSwipes() {},
        BackButton: { show() {}, hide() {}, onClick() {} }
      }
    };
  }, user);
  await page.route("https://telegram.org/**", route => route.abort());
  await page.route("https://allcoins-server.onrender.com/**", async route => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace("/api/tug-of-war", "");
    let body = {};
    try { body = route.request().postDataJSON() || {}; } catch {}
    const id = String(user.id);
    const reply = (data, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    if (body.initData !== "fake-tug-user-" + id) return reply({ ok: false, error: "Bad test identity" }, 401);
    if (path === "/rooms/list") {
      const rooms = shared.room && shared.room.status === "waiting" && shared.room.players.length < shared.room.maxPlayers
        ? [{ id: "TW-" + shared.room.id, roomId: String(shared.room.id), ownerName: shared.room.ownerName, stake: 100,
             maxPlayers: shared.room.maxPlayers, playersCount: shared.room.players.length }]
        : [];
      return reply({ ok: true, rooms });
    }
    if (path === "/rooms/create") {
      if (shared.room) return reply({ ok: false, error: "Room already exists" }, 409);
      shared.room = {
        id: "91", ownerId: id, ownerName: user.name, maxPlayers: Number(body.maxPlayers || 2),
        status: "waiting", players: [{ id, name: user.name, team: 1, isOwner: true, disqualified: false, warnings: 0 }]
      };
      return reply(payload(shared, id));
    }
    if (path === "/rooms/join") {
      if (!shared.room || String(body.roomId) !== String(shared.room.id) || shared.room.status !== "waiting") return reply({ ok:false,error:"Room unavailable" },409);
      if (!shared.room.players.some(p => String(p.id) === id)) {
        if (shared.room.players.length >= shared.room.maxPlayers) return reply({ ok:false,error:"Room full" },409);
        const counts = { 1: shared.room.players.filter(p => p.team === 1).length, 2: shared.room.players.filter(p => p.team === 2).length };
        const team = counts[1] <= counts[2] ? 1 : 2;
        shared.room.players.push({ id, name: user.name, team, isOwner: false, disqualified: false, warnings: 0 });
      }
      return reply(payload(shared,id));
    }
    if (path === "/rooms/state") {
      if (!shared.room || !shared.room.players.some(p => String(p.id) === id)) return reply({ok:false,error:"Not a member"},403);
      return reply(payload(shared,id));
    }
    if (path === "/rooms/start") {
      if (!shared.room || id !== String(shared.room.ownerId)) return reply({ok:false,error:"Only owner"},403);
      if (shared.room.players.length !== shared.room.maxPlayers) return reply({ok:false,error:"Waiting for players"},409);
      shared.room.status = "playing";
      shared.game = { phase:"playing",progress:0,teamScores:{"1":0,"2":0},target:shared.room.maxPlayers*12,winnerTeam:null,totalTaps:0,message:"Тяни канат!",warningUsers:{} };
      return reply(payload(shared,id));
    }
    if (path === "/tap") {
      if (!shared.room || !shared.game || shared.room.status !== "playing") return reply({ok:false,error:"No active game"},409);
      const player = shared.room.players.find(p => String(p.id) === id);
      if (!player) return reply({ok:false,error:"Not a member"},403);
      const count = Number(body.tapCount || 1);
      const teamKey = String(player.team);
      shared.game.teamScores[teamKey] += count;
      shared.game.totalTaps += count;
      const net = shared.game.teamScores["2"] - shared.game.teamScores["1"];
      shared.game.progress = Math.max(-1,Math.min(1,net/shared.game.target));
      shared.game.message = "Команда " + player.team + " тянет канат!";
      // The second tap intentionally returns a test warning so the warning overlay is exercised.
      if (count >= 2) {
        shared.game.warningUsers[id] = true;
        player.warnings = 1;
        return reply(Object.assign(payload(shared,id),{integrity:"warning",error:"Предупреждение тестового режима."}));
      }
      return reply(payload(shared,id));
    }
    if (path === "/rooms/leave") return reply({ok:true,left:true});
    return reply({ok:false,error:"Unknown test route " + path},404);
  });
}

test("two mobile players share a Tug of War room, start online, and see team strength", async () => {
  const { server, origin } = await startStaticServer();
  const browser = await chromium.launch({ headless: true, args: ["--use-gl=swiftshader", "--enable-webgl"] });
  const shared = { room: null, game: null };
  const errors = [];
  let creatorContext;
  let guestContext;
  try {
    creatorContext = await browser.newContext({ viewport:{width:390,height:844},isMobile:true,hasTouch:true });
    guestContext = await browser.newContext({ viewport:{width:390,height:844},isMobile:true,hasTouch:true });
    const creator = await creatorContext.newPage();
    const guest = await guestContext.newPage();
    creator.on("pageerror", error => errors.push("creator: " + error.message));
    guest.on("pageerror", error => errors.push("guest: " + error.message));
    await wireApi(creator, shared, {id:100,name:"Создатель"});
    await wireApi(guest, shared, {id:200,name:"Соперник"});

    await creator.goto(origin + "/tug-of-war.html");
    await creator.locator("#createRoom").click();
    await creator.locator("#roomScreen:not(.hidden)").waitFor();
    assert.equal(await creator.locator("#startGame").isVisible(), false, "creator cannot start a two-player match alone");
    assert.match(await creator.locator("#roomCode").textContent(), /TW-91/);

    await guest.goto(origin + "/tug-of-war.html");
    await guest.getByRole("button",{name:"Войти"}).click();
    await guest.locator("#roomScreen:not(.hidden)").waitFor();
    await creator.waitForFunction(() => {
      const button=document.getElementById("startGame");
      return button && !button.classList.contains("hidden") && !button.disabled;
    },null,{timeout:8000});
    assert.equal(await creator.locator("#team1Players .player-line").count(),1);
    assert.equal(await creator.locator("#team2Players .player-line").count(),1);

    await creator.locator("#startGame").click();
    await creator.locator("#gameScreen:not(.hidden)").waitFor();
    await guest.waitForFunction(() => !document.getElementById("gameScreen").classList.contains("hidden"),null,{timeout:8000});
    assert.equal(await creator.locator("#team1Count").textContent(),"1");
    assert.equal(await guest.locator("#team2Count").textContent(),"1");

    await creator.locator("#pullButton").dispatchEvent("pointerdown",{pointerId:1,pointerType:"touch",isPrimary:true,button:0});
    await creator.waitForFunction(() => document.getElementById("team1Score").textContent.trim()==="1",null,{timeout:8000});
    await guest.waitForFunction(() => document.getElementById("team1Score").textContent.trim()==="1",null,{timeout:8000});
    assert.equal(shared.game.teamScores["1"],1);

    await creator.locator("#pullButton").dispatchEvent("pointerdown",{pointerId:2,pointerType:"touch",isPrimary:true,button:0});
    await creator.locator("#pullButton").dispatchEvent("pointerdown",{pointerId:3,pointerType:"touch",isPrimary:true,button:0});
    await creator.locator("#warningBanner:not(.hidden)").waitFor({timeout:10000});
    assert.equal(await creator.locator("#warningBanner").isVisible(),true,"anti-autoclicker warning should be visible when server requests it");
    await creator.waitForFunction(() => !!document.getElementById("scene3d").querySelector("canvas"),null,{timeout:10000});
    assert.deepEqual(errors,[],"no browser JavaScript exceptions should occur");
  } finally {
    await creatorContext?.close().catch(()=>{});
    await guestContext?.close().catch(()=>{});
    await browser.close().catch(()=>{});
    await new Promise(resolveClose=>server.close(resolveClose));
  }
});
