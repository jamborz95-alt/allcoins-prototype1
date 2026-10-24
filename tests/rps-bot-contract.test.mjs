import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const router = await readFile(new URL("../server/rps-router.js", import.meta.url), "utf8");
const client = await readFile(new URL("../rps.html", import.meta.url), "utf8");

function routeBody(path) {
  const marker = `router.post("${path}", async (req, res) => {`;
  const start = router.indexOf(marker);
  assert.notEqual(start, -1, `Route not found: ${path}`);
  const nextRoute = router.indexOf("\n  router.post(", start + marker.length);
  return router.slice(start, nextRoute < 0 ? router.length : nextRoute);
}

test("only the room owner can add a test bot before a round starts", () => {
  const body = routeBody("/rooms/add-bot");
  assert.match(body, /authenticatedUser\(req, res\)/);
  assert.match(body, /owner_telegram_id/);
  assert.match(body, /room\.status !== "waiting"/);
  assert.match(body, /RPS_BOT_ID/);
  assert.match(body, /RPS_BOT_NAME/);
  assert.match(body, /ensureCurrentRound/);
  assert.match(body, /SET status = 'playing'/);
});

test("the bot chooses automatically and test rounds do not change AC balances", () => {
  const body = routeBody("/rooms/choose");
  assert.match(body, /participantIds\.includes\(RPS_BOT_ID\)/);
  assert.match(body, /candidateChoices\[RPS_BOT_ID\] = randomRpsChoice\(\)/);
  assert.match(body, /const testMode = participantIds\.includes\(RPS_BOT_ID\)/);
  assert.match(body, /if \(!testMode\)/);
  assert.match(body, /if \(testMode\) \{/);
  assert.match(body, /testMode,/);
});

test("a room with a bot exposes a practice label and a button in the waiting room", () => {
  assert.match(router, /hasBot: members\.some\(player => String\(player\.telegram_id\) === RPS_BOT_ID\)/);
  assert.match(router, /isBot: String\(player\.telegram_id\) === RPS_BOT_ID/);
  assert.match(client, /data-add-bot/);
  assert.match(client, /Добавить бота для проверки/);
  assert.match(client, /Тестовый раунд с ботом\. Баланс AC не изменён\./);
});

test("leaving a bot room never transfers room ownership to the bot", () => {
  const body = routeBody("/rooms/leave");
  assert.match(body, /remainingHumans = remainingMembers\.filter/);
  assert.match(body, /if \(!remainingHumans\.length\)/);
  assert.match(body, /remainingHumans\[0\]\.telegram_id/);
});
