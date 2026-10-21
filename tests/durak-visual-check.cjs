const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

(async () => {
  const out = path.join(process.cwd(), "visual-test-output");
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true
  });
  const errors = [];
  let currentGame = {
    ok: true,
    status: "playing",
    phase: "attack",
    playerIndex: 0,
    attackerIndex: 0,
    defenderIndex: 1,
    players: [
      { label: "Ты", cardsCount: 2 },
      { label: "Соперник", cardsCount: 6 }
    ],
    hand: [
      { id: "visual-card-1", rank: "К", suit: "♠" },
      { id: "visual-card-2", rank: "Д", suit: "♥" }
    ],
    table: [],
    cardsLeft: 20,
    trumpCard: { id: "visual-trump", rank: "Т", suit: "♥" },
    trumpSuit: "♥"
  };
  let actionRequests = 0;

  await page.addInitScript(() => {
    window.Telegram = {
      WebApp: {
        initData: "visual-test-init-data",
        ready() {},
        expand() {},
        HapticFeedback: { selectionChanged() {} }
      }
    };
  });

  // Не даём внешнему Telegram SDK перезаписать тестовый WebApp до создания const tg в index.html.
  await page.route("**/telegram-web-app.js", route => route.fulfill({
    status: 200,
    contentType: "application/javascript",
    body: "// Telegram WebApp is mocked by addInitScript in this offline visual test.\n"
  }));

  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    let body = {};
    if (route.request().method() === "POST") {
      try { body = route.request().postDataJSON(); } catch (_) { body = {}; }
    }
    if (url.pathname.endsWith("/api/durak/game")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(currentGame) });
      return;
    }
    if (url.pathname.endsWith("/api/durak/action")) {
      actionRequests++;
      const ids = Array.isArray(body.cardIds) ? body.cardIds.map(String) : [];
      const card = currentGame.hand.find(item => ids.includes(String(item.id))) || currentGame.hand[0];
      if (body.action === "attack" && card) {
        currentGame.hand = currentGame.hand.filter(item => String(item.id) !== String(card.id));
        currentGame.table = [{ attack: card, defense: null }];
        currentGame.phase = "defense";
        currentGame.players[0].cardsCount = currentGame.hand.length;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
      return;
    }
    if (url.pathname.endsWith("/api/auth")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, player: { id: "visual-player", telegram_id: 123, username: "VisualTester", balance: 10000, energy: 100 } })
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, rooms: [], players: [] }) });
  });

  page.on("pageerror", error => errors.push("PAGE: " + error.message));
  page.on("console", message => {
    if (message.type() === "error" && !/adsgram|telegram\.org|ERR_BLOCKED_BY_CLIENT|Failed to load resource/i.test(message.text())) {
      errors.push("CONSOLE: " + message.text());
    }
  });
  page.on("requestfailed", request => {
    const url = request.url();
    if (!url.includes("adsgram") && !url.includes("telegram.org")) {
      errors.push("REQUEST: " + url + " — " + (request.failure()?.errorText || "failed"));
    }
  });

  try {
    await page.goto("http://127.0.0.1:4173/index.html", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(700);
    await page.locator('.nav [data-page="games"]').click();
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(out, "01-games-mobile.png"), fullPage: true });

    // Feed a deterministic game state into the real production renderer and real card pointer handlers.
    await page.evaluate(async () => {
      state.user = { id: "visual-player", username: "VisualTester" };
      currentDurakRoomId = "visual-test-room";
      document.getElementById("durakGame").style.display = "block";
      document.getElementById("durakGame").classList.add("durak-fullscreen");
      await loadDurakGame("visual-test-room");
    });
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(out, "02-game-before-drag.png"), fullPage: true });

    const card = page.locator('#durakHand .durak-card[data-card-id="visual-card-1"]');
    if (!(await card.count())) throw new Error("Тестовая карта не отрисовалась настоящим рендерером ALLCOINS");
    const cardRect = await card.boundingBox();
    const tableRect = await page.locator("#durakTable").boundingBox();
    if (!cardRect || !tableRect || tableRect.width < 20 || tableRect.height < 20) {
      throw new Error("Карта или зона стола не имеет видимых размеров");
    }

    const startX = cardRect.x + cardRect.width / 2;
    const startY = cardRect.y + cardRect.height / 2;
    const targetX = tableRect.x + Math.min(tableRect.width - 10, Math.max(20, tableRect.width * 0.55));
    const targetY = tableRect.y + Math.min(tableRect.height - 10, Math.max(20, tableRect.height * 0.5));
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move((startX + targetX) / 2, (startY + targetY) / 2, { steps: 5 });
    await page.waitForTimeout(80);
    await page.screenshot({ path: path.join(out, "03-game-card-being-dragged.png"), fullPage: true });
    await page.mouse.move(targetX, targetY, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(out, "04-game-after-drop.png"), fullPage: true });

    const diagnostics = await page.evaluate(() => ({
      title: document.title,
      viewport: { width: innerWidth, height: innerHeight },
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
      handCardsAfterDrop: document.querySelectorAll("#durakHand .durak-card").length,
      tableAttackCardsAfterDrop: document.querySelectorAll('#durakTable .durak-card[data-table-card-type="attack"]').length,
      flyingCardsAfterDrop: document.querySelectorAll(".durak-flying-card").length,
      imageCards: [...document.querySelectorAll('#durakHand img, #durakTable img')].map(img => ({
        src: img.getAttribute("src"),
        loaded: img.complete && img.naturalWidth > 0
      }))
    }));
    fs.writeFileSync(path.join(out, "diagnostics.json"), JSON.stringify({ diagnostics, errors, actionRequests }, null, 2));

    if (diagnostics.documentWidth > diagnostics.viewport.width + 2) {
      throw new Error("Горизонтальное переполнение: " + diagnostics.documentWidth + "px при viewport " + diagnostics.viewport.width + "px");
    }
    if (diagnostics.tableAttackCardsAfterDrop !== 1) {
      throw new Error("После перетаскивания карта не закрепилась на столе. Карты на столе: " + diagnostics.tableAttackCardsAfterDrop);
    }
    if (diagnostics.handCardsAfterDrop !== 1) {
      throw new Error("После хода ожидается 1 карта в руке, найдено: " + diagnostics.handCardsAfterDrop);
    }
    if (diagnostics.flyingCardsAfterDrop !== 0) {
      throw new Error("После завершения анимации осталась летающая копия карты");
    }
    if (actionRequests !== 1) throw new Error("Ожидался ровно один запрос хода, получено: " + actionRequests);
    if (errors.length) {
      fs.writeFileSync(path.join(out, "browser-errors.txt"), errors.join("\n"));
      throw new Error("Есть ошибки браузера: " + errors.length + ". См. visual-test-output/browser-errors.txt");
    }
    console.log("Mobile drag/drop visual test passed:", JSON.stringify(diagnostics));
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
