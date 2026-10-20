import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../server/server.js", import.meta.url), "utf8");

function routeBody(path) {
  const marker = `app.post("${path}", async (req, res) => {`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `Route not found: ${path}`);
  const nextRoute = source.indexOf("\napp.post(", start + marker.length);
  return source.slice(start, nextRoute === -1 ? source.length : nextRoute);
}

test("Durak room creation validates Telegram identity, players, and stake", () => {
  const body = routeBody("/api/durak/rooms");
  assert.match(body, /verifyTelegram\(req\.body\?\.initData\)/);
  assert.match(body, /maxPlayers/);
  assert.match(body, /max_players/);
  assert.match(body, /stake/);
  assert.match(body, /INSERT INTO durak_rooms/);
  assert.match(body, /INSERT INTO durak_room_players/);
});

test("only the room owner can add the test bot while the room is waiting", () => {
  const body = routeBody("/api/durak/rooms/add-bot");
  assert.match(body, /owner_telegram_id/);
  assert.match(body, /может только создатель комнаты/);
  assert.match(body, /room\.status !== "waiting"/);
  assert.match(body, /🤖 Бот ALLCOINS/);
  assert.match(body, /max_players/);
});

test("joining a room checks membership, room state, and capacity", () => {
  const body = routeBody("/api/durak/rooms/join");
  assert.match(body, /room\.status !== "waiting"/);
  assert.match(body, /Комната заполнена/);
  assert.match(body, /INSERT INTO durak_room_players/);
});

test("starting a game checks owner, minimum players, and guest readiness", () => {
  const body = routeBody("/api/durak/rooms/start");
  assert.match(body, /Начать игру может только создатель комнаты/);
  assert.match(body, /total < 2/);
  assert.match(body, /readyGuests < totalGuests/);
  assert.match(body, /createDurakDeck/);
  assert.match(body, /INSERT INTO durak_games/);
  assert.match(body, /SET status = 'playing'/);
});

test("game actions allow only known actions and verify room membership", () => {
  const body = routeBody("/api/durak/action");
  assert.match(body, /\["attack", "defend", "take", "beat"\]/);
  assert.match(body, /Ты не состоишь в этой комнате/);
  assert.match(body, /Сейчас ход атакующего игрока/);
  assert.match(body, /Защищаться может только отбивающийся игрок/);
  assert.match(body, /Этой картой нельзя побить атакующую карту/);
  assert.match(body, /Сохраняем состояние партии/);
  assert.match(body, /SELECT game_state[\\s\\S]*FOR UPDATE/);
  assert.match(body, /await client\\.query\\("BEGIN"\\)/);
  assert.match(body, /await client\\.query\\("COMMIT"\\)/);
  assert.match(body, /await client\\.query\\("ROLLBACK"\\)/);
  assert.match(body, /client\\.release\\(\\)/);
  assert.match(body, /UPDATE durak_games/);
});
