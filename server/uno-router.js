import express from "express";
import crypto from "node:crypto";
import { recordGameCommission } from "./commission.js";

const COLORS = ["red", "blue", "green", "yellow"];
const COLOR_NAMES = { red: "красный", blue: "синий", green: "зелёный", yellow: "жёлтый" };

class UnoHttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function safeStake(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 100 ? n : null;
}

function shuffle(items) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function cardLabel(value) {
  return ({ skip: "⊘", reverse: "↻", draw2: "+2", wild: "WILD", wild4: "+4" })[value] ?? String(value);
}

function makeDeck() {
  const deck = [];
  let serial = 0;
  for (const color of COLORS) {
    deck.push({ id: "uno-" + (++serial), color, value: 0, label: "0" });
    for (let n = 1; n <= 9; n++) {
      deck.push({ id: "uno-" + (++serial), color, value: n, label: String(n) });
      deck.push({ id: "uno-" + (++serial), color, value: n, label: String(n) });
    }
    for (const value of ["skip", "reverse", "draw2"]) {
      for (let copy = 0; copy < 2; copy++) {
        deck.push({ id: "uno-" + (++serial), color, value, label: cardLabel(value) });
      }
    }
  }
  for (let i = 0; i < 4; i++) {
    deck.push({ id: "uno-" + (++serial), color: "wild", value: "wild", label: "WILD" });
    deck.push({ id: "uno-" + (++serial), color: "wild", value: "wild4", label: "+4" });
  }
  return shuffle(deck);
}

function nextIndex(game, steps = 1) {
  const n = game.players.length;
  game.currentPlayerIndex = ((game.currentPlayerIndex + game.direction * steps) % n + n) % n;
}

function currentPlayer(game) {
  return game.players[game.currentPlayerIndex];
}

function cardIsPlayable(card, game) {
  if (!card) return false;
  if (card.color === "wild") return true;
  const top = game.discard[game.discard.length - 1];
  return card.color === game.currentColor || card.value === top.value;
}

function drawOne(game) {
  if (!game.drawPile.length && game.discard.length > 1) {
    const top = game.discard.pop();
    game.drawPile = shuffle(game.discard.splice(0));
    game.discard = [top];
  }
  return game.drawPile.pop() || null;
}

function addCards(game, player, amount) {
  for (let i = 0; i < amount; i++) {
    const card = drawOne(game);
    if (!card) break;
    player.hand.push(card);
  }
}

function chooseBotColor(player) {
  const counts = { red: 0, blue: 0, green: 0, yellow: 0 };
  player.hand.forEach(card => { if (counts[card.color] !== undefined) counts[card.color]++; });
  return COLORS.slice().sort((a, b) => counts[b] - counts[a])[0];
}

function buildGame(humans, maxPlayers, stake, testMode) {
  const players = humans.map(p => ({
    id: String(p.telegram_id), name: String(p.display_name || "Игрок"), bot: false, hand: []
  }));
  if (testMode) {
    let n = 1;
    while (players.length < maxPlayers) {
      players.push({ id: "uno-bot-" + n, name: "Бот " + n, bot: true, hand: [] });
      n++;
    }
  }
  const deck = makeDeck();
  players.forEach(player => { for (let i = 0; i < 7; i++) player.hand.push(deck.pop()); });
  let first = deck.pop();
  while (first && first.color === "wild") {
    deck.unshift(first);
    shuffle(deck);
    first = deck.pop();
  }
  if (!first) throw new UnoHttpError(500, "Не удалось подготовить колоду УНО.");
  return {
    status: "playing", mode: testMode ? "bots" : "online",
    stake: Number(stake), pot: testMode ? 0 : Number(stake) * humans.length,
    players, drawPile: deck, discard: [first], currentColor: first.color,
    currentPlayerIndex: 0, direction: 1, drawnCardId: null,
    message: "Игра началась! Подбери цвет или символ верхней карты.",
    winnerId: null, winnerName: null, payout: 0, commission: 0,
    settlementApplied: false, updatedAt: Date.now()
  };
}

function getWinningCardIndex(player, game) {
  const playable = player.hand
    .map((card, index) => ({ card, index }))
    .filter(item => cardIsPlayable(item.card, game) &&
      !(item.card.value === "wild4" && player.hand.some(other => other.color === game.currentColor)));
  if (!playable.length) return -1;
  const action = playable.find(item => ["draw2", "skip", "reverse", "wild4"].includes(item.card.value));
  return action ? action.index : playable[0].index;
}

function playCardInGame(game, player, cardIndex, chosenColor, callUno) {
  if (!Number.isInteger(cardIndex) || cardIndex < 0 || cardIndex >= player.hand.length) {
    throw new UnoHttpError(400, "Эта карта уже не в руке. Обнови игру.");
  }
  const card = player.hand[cardIndex];
  if (game.drawnCardId && card.id !== game.drawnCardId) {
    throw new UnoHttpError(400, "После взятия карты можно разыграть только её или нажать «Пас».");
  }
  if (!cardIsPlayable(card, game)) throw new UnoHttpError(400, "Эту карту нельзя положить на текущую карту.");
  if (card.value === "wild4" && player.hand.some(other => other.color === game.currentColor)) {
    throw new UnoHttpError(400, "«+4» можно сыграть, только если у тебя нет карты текущего цвета.");
  }
  if (!player.bot && player.hand.length === 2 && !callUno) {
    throw new UnoHttpError(400, "Перед этой картой объяви UNO — после хода останется одна карта.");
  }
  if (card.color === "wild" && !COLORS.includes(chosenColor)) throw new UnoHttpError(400, "Выбери цвет для карты WILD.");

  player.hand.splice(cardIndex, 1);
  game.discard.push(card);
  game.currentColor = card.color === "wild" ? chosenColor : card.color;
  game.drawnCardId = null;
  const colorText = COLOR_NAMES[game.currentColor] || game.currentColor;
  let effectSteps = 1;

  if (card.value === "skip") {
    effectSteps = 2;
    game.message = player.name + " пропускает следующего игрока.";
  } else if (card.value === "reverse") {
    if (game.players.length === 2) {
      effectSteps = 2;
      game.message = player.name + " меняет направление — ещё один ход.";
    } else {
      game.direction *= -1;
      game.message = player.name + " меняет направление игры.";
    }
  } else if (card.value === "draw2" || card.value === "wild4") {
    const amount = card.value === "draw2" ? 2 : 4;
    const nextPlayerIndex = ((game.currentPlayerIndex + game.direction) % game.players.length + game.players.length) % game.players.length;
    const target = game.players[nextPlayerIndex];
    addCards(game, target, amount);
    effectSteps = 2;
    game.message = player.name + " сыграл " + card.label + " — " + target.name + " берёт " + amount + " карты.";
    if (card.value === "wild4") game.message += " Цвет: " + colorText + ".";
  } else {
    game.message = player.name + " положил " + card.label + " (" + colorText + ").";
  }

  if (player.hand.length === 1 && !player.bot) game.message += " UNO!";
  if (player.hand.length === 0) {
    game.status = "finished";
    game.winnerId = player.id;
    game.winnerName = player.name;
    game.message = "🏆 " + player.name + " выиграл партию УНО!";
    return;
  }
  nextIndex(game, effectSteps);
  game.updatedAt = Date.now();
}

function runBotTurn(game) {
  const player = currentPlayer(game);
  if (!player || !player.bot || game.status !== "playing") return false;
  const index = getWinningCardIndex(player, game);
  if (index >= 0) {
    const card = player.hand[index];
    playCardInGame(game, player, index, card.color === "wild" ? chooseBotColor(player) : null, true);
    return true;
  }
  const card = drawOne(game);
  if (card) {
    player.hand.push(card);
    if (cardIsPlayable(card, game) && !(card.value === "wild4" && player.hand.some(other => other.id !== card.id && other.color === game.currentColor))) {
      const drawnIndex = player.hand.findIndex(item => item.id === card.id);
      playCardInGame(game, player, drawnIndex, card.color === "wild" ? chooseBotColor(player) : null, true);
      return true;
    }
  }
  game.drawnCardId = null;
  game.message = player.name + " взял карту и пропускает ход.";
  nextIndex(game, 1);
  game.updatedAt = Date.now();
  return true;
}

export function createUnoRouter({ pool, verifyTelegram }) {
  const router = express.Router();

  function authenticatedUser(req) {
    const user = verifyTelegram(req.body?.initData);
    if (!user?.id) throw new UnoHttpError(401, "Не удалось проверить Telegram. Открой УНО через ALLCOINS в Telegram.");
    return { id: String(user.id), name: String(user.first_name || user.username || "Игрок").slice(0, 40) };
  }

  async function ensurePlayer(client, user) {
    const result = await client.query(
      "INSERT INTO players (telegram_id) VALUES ($1) ON CONFLICT (telegram_id) DO UPDATE SET updated_at = NOW() RETURNING balance",
      [user.id]
    );
    return Number(result.rows[0]?.balance || 0);
  }

  async function roomPayload(client, roomId, userId) {
    const roomResult = await client.query(
      "SELECT r.id, r.name, r.owner_telegram_id, r.max_players, r.stake, r.status, r.created_at, COUNT(p.telegram_id)::INTEGER AS players_count " +
      "FROM uno_rooms r LEFT JOIN uno_room_players p ON p.room_id = r.id WHERE r.id = $1 GROUP BY r.id",
      [roomId]
    );
    const row = roomResult.rows[0];
    if (!row) throw new UnoHttpError(404, "Комната УНО не найдена.");
    const playerResult = await client.query(
      "SELECT telegram_id, display_name, joined_at FROM uno_room_players WHERE room_id = $1 ORDER BY joined_at ASC, telegram_id ASC",
      [roomId]
    );
    return {
      room: {
        id: String(row.id), name: String(row.name),
        ownerId: String(row.owner_telegram_id),
        ownerName: String(playerResult.rows.find(p => String(p.telegram_id) === String(row.owner_telegram_id))?.display_name || "Создатель"),
        maxPlayers: Number(row.max_players), stake: Number(row.stake), status: String(row.status),
        playersCount: Number(row.players_count), createdAt: row.created_at,
        isOwner: String(row.owner_telegram_id) === String(userId)
      },
      players: playerResult.rows.map(p => ({
        id: String(p.telegram_id), name: String(p.display_name || "Игрок"),
        isOwner: String(p.telegram_id) === String(row.owner_telegram_id),
        isYou: String(p.telegram_id) === String(userId)
      }))
    };
  }

  async function assertRoomMember(client, roomId, userId) {
    const result = await client.query("SELECT 1 FROM uno_room_players WHERE room_id = $1 AND telegram_id = $2", [roomId, userId]);
    if (!result.rows.length) throw new UnoHttpError(403, "Сначала войди в эту комнату.");
  }

  async function saveGame(client, roomId, game) {
    if (game.status === "finished" && !game.settlementApplied) {
      if (game.mode === "online" && Number(game.pot) > 0) {
        const winner = game.players.find(player => player.id === String(game.winnerId));
        if (winner && !winner.bot) {
          const commissionResult = await recordGameCommission(client, {
            game: "uno", eventKey: "uno:" + String(roomId) + ":finished", grossAmount: Number(game.pot)
          });
          const commission = Math.max(0, Math.min(Number(game.pot), Math.floor(Number(commissionResult?.amount) || 0)));
          const payout = Math.max(0, Number(game.pot) - commission);
          const credited = await client.query(
            "UPDATE players SET balance = balance + $1, updated_at = NOW() WHERE telegram_id = $2 RETURNING balance",
            [payout, winner.id]
          );
          game.commission = commission;
          game.payout = credited.rows.length ? payout : 0;
          if (credited.rows.length) game.message += " Приз " + payout.toLocaleString("ru-RU") + " AC зачислен победителю.";
        }
      }
      game.settlementApplied = true;
      await client.query("UPDATE uno_rooms SET status = 'finished' WHERE id = $1", [String(roomId)]);
    }
    game.updatedAt = Date.now();
    await client.query(
      "UPDATE uno_games SET game_state = $2::jsonb, updated_at = NOW() WHERE room_id = $1",
      [String(roomId), JSON.stringify(game)]
    );
  }

  router.post("/rooms/list", async (req, res) => {
    try {
      const user = authenticatedUser(req);
      await ensurePlayer(pool, user);
      const result = await pool.query(
        "SELECT r.id, r.name, r.owner_telegram_id, r.max_players, r.stake, r.status, r.created_at, " +
        "COUNT(p.telegram_id)::INTEGER AS players_count, " +
        "COALESCE(MAX(p.display_name) FILTER (WHERE p.telegram_id = r.owner_telegram_id), 'Создатель') AS owner_name " +
        "FROM uno_rooms r LEFT JOIN uno_room_players p ON p.room_id = r.id " +
        "WHERE r.status = 'waiting' GROUP BY r.id HAVING COUNT(p.telegram_id) < r.max_players " +
        "ORDER BY r.created_at DESC LIMIT 80"
      );
      return res.json({ ok: true, rooms: result.rows.map(row => ({
        id: String(row.id), name: String(row.name), ownerName: String(row.owner_name),
        maxPlayers: Number(row.max_players), playersCount: Number(row.players_count),
        stake: Number(row.stake), status: String(row.status), isOwner: String(row.owner_telegram_id) === user.id
      })) });
    } catch (error) {
      return res.status(error.status || 500).json({ ok: false, error: error.message || "Не удалось загрузить комнаты УНО." });
    }
  });

  router.post("/rooms/create", async (req, res) => {
    const client = await pool.connect();
    try {
      const user = authenticatedUser(req);
      const name = String(req.body?.name || "").trim().slice(0, 30) || "Комната УНО";
      const maxPlayers = Number(req.body?.maxPlayers);
      const stake = safeStake(req.body?.stake);
      if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 10) throw new UnoHttpError(400, "В комнате УНО может быть от 2 до 10 мест.");
      if (stake === null) throw new UnoHttpError(400, "Укажи ставку от 100 AC. Верхний лимит ставки не задан.");
      await client.query("BEGIN");
      await ensurePlayer(client, user);
      const created = await client.query(
        "INSERT INTO uno_rooms (name, owner_telegram_id, max_players, stake, status) VALUES ($1, $2, $3, $4, 'waiting') RETURNING id",
        [name, user.id, maxPlayers, stake]
      );
      const roomId = String(created.rows[0].id);
      await client.query("INSERT INTO uno_room_players (room_id, telegram_id, display_name) VALUES ($1, $2, $3)", [roomId, user.id, user.name]);
      await client.query("COMMIT");
      return res.json({ ok: true, ...(await roomPayload(pool, roomId, user.id)) });
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      return res.status(error.status || 500).json({ ok: false, error: error.message || "Не удалось создать комнату УНО." });
    } finally { client.release(); }
  });

  router.post("/rooms/join", async (req, res) => {
    const client = await pool.connect();
    try {
      const user = authenticatedUser(req);
      const roomId = String(req.body?.roomId || "");
      if (!/^\d+$/.test(roomId)) throw new UnoHttpError(400, "Неверный номер комнаты.");
      await client.query("BEGIN");
      await ensurePlayer(client, user);
      const result = await client.query("SELECT id, max_players, status FROM uno_rooms WHERE id = $1 FOR UPDATE", [roomId]);
      const row = result.rows[0];
      if (!row) throw new UnoHttpError(404, "Комната уже не существует.");
      if (row.status !== "waiting") throw new UnoHttpError(400, "Эта партия уже началась.");
      const exists = await client.query("SELECT 1 FROM uno_room_players WHERE room_id = $1 AND telegram_id = $2", [roomId, user.id]);
      if (!exists.rows.length) {
        const count = await client.query("SELECT COUNT(*)::INTEGER AS total FROM uno_room_players WHERE room_id = $1", [roomId]);
        if (Number(count.rows[0]?.total || 0) >= Number(row.max_players)) throw new UnoHttpError(400, "В комнате уже нет свободных мест.");
        await client.query("INSERT INTO uno_room_players (room_id, telegram_id, display_name) VALUES ($1, $2, $3)", [roomId, user.id, user.name]);
      }
      await client.query("COMMIT");
      return res.json({ ok: true, ...(await roomPayload(pool, roomId, user.id)) });
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      return res.status(error.status || 500).json({ ok: false, error: error.message || "Не удалось войти в комнату УНО." });
    } finally { client.release(); }
  });

  router.post("/rooms/state", async (req, res) => {
    try {
      const user = authenticatedUser(req);
      const roomId = String(req.body?.roomId || "");
      if (!/^\d+$/.test(roomId)) throw new UnoHttpError(400, "Неверный номер комнаты.");
      await assertRoomMember(pool, roomId, user.id);
      return res.json({ ok: true, ...(await roomPayload(pool, roomId, user.id)) });
    } catch (error) {
      return res.status(error.status || 500).json({ ok: false, error: error.message || "Не удалось обновить комнату." });
    }
  });

  router.post("/rooms/leave", async (req, res) => {
    const client = await pool.connect();
    try {
      const user = authenticatedUser(req);
      const roomId = String(req.body?.roomId || "");
      if (!/^\d+$/.test(roomId)) throw new UnoHttpError(400, "Неверный номер комнаты.");
      await client.query("BEGIN");
      const result = await client.query("SELECT owner_telegram_id, status FROM uno_rooms WHERE id = $1 FOR UPDATE", [roomId]);
      const row = result.rows[0];
      if (!row) { await client.query("COMMIT"); return res.json({ ok: true }); }
      if (row.status !== "waiting") throw new UnoHttpError(400, "Игра уже началась. Заверши партию перед выходом.");
      if (String(row.owner_telegram_id) === user.id) await client.query("DELETE FROM uno_rooms WHERE id = $1", [roomId]);
      else await client.query("DELETE FROM uno_room_players WHERE room_id = $1 AND telegram_id = $2", [roomId, user.id]);
      await client.query("COMMIT");
      return res.json({ ok: true });
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      return res.status(error.status || 500).json({ ok: false, error: error.message || "Не удалось выйти из комнаты." });
    } finally { client.release(); }
  });

  router.post("/rooms/start", async (req, res) => {
    const client = await pool.connect();
    try {
      const user = authenticatedUser(req);
      const roomId = String(req.body?.roomId || "");
      const withBots = req.body?.withBots === true;
      if (!/^\d+$/.test(roomId)) throw new UnoHttpError(400, "Неверный номер комнаты.");
      await client.query("BEGIN");
      const roomResult = await client.query("SELECT id, name, owner_telegram_id, max_players, stake, status FROM uno_rooms WHERE id = $1 FOR UPDATE", [roomId]);
      const room = roomResult.rows[0];
      if (!room) throw new UnoHttpError(404, "Комната не найдена.");
      if (String(room.owner_telegram_id) !== user.id) throw new UnoHttpError(403, "Начать игру может только создатель комнаты.");
      if (room.status !== "waiting") throw new UnoHttpError(400, "Эта партия уже запущена.");
      const membersResult = await client.query(
        "SELECT telegram_id, display_name FROM uno_room_players WHERE room_id = $1 ORDER BY joined_at ASC, telegram_id ASC FOR UPDATE",
        [roomId]
      );
      const members = membersResult.rows;
      if (!members.length) throw new UnoHttpError(400, "В комнате пока нет игроков.");
      if (!withBots && members.length < 2) throw new UnoHttpError(400, "Для онлайн-партии нужны минимум 2 реальных игрока. Нажми «Старт с ботами» для одиночной тренировки.");
      if (!withBots) {
        for (const member of members) {
          const balanceResult = await client.query("SELECT balance FROM players WHERE telegram_id = $1 FOR UPDATE", [String(member.telegram_id)]);
          if (!balanceResult.rows.length || Number(balanceResult.rows[0].balance) < Number(room.stake)) {
            throw new UnoHttpError(400, "У игрока «" + String(member.display_name || "Игрок") + "» недостаточно AC для ставки " + Number(room.stake).toLocaleString("ru-RU") + ".");
          }
        }
        for (const member of members) {
          const charged = await client.query(
            "UPDATE players SET balance = balance - $1, updated_at = NOW() WHERE telegram_id = $2 AND balance >= $1 RETURNING balance",
            [String(room.stake), String(member.telegram_id)]
          );
          if (!charged.rows.length) throw new UnoHttpError(400, "Недостаточно AC для ставки. Создай комнату с меньшей суммой.");
        }
      }
      const game = buildGame(members, Number(room.max_players), Number(room.stake), withBots);
      await client.query("UPDATE uno_rooms SET status = 'playing' WHERE id = $1", [roomId]);
      await client.query(
        "INSERT INTO uno_games (room_id, game_state, updated_at) VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (room_id) DO UPDATE SET game_state = EXCLUDED.game_state, updated_at = NOW()",
        [roomId, JSON.stringify(game)]
      );
      await client.query("COMMIT");
      return res.json({ ok: true, roomId, status: "playing", mode: game.mode, message: withBots ? "Тренировочная партия с ботами запущена. AC не списываются." : "Онлайн-партия запущена. Ставки списаны, победитель получит банк за вычетом комиссии." });
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      return res.status(error.status || 500).json({ ok: false, error: error.message || "Не удалось начать партию УНО." });
    } finally { client.release(); }
  });

  function publicGame(game, userId) {
    const me = game.players.find(player => player.id === userId);
    return {
      status: game.status, mode: game.mode, stake: game.stake, pot: game.pot,
      players: game.players.map((player, index) => ({
        id: player.id, name: player.name, bot: Boolean(player.bot),
        handCount: player.hand.length, isCurrent: index === game.currentPlayerIndex && game.status === "playing",
        isYou: player.id === userId
      })),
      hand: me ? me.hand : [], discard: game.discard, drawCount: game.drawPile.length,
      currentColor: game.currentColor, currentPlayerId: currentPlayer(game)?.id || null,
      direction: game.direction, drawnCardId: game.drawnCardId, message: game.message,
      winnerId: game.winnerId, winnerName: game.winnerName,
      payout: Number(game.payout || 0), commission: Number(game.commission || 0), updatedAt: game.updatedAt
    };
  }

  router.post("/game/state", async (req, res) => {
    const client = await pool.connect();
    let transactionOpen = false;
    try {
      const user = authenticatedUser(req);
      const roomId = String(req.body?.roomId || "");
      if (!/^\d+$/.test(roomId)) throw new UnoHttpError(400, "Неверный номер комнаты.");

      // Human-vs-human reads stay read-only: polling must not lock the same game row
      // that an incoming player action needs to update.
      await assertRoomMember(client, roomId, user.id);
      const initial = await client.query("SELECT game_state FROM uno_games WHERE room_id = $1", [roomId]);
      if (!initial.rows.length) throw new UnoHttpError(404, "Партия ещё не подготовлена.");
      let game = initial.rows[0].game_state;

      // Only bot turns need a write lock. Re-read under the lock because another
      // request may have advanced the game while this request was waiting.
      if (game.status === "playing" && currentPlayer(game)?.bot) {
        await client.query("BEGIN");
        transactionOpen = true;
        await assertRoomMember(client, roomId, user.id);
        const locked = await client.query("SELECT game_state FROM uno_games WHERE room_id = $1 FOR UPDATE", [roomId]);
        if (!locked.rows.length) throw new UnoHttpError(404, "Партия ещё не подготовлена.");
        game = locked.rows[0].game_state;
        if (game.status === "playing" && currentPlayer(game)?.bot) {
          runBotTurn(game);
          await saveGame(client, roomId, game);
        }
        await client.query("COMMIT");
        transactionOpen = false;
      }
      return res.json({ ok: true, game: publicGame(game, user.id) });
    } catch (error) {
      if (transactionOpen) { try { await client.query("ROLLBACK"); } catch {} }
      return res.status(error.status || 500).json({ ok: false, error: error.message || "Не удалось обновить партию УНО." });
    } finally { client.release(); }
  });
  router.post("/game/action", async (req, res) => {
    const client = await pool.connect();
    try {
      const user = authenticatedUser(req);
      const roomId = String(req.body?.roomId || "");
      const action = String(req.body?.action || "");
      if (!/^\d+$/.test(roomId)) throw new UnoHttpError(400, "Неверный номер комнаты.");
      await client.query("BEGIN");
      await assertRoomMember(client, roomId, user.id);
      const result = await client.query("SELECT game_state FROM uno_games WHERE room_id = $1 FOR UPDATE", [roomId]);
      if (!result.rows.length) throw new UnoHttpError(404, "Партия ещё не подготовлена.");
      const game = result.rows[0].game_state;
      if (game.status !== "playing") throw new UnoHttpError(400, "Эта партия уже завершена.");
      const player = currentPlayer(game);
      if (!player || player.id !== user.id || player.bot) throw new UnoHttpError(403, "Сейчас ход другого игрока.");
      if (action === "play") {
        const cardId = String(req.body?.cardId || "");
        const cardIndex = player.hand.findIndex(card => card.id === cardId);
        playCardInGame(game, player, cardIndex, String(req.body?.color || ""), req.body?.callUno === true);
      } else if (action === "draw") {
        if (game.drawnCardId) throw new UnoHttpError(400, "Ты уже взял карту. Разыграй её или нажми «Пас».");
        const card = drawOne(game);
        if (!card) throw new UnoHttpError(400, "В колоде больше нет карт. Попробуй сыграть с открытой карты.");
        player.hand.push(card);
        game.drawnCardId = card.id;
        game.message = cardIsPlayable(card, game) ? "Карта взята. Можешь сыграть её или нажать «Пас»." : "Карта взята. Нажми «Пас», чтобы передать ход.";
        game.updatedAt = Date.now();
      } else if (action === "pass") {
        if (!game.drawnCardId) throw new UnoHttpError(400, "Сначала возьми карту.");
        game.drawnCardId = null;
        game.message = player.name + " передал ход.";
        nextIndex(game, 1);
        game.updatedAt = Date.now();
      } else {
        throw new UnoHttpError(400, "Неизвестное действие УНО.");
      }
      await saveGame(client, roomId, game);
      await client.query("COMMIT");
      return res.json({ ok: true, game: publicGame(game, user.id) });
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      return res.status(error.status || 500).json({ ok: false, error: error.message || "Не удалось выполнить ход УНО." });
    } finally { client.release(); }
  });

  router.initialize = async () => {
    await pool.query(
      "CREATE TABLE IF NOT EXISTS uno_rooms (" +
      "id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, " +
      "name TEXT NOT NULL, owner_telegram_id BIGINT NOT NULL, " +
      "max_players INTEGER NOT NULL CHECK (max_players BETWEEN 2 AND 10), " +
      "stake BIGINT NOT NULL CHECK (stake >= 100), " +
      "status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'playing', 'finished')), " +
      "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
    );
    await pool.query(
      "CREATE TABLE IF NOT EXISTS uno_room_players (" +
      "room_id BIGINT NOT NULL REFERENCES uno_rooms(id) ON DELETE CASCADE, " +
      "telegram_id BIGINT NOT NULL, display_name TEXT, " +
      "joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), " +
      "PRIMARY KEY (room_id, telegram_id))"
    );
    await pool.query(
      "CREATE TABLE IF NOT EXISTS uno_games (" +
      "room_id BIGINT PRIMARY KEY REFERENCES uno_rooms(id) ON DELETE CASCADE, " +
      "game_state JSONB NOT NULL DEFAULT '{}'::jsonb, " +
      "updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
    );
    console.log("UNO Online tables are ready");
  };

  return router;
}
