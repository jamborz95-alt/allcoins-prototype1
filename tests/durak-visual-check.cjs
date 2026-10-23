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
      { id: "visual-card-1", rank: "8", suit: "♠" },
      { id: "visual-card-2", rank: "8", suit: "♥" },
      { id: "visual-card-3", rank: "Д", suit: "♥" }
    ],
    table: [],
    cardsLeft: 20,
    trumpCard: { id: "visual-trump", rank: "Т", suit: "♥" },
    trumpSuit: "♥"
  };
  let actionRequests = 0;
  const actionRequestBodies = [];

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
      actionRequestBodies.push({ action: body.action, cardIds: Array.isArray(body.cardIds) ? body.cardIds.map(String) : [] });
      const ids = Array.isArray(body.cardIds) ? body.cardIds.map(String) : [];
      const cards = currentGame.hand.filter(item => ids.includes(String(item.id)));
      if (body.action === "attack" && cards.length) {
        const playedIds = new Set(cards.map(item => String(item.id)));
        currentGame.hand = currentGame.hand.filter(item => !playedIds.has(String(item.id)));
        currentGame.table = cards.map(card => ({ attack: card, defense: null }));
        currentGame.phase = "defense";
        currentGame.players[0].cardsCount = currentGame.hand.length;
      }
      // Keep the response pending long enough to observe the real release animation
      // before the server-confirmed render replaces the flying DOM element.
      await new Promise(resolve => setTimeout(resolve, 700));
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


    // During a rematch, the opponent's seat itself must show a ready checkmark.
    const readyBadgeAudit = await page.evaluate(() => {
      syncDurakRematchReadyBadges([
        { label: "Ты", isMe: true, isReady: false },
        { label: "Соперник", isMe: false, isReady: true }
      ], "finished");
      const seat = document.querySelector('#durakPlayers .durak-player[data-player-index="1"]');
      const badge = seat?.querySelector(".durak-ready-badge");
      const result = {
        badgeText: badge?.textContent || "",
        badgeReadyClass: !!badge?.classList.contains("is-ready"),
        opponentName: seat?.querySelector(".durak-player-name")?.textContent || ""
      };
      syncDurakRematchReadyBadges([], "playing");
      return result;
    });
    fs.writeFileSync(path.join(out, "rematch-ready-badge.json"), JSON.stringify(readyBadgeAudit, null, 2));
    if (readyBadgeAudit.badgeText !== "✅ ГОТОВ" || !readyBadgeAudit.badgeReadyClass ||
        readyBadgeAudit.opponentName !== "Соперник") {
      throw new Error("У готового противника не отображается галочка рядом с его местом: " + JSON.stringify(readyBadgeAudit));
    }

    // Check ALLCOINS hand ordering and the new table wordmark before interacting.
    const handDisplay = await page.evaluate(() => {
      const normalizeSuit = value => ({ "♤":"♠", "♡":"♥", "♢":"♦", "♧":"♣" }[String(value)] || String(value));
      const cards = [...document.querySelectorAll("#durakHand .durak-card")].map(card => ({
        id: card.dataset.cardId,
        rank: card.dataset.rank || "",
        suit: card.dataset.suit || ""
      }));
      const logoContent = getComputedStyle(document.getElementById("durakTable"), "::before").content;
      const trump = "♥";
      const lastTrumpIndex = cards.reduce((last, card, index) => normalizeSuit(card.suit) === trump ? index : last, -1);
      const rankWeight = value => {
        const v = String(value).toUpperCase();
        const face = { "В": 11, "J": 11, "Д": 12, "Q": 12, "К": 13, "K": 13, "Т": 14, "ТУЗ": 14, "A": 14 };
        return Number(v) || face[v] || 0;
      };
      const suitOrder = ["♠","♥","♦","♣"];
      const groupSequence = cards.reduce((groups, card) => {
        const suit = normalizeSuit(card.suit);
        if (groups[groups.length - 1] !== suit) groups.push(suit);
        return groups;
      }, []);
      const presentSuits = [...new Set(cards.map(card => normalizeSuit(card.suit)))];
      const expectedGroupSequence = suitOrder.filter(suit =>
        presentSuits.includes(suit) && suit !== trump
      );
      const lastNonTrumpIndex = cards.reduce((last, card, index) => normalizeSuit(card.suit) !== trump ? index : last, -1);
      const trumpsStayOnRight = !presentSuits.includes(trump) ||
        (lastTrumpIndex > lastNonTrumpIndex &&
         cards.slice(lastNonTrumpIndex + 1).every(card => normalizeSuit(card.suit) === trump));
      const nonTrumpGroups = groupSequence.filter((suit, index) =>
        suit !== trump && groupSequence.indexOf(suit) === index
      );
      const suitGroupsTogetherAndOrdered =
        nonTrumpGroups.length === expectedGroupSequence.length &&
        nonTrumpGroups.every((suit, index) => suit === expectedGroupSequence[index]);
      const ranksAscWithinSuit = cards.every((card, index) => {
        if (index === 0) return true;
        const previous = cards[index - 1];
        return normalizeSuit(previous.suit) !== normalizeSuit(card.suit) ||
          rankWeight(previous.rank) <= rankWeight(card.rank);
      });
      return {
        cards,
        lastTrumpIndex,
        trumpsStayOnRight,
        suitGroupsTogetherAndOrdered,
        ranksAscWithinSuit,
        logoContent
      };
    });
    fs.writeFileSync(path.join(out, "hand-order-and-logo.json"), JSON.stringify(handDisplay, null, 2));
    if (!handDisplay.trumpsStayOnRight || !handDisplay.suitGroupsTogetherAndOrdered || !handDisplay.ranksAscWithinSuit) {
      throw new Error("Козыри должны быть справа, а внутри каждой масти карты должны идти слева направо от младшей к старшей: " + JSON.stringify(handDisplay));
    }
    if (!String(handDisplay.logoContent).includes("ALLCOINS")) {
      throw new Error("Логотип ALLCOINS не виден на игровой зоне: " + String(handDisplay.logoContent));
    }


    // Keep user's PNG artwork and confirm remaining cards render via the built-in fallback.
    const fullDeckAssetReport = await page.evaluate(async () => {
      const host = document.createElement("div");
      host.id = "full-deck-asset-check";
      Object.assign(host.style, {
        position: "fixed", left: "-10000px", top: "0", width: "1px", height: "1px",
        overflow: "hidden", opacity: "0", pointerEvents: "none"
      });
      document.body.appendChild(host);
      const ranks = ["2","3","4","5","6","7","8","9","10","В","Д","К","Туз"];
      const suits = ["♠","♥","♦","♣"];
      const checks = [];
      for (const rank of ranks) {
        for (const suit of suits) {
          const card = createDurakCardElement({ id: "asset-check-" + rank + suit, rank, suit });
          card.style.width = "65px";
          card.style.height = "98px";
          host.appendChild(card);
          checks.push({ rank, suit, image: card.querySelector("img") });
        }
      }
      const settled = await Promise.all(checks.map(async item => {
        const img = item.image;
        if (!img) return { rank:item.rank, suit:item.suit, loaded:true, src:null };
        try {
          await img.decode();
          return { rank:item.rank, suit:item.suit, loaded:img.naturalWidth > 0 && img.naturalHeight > 0, src:img.getAttribute("src") };
        } catch (_) {
          return { rank:item.rank, suit:item.suit, loaded:false, src:img.getAttribute("src") };
        }
      }));
      host.remove();
      return {
        total: settled.length,
        loaded: settled.filter(item => item.loaded).length,
        missing: settled.filter(item => !item.loaded),
        pngFaces: settled.filter(item => item.loaded && String(item.src).split("?")[0].endsWith(".png")).length,
        svgFaces: settled.filter(item => item.loaded && String(item.src).split("?")[0].endsWith(".svg")).length
      };
    });
    fs.writeFileSync(path.join(out, "full-deck-asset-report.json"), JSON.stringify(fullDeckAssetReport, null, 2));
    if (fullDeckAssetReport.total !== 52 || fullDeckAssetReport.loaded !== 52 ||
        fullDeckAssetReport.svgFaces !== 0 || fullDeckAssetReport.pngFaces !== 11) {
      throw new Error("Не все 52 карты ALLCOINS имеют готовые загружаемые изображения: " + JSON.stringify(fullDeckAssetReport));
    }


    // A true visual audit sheet makes every updated card face visible at once.
    await page.setViewportSize({ width: 1100, height: 620 });
    const contactSheetAudit = await page.evaluate(async () => {
      const existing = document.getElementById("full-deck-contact-sheet");
      existing?.remove();
      const host = document.createElement("div");
      host.id = "full-deck-contact-sheet";
      Object.assign(host.style, {
        position: "fixed", inset: "0", zIndex: "2147483647",
        display: "grid", gridTemplateColumns: "repeat(13, 70px)",
        gridAutoRows: "106px", gap: "6px", padding: "12px",
        boxSizing: "border-box", width: "1100px", height: "620px",
        overflow: "hidden", alignContent: "start",
        background: "radial-gradient(ellipse at top, #2b4557, #101b25)"
      });
      (document.getElementById("durakGame") || document.body).appendChild(host);
      const ranks = ["2","3","4","5","6","7","8","9","10","В","Д","К","Туз"];
      const suits = ["♠","♥","♦","♣"];
      const checks = [];
      for (const rank of ranks) {
        for (const suit of suits) {
          const card = createDurakCardElement({ id: "preview-" + rank + suit, rank, suit });
          card.dataset.previewCard = rank + suit;
          Object.assign(card.style, {
            flex: "none", width: "70px", minWidth: "70px", maxWidth: "70px",
            height: "106px", minHeight: "106px", margin: "0",
            borderRadius: "5px", boxSizing: "border-box", overflow: "hidden",
            background: "#fffdf8", border: "1px solid #d0bd8a"
          });
          const image = card.querySelector("img");
          if (image) Object.assign(image.style, {
            display: "block", width: "100%", height: "100%",
            minWidth: "0", minHeight: "0", maxWidth: "100%", maxHeight: "100%",
            objectFit: "contain", objectPosition: "center",
            margin: "0", padding: "0", pointerEvents: "none"
          });
          host.appendChild(card);
          checks.push({ rank, suit, element: card, image });
        }
      }
      const results = await Promise.all(checks.map(async item => {
        let loaded = !item.image;
        try {
          if (item.image) {
            await item.image.decode();
            loaded = item.image.naturalWidth > 0 && item.image.naturalHeight > 0;
          }
        } catch (_) {}
        return {
          card: item.rank + item.suit,
          src: item.image?.getAttribute("src") || null,
          loaded,
          width: item.image?.naturalWidth || 0,
          height: item.image?.naturalHeight || 0
        };
      }));
      return {
        count: results.length,
        loadedCount: results.filter(item => item.loaded).length,
        failed: results.filter(item => !item.loaded),
        pngCount: results.filter(item => item.loaded && item.src && String(item.src).split("?")[0].endsWith(".png")).length,
        svgCount: results.filter(item => item.loaded && item.src && String(item.src).split("?")[0].endsWith(".svg")).length
      };
    });
    await page.screenshot({ path: path.join(out, "full-deck-contact-sheet.png"), fullPage: false });
    fs.writeFileSync(path.join(out, "full-deck-contact-sheet-report.json"), JSON.stringify(contactSheetAudit, null, 2));
    await page.evaluate(() => document.getElementById("full-deck-contact-sheet")?.remove());
    await page.setViewportSize({ width: 390, height: 844 });
    if (contactSheetAudit.count !== 52 || contactSheetAudit.loadedCount !== 52 ||
        contactSheetAudit.svgCount !== 0 || contactSheetAudit.pngCount !== 11) {
      throw new Error("Визуальный лист ALLCOINS: не все карты видны и загружены: " + JSON.stringify(contactSheetAudit));
    }

    const card = page.locator('#durakHand .durak-card[data-card-id="visual-card-1"]');
    const sameRankCard = page.locator('#durakHand .durak-card[data-card-id="visual-card-2"]');
    if (!(await card.count()) || !(await sameRankCard.count())) throw new Error("Тестовые карты не отрисовались настоящим рендерером ALLCOINS");
    // Выбираем две одинаковые по достоинству карты; один бросок должен отправить обе.
    await card.click();
    await sameRankCard.click();
    const selectedGroupCount = await page.locator('#durakHand .durak-card[data-group-selected="true"]').count();
    if (selectedGroupCount !== 2) throw new Error("Не удалось выбрать группу одинаковых карт для одного броска");
    const cardRect = await card.boundingBox();
    const tableRect = await page.locator("#durakTable").boundingBox();
    if (!cardRect || !tableRect || tableRect.width < 20 || tableRect.height < 20) {
      throw new Error("Карта или зона стола не имеет видимых размеров");
    }

    const startX = cardRect.x + cardRect.width / 2;
    const startY = cardRect.y + cardRect.height / 2;
    // Throw horizontally toward a screen edge, not toward the table.
    // The game should still send the card to its proper slot automatically.
    const viewportWidth = page.viewportSize().width;
    const targetX = startX < viewportWidth / 2 ? viewportWidth - 8 : 8;
    const targetY = startY;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move((startX + targetX) / 2, (startY + targetY) / 2, { steps: 5 });
    await page.waitForTimeout(80);
    await page.screenshot({ path: path.join(out, "03-game-card-being-dragged.png"), fullPage: true });
    await page.mouse.move(targetX, targetY, { steps: 12 });
    await page.mouse.up();
    const flyer = page.locator("body > .durak-flying-card, #durakGame .durak-flying-card").first();
    const flyerAtRelease = await flyer.boundingBox();
    // Карта должна продолжать движение после отпускания, а затем быстро
    // смениться видимой картой в точке посадки (без зависшей копии над столом).
    await page.waitForTimeout(55);
    const flyerInFlight = await flyer.boundingBox();
    await page.screenshot({ path: path.join(out, "04-game-in-flight-after-release.png"), fullPage: true });
    const animationMoved = Boolean(
      flyerAtRelease && flyerInFlight &&
      (Math.abs(flyerInFlight.x - flyerAtRelease.x) > 3 ||
       Math.abs(flyerInFlight.y - flyerAtRelease.y) > 3)
    );
    const flyerShrankToTableSize = Boolean(
      flyerAtRelease && flyerInFlight &&
      flyerInFlight.width < flyerAtRelease.width * 0.95 &&
      flyerInFlight.height < flyerAtRelease.height * 0.95
    );
    await page.waitForTimeout(140);
    const optimisticLanding = await page.evaluate(() => {
      const element = document.querySelector('#durakTable .durak-landing-target[data-optimistic-landing="true"]');
      if (!element) return null;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        visible: style.visibility !== "hidden" && Number(style.opacity) > 0.9,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
      };
    });
    await page.screenshot({ path: path.join(out, "04b-game-card-landed-before-server-reply.png"), fullPage: true });
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(out, "05-game-after-drop.png"), fullPage: true });

    // Regression guard: after the initial landing and the server-confirmed redraw,
    // table cards must remain 56×84 instead of expanding to the old 68×100 hand size.
    const tableSizeAfterRerender = await page.evaluate(async () => {
      const cards = [...document.querySelectorAll("#durakTable .durak-card.table-card")];
      const before = cards.map(card => {
        const rect = card.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      });
      cards.forEach(card => {
        // Simulate an older CSS/JS rule attempting to enlarge the card after landing.
        card.style.setProperty("width", "68px", "important");
        card.style.setProperty("height", "100px", "important");
      });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await new Promise(resolve => setTimeout(resolve, 45));
      const after = cards.map(card => {
        const rect = card.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      });
      return { before, after };
    });
    fs.writeFileSync(path.join(out, "table-card-size-lock.json"), JSON.stringify(tableSizeAfterRerender, null, 2));
    if (tableSizeAfterRerender.after.length !== 2 ||
        tableSizeAfterRerender.after.some(size => Math.abs(size.width - 56) > 0.5 || Math.abs(size.height - 84) > 0.5)) {
      throw new Error("Размер карты на столе изменился после перерисовки/позднего CSS-правила: " + JSON.stringify(tableSizeAfterRerender));
    }

    const diagnostics = await page.evaluate(() => {
      const deck = document.getElementById("durakTrump");
      const deckRect = deck?.getBoundingClientRect();
      const trump = deck?.querySelector(".durak-trump-card");
      const trumpRect = trump?.getBoundingClientRect();
      const deckBackCards = [...(deck?.querySelectorAll(".durak-deck-card-back") || [])];
      const deckBackStyles = deckBackCards.map(card => getComputedStyle(card));
      const cardRects = [...document.querySelectorAll('#durakTable .durak-card.table-card[data-table-card-type="attack"], #durakTable .durak-card.table-card[data-table-card-type="defense"]')].map(card => {
        const r = card.getBoundingClientRect();
        return { x:r.x, y:r.y, right:r.right, bottom:r.bottom };
      });
      const deckOverlapsTableCards = Boolean(deckRect) && cardRects.some(r =>
        r.right > deckRect.left + 1 && r.x < deckRect.right - 1 &&
        r.bottom > deckRect.top + 1 && r.y < deckRect.bottom - 1
      );
      return {
        title: document.title,
        viewport: { width: innerWidth, height: innerHeight },
        documentWidth: document.documentElement.scrollWidth,
        documentHeight: document.documentElement.scrollHeight,
        handCardsAfterDrop: document.querySelectorAll("#durakHand .durak-card").length,
        tableAttackCardsAfterDrop: document.querySelectorAll('#durakTable .durak-card[data-table-card-type="attack"]').length,
        flyingCardsAfterDrop: document.querySelectorAll(".durak-flying-card").length,
        deckRect: deckRect ? {x:deckRect.x,y:deckRect.y,width:deckRect.width,height:deckRect.height} : null,
        trumpRect: trumpRect ? {x:trumpRect.x,y:trumpRect.y,right:trumpRect.right,bottom:trumpRect.bottom,width:trumpRect.width,height:trumpRect.height} : null,
        deckOverlapsTableCards,
        deckBackCards: deckBackCards.length,
        deckBackHasPattern: deckBackCards.length >= 3 && deckBackStyles.every(style =>
          style.backgroundImage.includes("repeating-linear-gradient") &&
          style.borderTopColor !== "rgb(212, 175, 55)"
        ),
        imageCards: [...document.querySelectorAll('#durakHand img, #durakTable img')].map(img => ({
          src: img.getAttribute("src"),
          loaded: img.complete && img.naturalWidth > 0
        }))
      };
    });
    const animationDiagnostics = {
      flyerPresentImmediatelyAfterRelease: Boolean(flyerAtRelease),
      flyerMovedDuringReleaseAnimation: animationMoved,
      flyerShrankToTableSizeDuringReleaseAnimation: flyerShrankToTableSize,
      optimisticLandingVisibleBeforeServerReply: Boolean(optimisticLanding?.visible),
      optimisticLanding,
      flyerAtRelease,
      flyerInFlight
    };
    fs.writeFileSync(path.join(out, "diagnostics.json"), JSON.stringify({ diagnostics, animationDiagnostics, errors, actionRequests }, null, 2));

    if (diagnostics.documentWidth > diagnostics.viewport.width + 2) {
      throw new Error("Горизонтальное переполнение: " + diagnostics.documentWidth + "px при viewport " + diagnostics.viewport.width + "px");
    }
    if (!flyerAtRelease) {
      throw new Error("После отпускания карты не найден летящий элемент анимации");
    }
    if (!animationMoved) {
      throw new Error("Карта не перемещалась после отпускания пальца: анимация приземления не подтверждена");
    }
    if (!flyerShrankToTableSize) {
      throw new Error("Летящая карта осталась размером руки и должна плавно уменьшиться до размера ячейки стола: " +
        JSON.stringify({ flyerAtRelease, flyerInFlight }));
    }
    if (!optimisticLanding?.visible) {
      throw new Error("Карта не закрепилась в точке посадки до ответа сервера");
    }
    if (Math.abs((optimisticLanding?.width ?? 0) - 56) > 0.5 ||
        Math.abs((optimisticLanding?.height ?? 0) - 84) > 0.5) {
      throw new Error("Временная карта на столе уже в момент посадки должна быть 56×84: " + JSON.stringify(optimisticLanding));
    }
    if (diagnostics.tableAttackCardsAfterDrop !== 2) {
      throw new Error("Один бросок должен положить на стол две одинаковые карты. Карты на столе: " + diagnostics.tableAttackCardsAfterDrop);
    }
    if (diagnostics.handCardsAfterDrop !== 1) {
      throw new Error("После группового хода ожидается 1 карта в руке, найдено: " + diagnostics.handCardsAfterDrop);
    }
    if (diagnostics.flyingCardsAfterDrop !== 0) {
      throw new Error("После завершения анимации осталась летающая копия карты");
    }
    if (diagnostics.deckOverlapsTableCards) {
      throw new Error("Колода закрывает карты на игровом столе");
    }
    if (!diagnostics.deckBackHasPattern || diagnostics.deckBackCards < 3) {
      throw new Error("Рубашка колоды с диагональным узором не отрисована");
    }
    if (!diagnostics.deckRect || diagnostics.deckRect.x > 20 ||
        diagnostics.deckRect.y < diagnostics.viewport.height * 0.15 ||
        diagnostics.deckRect.y > diagnostics.viewport.height * 0.36) {
      throw new Error("Колода находится не в компактной левой зоне, как на видео");
    }
    if (!diagnostics.trumpRect || diagnostics.trumpRect.x >= 0 ||
        diagnostics.trumpRect.right < 30 || diagnostics.trumpRect.width < 38) {
      throw new Error("Козырь должен выглядывать из колоды у левого края экрана");
    }
    if (actionRequests !== 1) throw new Error("Ожидался ровно один запрос хода, получено: " + actionRequests);
    if (actionRequestBodies.length !== 1 || actionRequestBodies[0].cardIds.length !== 2) {
      throw new Error("Групповой бросок должен отправить оба ID одинаковых карт одним запросом: " + JSON.stringify(actionRequestBodies));
    }

    // Теперь имитируем новый бросок противника: карта должна прилететь от его места к столу.
    currentGame.table = [];
    currentGame.attackerIndex = 0;
    currentGame.defenderIndex = 1;
    currentGame.phase = "attack";
    await page.evaluate(() => loadDurakGame("visual-test-room"));
    currentGame.attackerIndex = 1;
    currentGame.defenderIndex = 0;
    currentGame.phase = "defense";
    // Queen of hearts uses the user's custom PNG, so this also checks artwork readiness.
    currentGame.table = [{ attack: { id: "incoming-attack-1", rank: "Д", suit: "♥" }, defense: null }];
    await page.evaluate(() => loadDurakGame("visual-test-room"));
    await page.waitForTimeout(70);
    const incomingFlyer = page.locator('.durak-flying-card[data-incoming-attack="true"]');
    if (!(await incomingFlyer.count())) {
      throw new Error("Новая атакующая карта соперника не начала полёт от его места к столу");
    }
    const incomingStart = await incomingFlyer.boundingBox();
    const incomingFlightImage = await page.evaluate(() => {
      const card = document.querySelector('.durak-flying-card[data-incoming-attack="true"]');
      const image = card?.querySelector("img");
      const style = image ? getComputedStyle(image) : null;
      return {
        cardExists: !!card,
        imageExists: !!image,
        imageVisible: !!style && style.visibility !== "hidden" && Number(style.opacity) > 0.9,
        imageLoaded: !image || (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0)
      };
    });
    if (!incomingFlightImage.cardExists || !incomingFlightImage.imageExists ||
        !incomingFlightImage.imageVisible || !incomingFlightImage.imageLoaded) {
      throw new Error("Лицо PNG должно быть полностью загружено и видно уже во время полёта, а не появляться скачком при посадке: " + JSON.stringify(incomingFlightImage));
    }
    // The reference-style incoming card now follows a slower curved flight.
    await page.waitForTimeout(525);
    const incomingEnd = await page.evaluate(() => {
      const card = document.querySelector('#durakTable .durak-card[data-card-id="incoming-attack-1"]');
      if (!card) return null;
      const style = getComputedStyle(card);
      const rect = card.getBoundingClientRect();
      const image = card.querySelector("img");
      const imageRect = image?.getBoundingClientRect();
      return {
        visible: style.visibility !== "hidden" && Number(style.opacity) > 0.9,
        x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        imageLoaded: !image || (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0),
        imageNaturalWidth: image?.naturalWidth || 0,
        imageRect: imageRect ? { width: imageRect.width, height: imageRect.height } : null,
        // Keep the image inside the card's 1px border; the border itself is not image area.
        imageFitsCard: !image || (imageRect.width >= rect.width - 3 && imageRect.height >= rect.height - 3)
      };
    });
    if (!incomingStart || !incomingEnd?.visible || await incomingFlyer.count() !== 0) {
      throw new Error("Анимация атаки соперника не завершилась посадкой карты на стол");
    }
    if (!incomingEnd.imageLoaded || !incomingEnd.imageFitsCard ||
        Math.abs(incomingEnd.width - 56) > 0.5 || Math.abs(incomingEnd.height - 84) > 0.5) {
      throw new Error("После анимации лицо карты должно быть полностью загружено и занять всю карту 56×84: " + JSON.stringify(incomingEnd));
    }

    // Regression check for the video layout:
    // defence may overlap its own attack, but must not overlap the next attack.
    currentGame.table = [
      {
        attack: { id: "spacing-attack-1", rank: "9", suit: "♠" },
        defense: { id: "spacing-defense-1", rank: "Т", suit: "♠" }
      },
      {
        attack: { id: "spacing-attack-2", rank: "10", suit: "♦" },
        defense: { id: "spacing-defense-2", rank: "В", suit: "♦" }
      },
      {
        attack: { id: "spacing-attack-3", rank: "Д", suit: "♥" },
        defense: null
      }
    ];
    currentGame.phase = "defense";
    currentGame.attackerIndex = 1;
    currentGame.defenderIndex = 0;
    await page.evaluate(() => loadDurakGame("visual-test-room"));
    // Let the opponent's cards complete their flight before measuring final positions.
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(out, "06-game-card-pair-spacing.png"), fullPage: true });

    const pairSpacing = await page.evaluate(() => {
      const table = document.getElementById("durakTable");
      const pairs = [...(table?.querySelectorAll(".durak-table-pair") || [])].map((pair, index) => {
        const attack = pair.querySelector('.durak-card.table-card[data-table-card-type="attack"]');
        const defense = pair.querySelector('.durak-card.table-card[data-table-card-type="defense"]');
        const rect = element => {
          if (!element) return null;
          const r = element.getBoundingClientRect();
          return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
        };
        return { index, pair: rect(pair), attack: rect(attack), defense: rect(defense) };
      });
      const gaps = [];
      for (let i = 0; i < pairs.length - 1; i++) {
        if (pairs[i].defense && pairs[i + 1].attack) {
          gaps.push({
            fromPair: i,
            toPair: i + 1,
            px: pairs[i + 1].attack.x - pairs[i].defense.right,
            sameRow: Math.abs(pairs[i + 1].attack.y - pairs[i].defense.y) < 20
          });
        }
      }
      return { viewport: { width: innerWidth, height: innerHeight }, table: rectTable(table), pairs, gaps };
      function rectTable(element) {
        if (!element) return null;
        const r = element.getBoundingClientRect();
        return { x:r.x, y:r.y, width:r.width, height:r.height };
      }
    });
    fs.writeFileSync(path.join(out, "pair-spacing.json"), JSON.stringify(pairSpacing, null, 2));
    if (pairSpacing.pairs.length !== 3) {
      throw new Error("Тест расстояния ожидал 3 пары карт; получено " + pairSpacing.pairs.length);
    }
    const overlappingNextAttack = pairSpacing.gaps.find(gap => gap.px < 8 && gap.sameRow);
    if (overlappingNextAttack) {
      throw new Error("Защита перекрывает следующую атакующую карту. Расстояние: " + overlappingNextAttack.px + "px. См. pair-spacing.json");
    }

    // Visual regression: when the defender takes, cards already on the table
    // must reach the defender's hand before any player receives a card from deck.
    currentGame.players[0].cardsCount = currentGame.hand.length;
    currentGame.players[1].cardsCount = 5;
    currentGame.hand = currentGame.hand.slice(0, 1);
    currentGame.phase = "defense";
    currentGame.attackerIndex = 1;
    currentGame.defenderIndex = 0;
    currentGame.takePending = false;
    currentGame.table = [
      {
        attack: { id: "take-attack-1", rank: "9", suit: "♠" },
        defense: { id: "take-defense-1", rank: "Т", suit: "♠" }
      },
      {
        attack: { id: "take-attack-2", rank: "10", suit: "♦" },
        defense: null
      }
    ];
    await page.evaluate(() => loadDurakGame("visual-test-room"));
    await page.waitForTimeout(750);
    await page.screenshot({ path: path.join(out, "07-before-defender-takes.png"), fullPage: true });

    await page.evaluate(() => {
      window.__dealFlightEvents = [];
      if (window.__dealFlightObserver) window.__dealFlightObserver.disconnect();
      window.__dealFlightObserver = new MutationObserver(records => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node.nodeType === 1 && node.classList?.contains("durak-deal-flyer")) {
              window.__dealFlightEvents.push({
                source: node.dataset.dealSource || "unknown",
                at: performance.now()
              });
            }
          }
        }
      });
      window.__dealFlightObserver.observe(document.body, { childList: true, subtree: true });
    });

    const takenCards = currentGame.table.flatMap(pair => [pair.attack, pair.defense]).filter(Boolean);
    currentGame.hand.push(...takenCards);
    currentGame.table = [];
    currentGame.players[0].cardsCount = currentGame.hand.length;
    currentGame.players[1].cardsCount = 6;
    currentGame.cardsLeft = 17;
    await page.evaluate(() => { void loadDurakGame("visual-test-room"); });
    await page.waitForFunction(() => window.__dealFlightEvents?.some(event => event.source === "table"), { timeout: 5000 });
    await page.waitForTimeout(180);
    await page.screenshot({ path: path.join(out, "08-table-cards-flying-to-defender.png"), fullPage: true });
    await page.waitForFunction(() => window.__dealFlightEvents?.some(event => event.source === "deck"), { timeout: 7000 });
    await page.screenshot({ path: path.join(out, "09-deck-draw-starts-after-table-pickup.png"), fullPage: true });
    await page.waitForTimeout(800);

    const pickupOrder = await page.evaluate(() => {
      const events = window.__dealFlightEvents || [];
      const tableEvents = events.filter(event => event.source === "table");
      const deckEvents = events.filter(event => event.source === "deck");
      return {
        events,
        tableCount: tableEvents.length,
        deckCount: deckEvents.length,
        lastTableStart: tableEvents.length ? Math.max(...tableEvents.map(event => event.at)) : null,
        firstDeckStart: deckEvents.length ? Math.min(...deckEvents.map(event => event.at)) : null,
        handCards: document.querySelectorAll("#durakHand .durak-card").length,
        tableCards: document.querySelectorAll("#durakTable .durak-card.table-card").length,
        remainingFlyingCards: document.querySelectorAll(".durak-deal-flyer").length
      };
    });
    fs.writeFileSync(path.join(out, "take-pickup-order.json"), JSON.stringify(pickupOrder, null, 2));
    if (pickupOrder.tableCount !== 3) {
      throw new Error("При взятии ожидались 3 полёта карт со стола, получено " + pickupOrder.tableCount);
    }
    if (pickupOrder.deckCount !== 1) {
      throw new Error("После взятия ожидался 1 добор из колоды сопернику, получено " + pickupOrder.deckCount);
    }
    if (pickupOrder.firstDeckStart === null || pickupOrder.lastTableStart === null ||
        pickupOrder.firstDeckStart < pickupOrder.lastTableStart + 450) {
      throw new Error("Карты из колоды начали лететь до завершения взятия карт со стола: " + JSON.stringify(pickupOrder));
    }
    if (pickupOrder.tableCards !== 0 || pickupOrder.remainingFlyingCards !== 0) {
      throw new Error("После взятия на столе или в полёте остались лишние карты: " + JSON.stringify(pickupOrder));
    }
    if (pickupOrder.handCards !== 4) {
      throw new Error("В руке защищающегося ожидалось 4 карты после взятия, получено " + pickupOrder.handCards);
    }


    // Empty the deck to emulate drawing the final card (the trump itself).
    // It must disappear from beneath the pile while a clear suit marker remains on the table.
    currentGame.cardsLeft = 0;
    currentGame.trumpSuit = "♥";
    await page.evaluate(() => loadDurakGame("visual-test-room"));
    await page.waitForTimeout(160);
    await page.screenshot({ path: path.join(out, "10-trump-suit-marker-after-final-draw.png"), fullPage: true });
    const finalTrumpState = await page.evaluate(() => {
      const marker = document.querySelector("#durakTrump .durak-deck-stack .durak-trump-suit-marker");
      const deck = document.querySelector("#durakTrump");
      const stack = deck?.querySelector(".durak-deck-stack");
      const count = deck?.querySelector(".durak-deck-count");
      const markerRect = marker?.getBoundingClientRect();
      const stackRect = stack?.getBoundingClientRect();
      return {
        markerSuit: marker?.dataset.trumpSuit || null,
        markerText: marker?.textContent?.trim() || null,
        markerHasLabel: Boolean(marker?.querySelector(".durak-trump-suit-marker-label")),
        markerVisible: Boolean(markerRect && markerRect.width > 0 && markerRect.height > 0 &&
          getComputedStyle(marker).visibility !== "hidden"),
        markerX: markerRect?.x ?? null,
        markerY: markerRect?.y ?? null,
        stackX: stackRect?.x ?? null,
        stackY: stackRect?.y ?? null,
        tableHasMarker: Boolean(document.querySelector("#durakTable .durak-trump-suit-marker")),
        deckCount: count ? Number(count.dataset.count) : null,
        trumpCardStillUnderDeck: Boolean(deck?.querySelector(".durak-trump-card"))
      };
    });
    fs.writeFileSync(path.join(out, "final-trump-state.json"), JSON.stringify(finalTrumpState, null, 2));
    if (finalTrumpState.markerSuit !== "♥" || finalTrumpState.markerText !== "♥" ||
        finalTrumpState.markerHasLabel || !finalTrumpState.markerVisible ||
        finalTrumpState.tableHasMarker || finalTrumpState.deckCount !== 0 ||
        finalTrumpState.trumpCardStillUnderDeck ||
        finalTrumpState.markerX === null || finalTrumpState.markerX < finalTrumpState.stackX - 3 ||
        finalTrumpState.markerX > finalTrumpState.stackX + 50 ||
        finalTrumpState.markerY < finalTrumpState.stackY + 5 ||
        finalTrumpState.markerY > finalTrumpState.stackY + 30) {
      throw new Error("После ухода последнего козыря должен остаться только символ масти в прежнем месте у колоды: " + JSON.stringify(finalTrumpState));
    }

    if (errors.length) {
      fs.writeFileSync(path.join(out, "browser-errors.txt"), errors.join("\n"));
      throw new Error("Есть ошибки браузера: " + errors.length + ". См. visual-test-output/browser-errors.txt");
    }
    console.log("Mobile drag/drop visual test passed:", JSON.stringify({ diagnostics, animationDiagnostics }));
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
