const { chromium } = require("playwright");
const assert = require("node:assert/strict");
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
    // Checkers pieces must each carry the ALLCOINS logo, on both white and black disks.
    const checkersPage = await browser.newPage({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true
    });
    await checkersPage.addInitScript(() => {
      window.Telegram = { WebApp: { initData: "", ready() {}, expand() {}, BackButton: { show() {}, hide() {} } } };
    });
    await checkersPage.route("**/telegram-web-app.js", route => route.fulfill({
      status: 200, contentType: "application/javascript", body: "// Telegram WebApp mocked for checkers visual test.\\n"
    }));
    await checkersPage.goto("http://127.0.0.1:4173/checkers.html?v=20261024-allcoins-logo8",
      { waitUntil: "domcontentloaded", timeout: 30000 });
    await checkersPage.locator("#startBot").click();
    await checkersPage.waitForFunction(() => document.querySelectorAll("#board .piece").length === 24 &&
      document.querySelectorAll("#board .piece-logo svg").length === 24, { timeout: 10000 });
    const initialCheckersDiagnostics = await checkersPage.evaluate(() => {
      const pieces = Array.from(document.querySelectorAll("#board .piece"));
      const row = piece => Number(piece.closest(".square")?.dataset.r);
      const crownProbe = pieces[0];
      crownProbe.classList.add("king");
      const crownMark = crownProbe.querySelector(".piece-king-mark");
      const crown = crownMark ? getComputedStyle(crownMark) : null;
      const logo = crownProbe.querySelector(".piece-logo");
      const logoStyle = logo ? getComputedStyle(logo) : null;
      return {
        pieces: pieces.length,
        whiteBottom: pieces.filter(piece => piece.classList.contains("white") && row(piece) >= 5).length,
        blackTop: pieces.filter(piece => piece.classList.contains("black") && row(piece) <= 2).length,
        humanColorNote: document.getElementById("humanColorNote")?.textContent,
        botColorNote: document.getElementById("botColorNote")?.textContent,
        turnStatus: document.getElementById("turnStatus")?.textContent,
        crownHasSvg: Boolean(crownMark?.querySelector("svg path")),
        crownDisplay: crown?.display || null,
        crownWidth: crown?.width || null,
        crownHeight: crown?.height || null,
        crownZIndex: crown?.zIndex || null,
        crownBorderRadius: crown?.borderRadius || null,
        logoDisplay: logoStyle?.display || null
      };
    });
    assert.equal(initialCheckersDiagnostics.pieces, 24, "Первая партия должна начинаться с 24 шашек");
    assert.equal(initialCheckersDiagnostics.whiteBottom, 12, "В первой партии белые должны быть у игрока снизу");
    assert.equal(initialCheckersDiagnostics.blackTop, 12, "В первой партии чёрные должны быть у соперника сверху");
    assert.match(initialCheckersDiagnostics.humanColorNote, /белыми/, "Игрок должен видеть подпись белых");
    assert.match(initialCheckersDiagnostics.botColorNote, /чёрные/, "Соперник должен видеть подпись чёрных");
    assert.equal(initialCheckersDiagnostics.crownHasSvg, true, "На дамке должен появляться фирменный значок короны");
    assert.equal(initialCheckersDiagnostics.crownDisplay, "grid", "Значок дамки должен отображаться вместо логотипа");
    assert.ok(parseFloat(initialCheckersDiagnostics.crownWidth) > 10 && parseFloat(initialCheckersDiagnostics.crownHeight) > 10,
      "Значок дамки должен занимать место логотипа: " + JSON.stringify(initialCheckersDiagnostics));
    assert.equal(initialCheckersDiagnostics.crownZIndex, "4", "Значок дамки должен быть поверх внутреннего слоя шашки");
    assert.match(initialCheckersDiagnostics.crownBorderRadius, /50%/, "Значок дамки должен быть круглым медальоном");
    assert.equal(initialCheckersDiagnostics.logoDisplay, "none", "На дамке логотип ALLCOINS должен скрываться под значком короны");

    await checkersPage.locator("#newGame").click();
    await checkersPage.waitForTimeout(100);
    const blackRematchDiagnostics = await checkersPage.evaluate(() => {
      const pieces = Array.from(document.querySelectorAll("#board .piece"));
      const row = piece => Number(piece.closest(".square")?.dataset.r);
      return {
        whiteTop: pieces.filter(piece => piece.classList.contains("white") && row(piece) <= 2).length,
        blackBottom: pieces.filter(piece => piece.classList.contains("black") && row(piece) >= 5).length,
        humanColorNote: document.getElementById("humanColorNote")?.textContent,
        botColorNote: document.getElementById("botColorNote")?.textContent,
        turnStatus: document.getElementById("turnStatus")?.textContent,
        bottomBlackLogos: pieces.filter(piece => piece.classList.contains("black") && row(piece) >= 5)
          .filter(piece => Boolean(piece.querySelector(".piece-logo svg"))).length
      };
    });
    fs.writeFileSync(path.join(out, "checkers-black-rematch-report.json"), JSON.stringify(blackRematchDiagnostics, null, 2));
    assert.equal(blackRematchDiagnostics.whiteTop, 12, "После рематча белые должны перейти к сопернику");
    assert.equal(blackRematchDiagnostics.blackBottom, 12, "После рематча игрок должен получить чёрные шашки");
    assert.match(blackRematchDiagnostics.humanColorNote, /чёрными/, "Подпись игрока должна поменяться на чёрные");
    assert.match(blackRematchDiagnostics.botColorNote, /белые/, "Подпись соперника должна поменяться на белые");
    assert.match(blackRematchDiagnostics.turnStatus, /чёрные/, "Игрок с чёрными шашками должен ходить первым");
    assert.equal(blackRematchDiagnostics.bottomBlackLogos, 12, "Логотип должен остаться на всех чёрных шашках после рематча");

    // The king crown must visibly cover the top peak of the ALLCOINS mark.
    await checkersPage.locator("#board .piece.black").first().evaluate(piece => piece.classList.add("king"));
    await checkersPage.screenshot({ path: path.join(out, "checkers-black-rematch-crown-logo.png"), fullPage: true });

    // The next rematch restores white, and the visible "Играть ещё" button also alternates to black.
    await checkersPage.locator("#newGame").click();
    const whiteAgainDiagnostics = await checkersPage.evaluate(() => ({
      whiteBottom: Array.from(document.querySelectorAll("#board .piece.white"))
        .filter(piece => Number(piece.closest(".square")?.dataset.r) >= 5).length,
      turnStatus: document.getElementById("turnStatus")?.textContent
    }));
    assert.equal(whiteAgainDiagnostics.whiteBottom, 12, "Следующий рематч должен вернуть белые игроку");
    assert.match(whiteAgainDiagnostics.turnStatus, /белые/);
    await checkersPage.locator("#resultOverlay").evaluate(el => el.classList.remove("hidden"));
    await checkersPage.locator("#playAgain").click();
    const playAgainDiagnostics = await checkersPage.evaluate(() => ({
      blackBottom: Array.from(document.querySelectorAll("#board .piece.black"))
        .filter(piece => Number(piece.closest(".square")?.dataset.r) >= 5).length,
      humanColorNote: document.getElementById("humanColorNote")?.textContent
    }));
    assert.equal(playAgainDiagnostics.blackBottom, 12, "Кнопка «Играть ещё» должна переключать цвет игрока");
    assert.match(playAgainDiagnostics.humanColorNote, /чёрными/);

    const checkerPieceLogoDiagnostics = await checkersPage.evaluate(() => {
      const pieces = Array.from(document.querySelectorAll("#board .piece"));
      const logos = Array.from(document.querySelectorAll("#board .piece-logo"));
      return {
        pieces: pieces.length,
        logos: logos.length,
        whitePieces: pieces.filter(piece => piece.classList.contains("white")).length,
        blackPieces: pieces.filter(piece => piece.classList.contains("black")).length,
        logosWithSvg: logos.filter(logo => logo.querySelector("svg")).length,
        kingMarks: document.querySelectorAll("#board .piece-king-mark svg").length,
        visibleLogos: logos.filter(logo => {
          const r = logo.getBoundingClientRect();
          return r.width >= 10 && r.height >= 10 && getComputedStyle(logo).display !== "none" &&
            getComputedStyle(logo).visibility !== "hidden";
        }).length,
        kingsShowCrownInsteadOfLogo: Array.from(document.querySelectorAll("#board .piece.king"))
          .every(piece => getComputedStyle(piece.querySelector(".piece-logo")).display === "none" &&
            getComputedStyle(piece.querySelector(".piece-king-mark")).display === "grid")
      };
    });
    fs.writeFileSync(path.join(out, "checkers-piece-logo-report.json"),
      JSON.stringify(checkerPieceLogoDiagnostics, null, 2));
    assert.equal(checkerPieceLogoDiagnostics.pieces, 24,
      "На начальной доске должно быть 24 шашки: " + JSON.stringify(checkerPieceLogoDiagnostics));
    assert.equal(checkerPieceLogoDiagnostics.logos, 24,
      "На каждой шашке должен быть логотип ALLCOINS: " + JSON.stringify(checkerPieceLogoDiagnostics));
    assert.equal(checkerPieceLogoDiagnostics.whitePieces, 12, "Должно быть 12 белых шашек");
    assert.equal(checkerPieceLogoDiagnostics.blackPieces, 12, "Должно быть 12 чёрных шашек");
    assert.equal(checkerPieceLogoDiagnostics.logosWithSvg, 24, "Логотип должен быть готов для всех обычных шашек");
    assert.equal(checkerPieceLogoDiagnostics.visibleLogos, 24,
      "Все обычные шашки должны показывать логотип: " + JSON.stringify(checkerPieceLogoDiagnostics));
    assert.equal(checkerPieceLogoDiagnostics.kingMarks, 24, "На каждой шашке должен быть подготовлен SVG значок дамки"); 
    assert.equal(checkerPieceLogoDiagnostics.kingsShowCrownInsteadOfLogo, true,
      "На дамке корона должна заменять логотип, а не накладываться на него");
    await checkersPage.screenshot({ path: path.join(out, "checkers-allcoins-piece-logos.png"), fullPage: true });
    await checkersPage.close();

    await page.goto("http://127.0.0.1:4173/index.html", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(700);

    // Main tap target must render as a round ALLCOINS logo without changing clicker behavior.
    const clickerOrbDiagnostics = await page.evaluate(() => {
      const button = document.getElementById("tapButton");
      const rect = button?.getBoundingClientRect();
      const style = button ? getComputedStyle(button) : null;
      return {
        visible: Boolean(rect && rect.width > 0 && rect.height > 0),
        width: rect?.width ?? null,
        height: rect?.height ?? null,
        borderRadius: style?.borderRadius || null,
        logoSvg: Boolean(button?.querySelector(".tap-orb-logo svg")),
        wordmark: button?.querySelector(".tap-orb-wordmark")?.textContent?.trim() || null,
        reward: button?.querySelector(".tap-orb-reward")?.textContent?.trim().replace(/\s+/g, " ") || null,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth
      };
    });
    fs.writeFileSync(path.join(out, "clicker-round-logo-report.json"), JSON.stringify(clickerOrbDiagnostics, null, 2));
    assert.equal(clickerOrbDiagnostics.visible, true, "Круглая кнопка кликера должна отображаться");
    assert.ok(clickerOrbDiagnostics.width >= 209 && clickerOrbDiagnostics.width <= 211,
      "Кликер на обычном мобильном экране должен быть немного увеличен до 210px: " + JSON.stringify(clickerOrbDiagnostics));
    assert.ok(Math.abs(clickerOrbDiagnostics.width - clickerOrbDiagnostics.height) <= 1,
      "Кнопка кликера должна быть круглой: " + JSON.stringify(clickerOrbDiagnostics));
    assert.match(clickerOrbDiagnostics.borderRadius, /50%/, "Кнопка кликера должна иметь радиус круга");
    assert.equal(clickerOrbDiagnostics.logoSvg, true, "В круге кликера должен отображаться фирменный SVG-логотип");
    assert.equal(clickerOrbDiagnostics.wordmark, "ALLCOINS", "Внутри круга должна быть надпись ALLCOINS");
    assert.match(clickerOrbDiagnostics.reward, /\+100.*AC/, "Награда +100 AC должна оставаться видимой");
    assert.equal(clickerOrbDiagnostics.documentWidth, clickerOrbDiagnostics.viewportWidth,
      "Круг кликера не должен вызывать горизонтальную прокрутку");
    await page.screenshot({ path: path.join(out, "00-clicker-round-logo-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 360, height: 800 });
    const compactClickerDiagnostics = await page.evaluate(() => {
      const button = document.getElementById("tapButton");
      const rect = button?.getBoundingClientRect();
      return {
        width: rect?.width ?? null,
        height: rect?.height ?? null,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth
      };
    });
    assert.ok(compactClickerDiagnostics.width >= 191 && compactClickerDiagnostics.width <= 193 &&
      Math.abs(compactClickerDiagnostics.width - compactClickerDiagnostics.height) <= 1,
      "Узкий экран должен показывать круглый кликер размером 192px: " + JSON.stringify(compactClickerDiagnostics));
    assert.equal(compactClickerDiagnostics.documentWidth, compactClickerDiagnostics.viewportWidth,
      "Увеличенный кликер не должен вызывать горизонтальную прокрутку на узком экране");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(100);

    await page.locator('.nav [data-page="games"]').click();
    await page.waitForTimeout(150);

    // Regression checks for the clicker brand, task flow, eight game tiles and card-preview removal.
    const clickerBrandDiagnostics = await page.evaluate(() => {
      const brand = document.getElementById("allcoinsBrand");
      const rect = brand?.getBoundingClientRect();
      return {
        visible: Boolean(rect && rect.width > 0 && rect.height > 0),
        title: brand?.querySelector(".brand-type strong")?.textContent?.trim() || null,
        tagline: brand?.querySelector(".brand-type small")?.textContent?.trim() || null,
        svgMark: Boolean(brand?.querySelector(".brand-mark svg")),
        width: rect?.width ?? null
      };
    });
    fs.writeFileSync(path.join(out, "clicker-brand-report.json"), JSON.stringify(clickerBrandDiagnostics, null, 2));
    assert.equal(clickerBrandDiagnostics.visible, true, "Логотип ALLCOINS должен быть виден на главном экране");
    assert.equal(clickerBrandDiagnostics.title, "ALLCOINS", "В логотипе должно быть название ALLCOINS");
    assert.ok(clickerBrandDiagnostics.svgMark, "В логотипе должен быть фирменный SVG-знак");
    assert.ok(clickerBrandDiagnostics.tagline.includes("CLICKER"), "Подпись логотипа должна обозначать кликер");

    await page.locator('.nav [data-page="tasks"]').click();
    await page.waitForTimeout(100);
    const taskDiagnostics = await page.evaluate(() => ({
      visible: Boolean(document.getElementById("tasks") && !document.getElementById("tasks").classList.contains("hidden")),
      taskCount: document.querySelectorAll("#clickerTasksList .task-item").length,
      navActive: document.querySelector('.nav [data-page="tasks"]')?.classList.contains("active") || false,
      navLabel: document.querySelector('.nav [data-page="tasks"]')?.textContent?.trim() || "",
      taskTop: document.getElementById("tasks")?.getBoundingClientRect().top ?? null,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth
    }));
    fs.writeFileSync(path.join(out, "clicker-tasks-report.json"), JSON.stringify(taskDiagnostics, null, 2));
    assert.equal(taskDiagnostics.visible, true, "Кнопка «Задание» должна открывать страницу заданий");
    assert.equal(taskDiagnostics.taskCount, 4, "На странице должны быть четыре тестовых задания");
    assert.equal(taskDiagnostics.navActive, true, "Кнопка «Задание» должна отмечаться активной");
    assert.match(taskDiagnostics.navLabel, /Задание/, "На нижней панели должна быть кнопка «Задание»");
    assert.ok(taskDiagnostics.taskTop !== null && taskDiagnostics.taskTop < 150,
      "Страница заданий должна начинаться сразу под логотипом, без пустого экрана сверху: " + JSON.stringify(taskDiagnostics));
    assert.equal(taskDiagnostics.documentWidth, taskDiagnostics.viewportWidth, "Страница заданий не должна создавать горизонтальную прокрутку");

    await page.evaluate(() => { for (let i = 0; i < 10; i++) recordClickerTap(); });
    await page.waitForTimeout(50);
    const tapTaskButton = page.locator('#clickerTasksList [data-claim-task="tap10"]');
    assert.equal(await tapTaskButton.isEnabled(), true, "Задание за 10 нажатий должно стать доступным");
    await tapTaskButton.click();
    await page.waitForTimeout(50);
    assert.match(await page.locator("#clickerTaskStatus").textContent(), /\+250 AC/, "Получение награды за задание должно показывать подтверждение");
    assert.equal(await page.locator("#clickerTaskSummary").textContent(), "1 / 4", "Счётчик должен обновиться после получения награды");
    assert.equal((await page.locator("#balance").textContent()).replace(/\s/g, ""), "10250", "Локальная награда должна отображаться в общем балансе");
    await page.evaluate(() => { state.balance = 10010; render(); });
    assert.equal((await page.locator("#balance").textContent()).replace(/\s/g, ""), "10260", "Подтверждённое сервером обновление баланса не должно стирать локальную награду");
    assert.equal((await page.locator("#profileBalance").textContent()).replace(/\s/g, ""), "10260", "Профиль должен показывать общий отображаемый баланс");
    assert.equal((await page.locator("#withdrawBalance").textContent()).replace(/\s/g, ""), "10260", "Раздел вывода должен показывать общий отображаемый баланс");
    await page.screenshot({ path: path.join(out, "00-clicker-tasks-mobile.png"), fullPage: true });

    await page.locator('.nav [data-page="games"]').click();
    await page.waitForTimeout(150);
    const gamesIconDiagnostics = await page.evaluate(() => {
      const definitions = [
        { id: "durakEntry", selector: ".durak-entry-appicon", title: "Дурак Онлайн" },
        { id: "bombEntry", selector: ".bomb-entry-appicon", title: "Передай бомбу" },
        { id: "tugEntry", selector: ".tug-entry-appicon", title: "Перетягивание каната" },
        { id: "towersEntry", selector: ".towers-entry-appicon", title: "Захват башен" },
        { id: "unoEntry", selector: ".uno-entry-appicon", title: "УНО Онлайн" },
        { id: "baldaEntry", selector: ".balda-entry-appicon", title: "Балда Онлайн" },
        { id: "billiardsEntry", selector: ".billiards-entry-appicon", title: "Бильярд Онлайн" },
        { id: "lottoEntry", selector: ".lotto-entry-appicon", title: "Лото Онлайн" },
        { id: "twentyOneEntry", selector: ".twentyone-entry-appicon", title: "21 Очко" },
        { id: "sekaEntry", selector: ".seka-entry-appicon", title: "Сека Онлайн" },
        { id: "rpsEntry", selector: ".rps-entry-appicon", title: "Камень Ножницы Бумага" },
        { id: "checkersEntry", selector: ".checkers-entry-appicon", title: "Шашки Онлайн" }
      ];
      const icons = definitions.map(def => {
        const tile = document.getElementById(def.id);
        const icon = tile?.querySelector(def.selector);
        const rect = icon?.getBoundingClientRect();
        const style = icon ? getComputedStyle(icon) : null;
        const innerFrame = icon ? getComputedStyle(icon, "::before") : null;
        return {
          id: def.id,
          title: tile?.querySelector(".game-app-title")?.textContent?.trim() || null,
          visible: Boolean(rect && rect.width > 0 && rect.height > 0),
          width: rect?.width ?? null,
          height: rect?.height ?? null,
          borderWidth: style?.borderTopWidth || null,
          borderColor: style?.borderTopColor || null,
          radius: style?.borderTopLeftRadius || null,
          hasGoldInnerFrame: Boolean(innerFrame && innerFrame.borderTopStyle === "solid" && innerFrame.borderTopWidth === "1px"),
          background: style?.backgroundImage || null
        };
      });
      return {
        gamesSectionVisible: Boolean(document.getElementById("games") && !document.getElementById("games").classList.contains("hidden")),
        tiles: document.querySelectorAll("#games .games-app-grid > .game-app-tile").length,
        icons,
        durakLauncher: (() => {
          const el = document.getElementById("openDurak");
          const style = el ? getComputedStyle(el) : null;
          const cardBack = document.querySelector("#durakEntry .durak-app-card-back");
          const cardBackStyle = cardBack ? getComputedStyle(cardBack) : null;
          return style ? {
            backgroundImage: style.backgroundImage,
            backgroundColor: style.backgroundColor,
            borderTopWidth: style.borderTopWidth,
            borderTopStyle: style.borderTopStyle,
            boxShadow: style.boxShadow,
            minHeight: style.minHeight,
            borderRadius: style.borderTopLeftRadius,
            cardBackColor: cardBackStyle?.color || null,
            cardBackBackground: cardBackStyle?.backgroundImage || null
          } : null;
        })(),
        previewButtonCount: [...document.querySelectorAll("#games button")].filter(button =>
          /посмотреть карты allcoins premium/i.test(button.textContent || "")
        ).length,
        previewPanelCount: document.querySelectorAll("#allcoinsCardPreview").length,
        previewFunctionType: typeof window.showAllcoinsCardPreview,
        sekaHref: document.getElementById("openSeka")?.getAttribute("href") || null,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        url: location.href
      };
    });
    fs.writeFileSync(path.join(out, "games-icons-report.json"), JSON.stringify(gamesIconDiagnostics, null, 2));
    assert.equal(gamesIconDiagnostics.gamesSectionVisible, true, "Раздел «Игры» должен открываться");
    assert.equal(gamesIconDiagnostics.tiles, 12, "В разделе должны отображаться двенадцать игровых плиток, включая Балда Онлайн, Перетягивание каната, Передай бомбу, Захват башен, УНО Онлайн и Бильярд Онлайн");
    assert.deepEqual(gamesIconDiagnostics.icons.map(icon => icon.title), ["Дурак Онлайн", "Передай бомбу", "Перетягивание каната", "Захват башен", "УНО Онлайн", "Балда Онлайн", "Бильярд Онлайн", "Лото Онлайн", "21 Очко", "Сека Онлайн", "Камень Ножницы Бумага", "Шашки Онлайн"]);
    assert.ok(gamesIconDiagnostics.durakLauncher, "Не найдена кнопка запуска Дурак Онлайн");
    assert.equal(gamesIconDiagnostics.durakLauncher.backgroundImage, "none",
      "На значке Дурак Онлайн остался старый золотой градиент");
    assert.equal(gamesIconDiagnostics.durakLauncher.backgroundColor, "rgba(0, 0, 0, 0)",
      "Фон кнопки Дурак Онлайн должен быть прозрачным, как у остальных игр");
    assert.equal(gamesIconDiagnostics.durakLauncher.borderTopWidth, "0px",
      "На кнопке Дурак Онлайн осталась отдельная рамка");
    assert.equal(gamesIconDiagnostics.durakLauncher.boxShadow, "none",
      "На кнопке Дурак Онлайн осталась отдельная тень");
    assert.equal(gamesIconDiagnostics.durakLauncher.cardBackColor, "rgb(200, 219, 227)",
      "Ярко-золотая масть на рубашке Дурака должна быть заменена спокойным светло-голубым цветом");
    assert.match(gamesIconDiagnostics.durakLauncher.cardBackBackground, /repeating-linear-gradient/,
      "Рубашка Дурака должна иметь узор, похожий на другие игровые значки");
    for (const icon of gamesIconDiagnostics.icons) {
      assert.equal(icon.visible, true, icon.id + ": значок не виден");
      assert.ok(Math.abs(icon.width - 82) <= 1 && Math.abs(icon.height - 82) <= 1,
        icon.id + ": размер значка отличается от общего 82×82: " + JSON.stringify(icon));
      assert.equal(icon.borderWidth, "1px", icon.id + ": нет тонкой рамки");
      assert.match(icon.borderColor, /244,\s*213,\s*133/, icon.id + ": рамка не золотая");
      assert.equal(icon.radius, "21px", icon.id + ": радиус рамки отличается от Дурака Онлайн");
      assert.equal(icon.hasGoldInnerFrame, true, icon.id + ": отсутствует внутренний золотой кант");
      assert.notEqual(icon.background, "none", icon.id + ": отсутствует фон логотипа");
    }
    assert.equal(gamesIconDiagnostics.previewButtonCount, 0, "Старая кнопка просмотра премиум-карт ещё показывается");
    assert.equal(gamesIconDiagnostics.previewPanelCount, 0, "На странице осталась панель предпросмотра карт");
    assert.equal(gamesIconDiagnostics.previewFunctionType, "undefined", "Код удалённого предпросмотра остался доступен");
    assert.equal(gamesIconDiagnostics.sekaHref, "./seka.html?v=20261027-reaction-fast1",
      "Адрес отдельной страницы Сека изменился");
    assert.equal(gamesIconDiagnostics.documentWidth, gamesIconDiagnostics.viewportWidth,
      "Появилась горизонтальная прокрутка в разделе игр");
    assert.equal(new URL(gamesIconDiagnostics.url).pathname, "/index.html",
      "При открытии раздела игр изменился адрес приложения");
    await page.locator("#games").screenshot({ path: path.join(out, "01-games-icons-mobile.png") });

    await page.setViewportSize({ width: 360, height: 800 });
    await page.waitForTimeout(100);
    const smallViewport = await page.evaluate(() => ({
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      icons: [...document.querySelectorAll("#games .game-app-tile")].map(tile => {
        const icon = tile.querySelector(".durak-entry-appicon,.bomb-entry-appicon,.tug-entry-appicon,.uno-entry-appicon,.balda-entry-appicon,.billiards-entry-appicon,.lotto-entry-appicon,.twentyone-entry-appicon,.seka-entry-appicon,.rps-entry-appicon,.checkers-entry-appicon");
        const r = icon?.getBoundingClientRect();
        return { id: tile.id, width: r?.width ?? null, height: r?.height ?? null };
      })
    }));
    fs.writeFileSync(path.join(out, "games-icons-small-viewport.json"), JSON.stringify(smallViewport, null, 2));
    assert.equal(smallViewport.documentWidth, smallViewport.viewportWidth, "На экране 360px появилась горизонтальная прокрутка");
    const expectedSmallIconSize = smallViewport.icons[0]?.width;
    assert.equal(expectedSmallIconSize, 74, "На узком экране ожидается уменьшенный общий размер 74×74");
    for (const icon of smallViewport.icons) {
      assert.ok(Math.abs(icon.width - expectedSmallIconSize) <= 1 && Math.abs(icon.height - expectedSmallIconSize) <= 1,
        icon.id + ": значок не совпадает по размеру с остальными на узком экране: " + JSON.stringify(icon));
    }
    await page.locator("#games").screenshot({ path: path.join(out, "01b-games-icons-small-mobile.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(100);
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

    // A landing placeholder must retain the source card's visual classes.
    // Dropping "image-card" here used to change the upper frame/corner right at touchdown.
    const landingArtworkAudit = await page.evaluate(async () => {
      const gameRoot = document.getElementById("durakGame");
      const host = document.createElement("div");
      Object.assign(host.style, {
        position: "fixed", left: "-1000px", top: "0",
        width: "65px", height: "96px", overflow: "hidden"
      });
      gameRoot.appendChild(host);
      const source = createDurakCardElement({ id: "landing-artwork-audit", rank: "Д", suit: "♥" });
      Object.assign(source.style, {
        position: "relative", width: "65px", height: "96px",
        minWidth: "65px", maxWidth: "65px", flex: "none"
      });
      host.appendChild(source);
      const landing = createDurakLandingTarget("attack", source);
      const target = landing?.element;
      await Promise.all([
        waitForDurakCardImagesReady(source),
        waitForDurakCardImagesReady(target)
      ]);
      const result = {
        sourceImageCard: source.classList.contains("image-card"),
        targetImageCard: !!target?.classList.contains("image-card"),
        sourceRed: source.classList.contains("red"),
        targetRed: !!target?.classList.contains("red"),
        sourceImageLoaded: !!source.querySelector("img") && source.querySelector("img").naturalWidth > 0,
        targetImageLoaded: !!target?.querySelector("img") && target.querySelector("img").naturalWidth > 0,
        sourceImageObjectFit: source.querySelector("img") ? getComputedStyle(source.querySelector("img")).objectFit : "",
        targetImageObjectFit: target?.querySelector("img") ? getComputedStyle(target.querySelector("img")).objectFit : "",
        sourceImageTransform: source.querySelector("img") ? getComputedStyle(source.querySelector("img")).transform : "",
        targetImageTransform: target?.querySelector("img") ? getComputedStyle(target.querySelector("img")).transform : "",
        sourceBorder: getComputedStyle(source).border,
        targetBorder: target ? getComputedStyle(target).border : ""
      };
      landing?.cleanup();
      host.remove();
      return result;
    });
    fs.writeFileSync(path.join(out, "landing-artwork-audit.json"), JSON.stringify(landingArtworkAudit, null, 2));
    if (!landingArtworkAudit.sourceImageCard || !landingArtworkAudit.targetImageCard ||
        landingArtworkAudit.sourceRed !== landingArtworkAudit.targetRed ||
        !landingArtworkAudit.sourceImageLoaded || !landingArtworkAudit.targetImageLoaded ||
        landingArtworkAudit.targetImageObjectFit !== "fill" ||
        landingArtworkAudit.targetImageTransform !== "none" ||
        landingArtworkAudit.sourceBorder !== landingArtworkAudit.targetBorder) {
      throw new Error("Временная карта на столе меняет оформление верхнего угла при посадке: " +
        JSON.stringify(landingArtworkAudit));
    }

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
    // PNG art is added to /cards incrementally; cards without a face PNG
    // must still render using the built-in classic fallback instead of going blank.
    if (fullDeckAssetReport.total !== 52 || fullDeckAssetReport.loaded !== 52 ||
        fullDeckAssetReport.svgFaces !== 0 || fullDeckAssetReport.pngFaces < 16) {
      throw new Error("Не все 52 карты ALLCOINS имеют видимую лицевую сторону: " + JSON.stringify(fullDeckAssetReport));
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
        contactSheetAudit.svgCount !== 0 || contactSheetAudit.pngCount < 16) {
      throw new Error("Визуальный лист ALLCOINS: не все карты видны, либо потеряны все PNG: " + JSON.stringify(contactSheetAudit));
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
      const element = document.querySelector('#durakTable .durak-card.table-card[data-optimistic-landing="true"]');
      if (!element) return null;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        visible: style.visibility !== "hidden" && Number(style.opacity) > 0.9,
        x: rect.x,
        y: rect.y,
        width: element.offsetWidth,
        height: element.offsetHeight
      };
    });
    const optimisticLandingPositions = await page.evaluate(() =>
      [...document.querySelectorAll('#durakTable .durak-card.table-card[data-optimistic-landing="true"]')]
        .map(card => {
          const r = card.getBoundingClientRect();
          return { id: String(card.dataset.cardId || ""), x: r.x, y: r.y, width: r.width, height: r.height };
        })
    );
    await page.screenshot({ path: path.join(out, "04b-game-card-landed-before-server-reply.png"), fullPage: true });
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(out, "05-game-after-drop.png"), fullPage: true });
    const confirmedLandingPositions = await page.evaluate((ids) =>
      ids.map(oldCard => {
        const card = [...document.querySelectorAll('#durakTable .durak-card.table-card[data-card-id]')]
          .find(element => String(element.dataset.cardId || "") === oldCard.id);
        if (!card) return { id: oldCard.id, missing: true };
        const r = card.getBoundingClientRect();
        return { id: oldCard.id, x: r.x, y: r.y, width: r.width, height: r.height };
      }), optimisticLandingPositions
    );
    const landingPositionDeltas = optimisticLandingPositions.map(oldCard => {
      const current = confirmedLandingPositions.find(item => item.id === oldCard.id);
      if (!current || current.missing) return { id: oldCard.id, missingAfterServerReply: true };
      return {
        id: oldCard.id,
        dx: Number((current.x - oldCard.x).toFixed(2)),
        dy: Number((current.y - oldCard.y).toFixed(2)),
        before: { x: oldCard.x, y: oldCard.y },
        after: { x: current.x, y: current.y }
      };
    });
    fs.writeFileSync(path.join(out, "landing-position-stability.json"), JSON.stringify({
      beforeServerReply: optimisticLandingPositions,
      afterServerReply: confirmedLandingPositions,
      deltas: landingPositionDeltas
    }, null, 2));
    if (!optimisticLandingPositions.length || landingPositionDeltas.some(item =>
        item.missingAfterServerReply || Math.abs(item.dx) > 1 || Math.abs(item.dy) > 1)) {
      throw new Error("Карта прыгает после ответа сервера: координаты до/после обновления должны совпадать с точностью 1px. " +
        JSON.stringify(landingPositionDeltas));
    }

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
      optimisticLandingPositions,
      confirmedLandingPositions,
      landingPositionDeltas,
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
    // The card must visibly travel along a broad arc, not merely blink into the table.
    await page.waitForTimeout(260);
    const incomingMid = await incomingFlyer.boundingBox();
    const incomingFlightTiming = await page.evaluate(() => {
      const card = document.querySelector('.durak-flying-card[data-incoming-attack="true"]');
      const animation = card?.getAnimations().find(item => item.effect && item.effect.getTiming);
      return {
        durationMs: animation?.effect?.getTiming()?.duration ?? null,
        imageCardClass: !!card?.classList.contains("image-card"),
        imageObjectFit: card?.querySelector("img") ? getComputedStyle(card.querySelector("img")).objectFit : null,
        imageRendering: card?.querySelector("img") ? getComputedStyle(card.querySelector("img")).imageRendering : null,
        imageNaturalWidth: card?.querySelector("img")?.naturalWidth ?? 0,
        imageNaturalHeight: card?.querySelector("img")?.naturalHeight ?? 0
      };
    });
    const incomingTravelDistance = incomingStart && incomingMid
      ? Math.hypot(incomingMid.x - incomingStart.x, incomingMid.y - incomingStart.y)
      : 0;
    fs.writeFileSync(path.join(out, "opponent-attack-flight.json"), JSON.stringify({
      start: incomingStart,
      midpoint: incomingMid,
      travelDistancePx: incomingTravelDistance,
      timing: incomingFlightTiming
    }, null, 2));
    if (!incomingMid || incomingTravelDistance < 10) {
      throw new Error("Летящая карта соперника должна заметно смещаться к столу во время анимации: " +
        JSON.stringify({ incomingStart, incomingMid, incomingTravelDistance }));
    }
    if (incomingFlightTiming.durationMs !== 580 || !incomingFlightTiming.imageCardClass ||
        incomingFlightTiming.imageRendering !== "auto" ||
        incomingFlightTiming.imageNaturalWidth < 56 || incomingFlightTiming.imageNaturalHeight < 84) {
      throw new Error("Полёт соперника должен длиться 580 мс и сохранять оформление карты до посадки: " +
        JSON.stringify(incomingFlightTiming));
    }
    // At roughly 360ms the faster flight should still be moving, not snapped onto the table.
    await page.waitForTimeout(100);
    if (!(await incomingFlyer.count())) {
      throw new Error("Замедленная анимация соперника завершилась раньше времени");
    }
    await page.waitForFunction(
      () => !document.querySelector('.durak-flying-card[data-incoming-attack="true"]'),
      { timeout: 4000 }
    );
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

    // Defence played by the opponent must fly from the defender's seat to the attack card.
    // This uses the same visible 580ms flight as an incoming attack.
    currentGame.table = [
      {
        attack: { id: "local-attack-for-defense", rank: "10", suit: "♠" },
        defense: null
      }
    ];
    currentGame.attackerIndex = 0;
    currentGame.defenderIndex = 1;
    currentGame.phase = "defense";
    await page.evaluate(() => loadDurakGame("visual-test-room"));
    currentGame.table = [
      {
        attack: { id: "local-attack-for-defense", rank: "10", suit: "♠" },
        defense: { id: "incoming-defense-1", rank: "Д", suit: "♥" }
      }
    ];
    await page.evaluate(() => loadDurakGame("visual-test-room"));
    await page.waitForTimeout(70);
    const incomingDefenseFlyer = page.locator('.durak-flying-card[data-incoming-defense="true"]');
    if (!(await incomingDefenseFlyer.count())) {
      throw new Error("Карта защиты соперника должна начинать полёт от его места к атакующей карте");
    }
    const incomingDefenseStart = await incomingDefenseFlyer.boundingBox();
    const incomingDefenseImage = await page.evaluate(() => {
      const card = document.querySelector('.durak-flying-card[data-incoming-defense="true"]');
      const image = card?.querySelector("img");
      const style = image ? getComputedStyle(image) : null;
      const animation = card?.getAnimations().find(item => item.effect && item.effect.getTiming);
      return {
        cardExists: !!card,
        imageLoaded: !image || (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0),
        imageVisible: !!style && style.visibility !== "hidden" && Number(style.opacity) > 0.9,
        imageObjectFit: style?.objectFit || null,
        imageRendering: style?.imageRendering || null,
        imageNaturalWidth: image?.naturalWidth ?? 0,
        imageNaturalHeight: image?.naturalHeight ?? 0,
        durationMs: animation?.effect?.getTiming()?.duration ?? null
      };
    });
    await page.waitForTimeout(260);
    const incomingDefenseMid = await incomingDefenseFlyer.boundingBox();
    const incomingDefenseDistance = incomingDefenseStart && incomingDefenseMid
      ? Math.hypot(incomingDefenseMid.x - incomingDefenseStart.x, incomingDefenseMid.y - incomingDefenseStart.y)
      : 0;
    fs.writeFileSync(path.join(out, "opponent-defense-flight.json"), JSON.stringify({
      start: incomingDefenseStart,
      midpoint: incomingDefenseMid,
      travelDistancePx: incomingDefenseDistance,
      timing: incomingDefenseImage
    }, null, 2));
    if (!incomingDefenseImage.cardExists || !incomingDefenseImage.imageLoaded ||
        !incomingDefenseImage.imageVisible || incomingDefenseImage.imageObjectFit !== "contain" ||
        incomingDefenseImage.imageRendering !== "auto" ||
        incomingDefenseImage.imageNaturalWidth < 56 || incomingDefenseImage.imageNaturalHeight < 84) {
      throw new Error("Лицо карты защиты должно быть полностью загружено, чётким и видимым в полёте: " +
        JSON.stringify(incomingDefenseImage));
    }
    if (incomingDefenseImage.durationMs !== 580 || incomingDefenseDistance < 10) {
      throw new Error("Анимация защиты должна лететь к столу 580 мс как атака: " +
        JSON.stringify({ incomingDefenseImage, incomingDefenseDistance }));
    }
    await page.waitForTimeout(100);
    if (!(await incomingDefenseFlyer.count())) {
      throw new Error("Анимация защиты соперника завершилась раньше времени");
    }
    await page.waitForFunction(
      () => !document.querySelector('.durak-flying-card[data-incoming-defense="true"]'),
      { timeout: 4000 }
    );
    const defenseLanding = await page.evaluate(() => {
      const card = document.querySelector('#durakTable .durak-card[data-card-id="incoming-defense-1"]');
      const style = card ? getComputedStyle(card) : null;
      const rect = card?.getBoundingClientRect();
      const image = card?.querySelector("img");
      return {
        visible: !!style && style.visibility !== "hidden" && Number(style.opacity) > 0.9,
        // offsetWidth/Height measure the real card box without the expanded rotated bounding box.
        width: card?.offsetWidth ?? rect?.width ?? 0,
        height: card?.offsetHeight ?? rect?.height ?? 0,
        imageLoaded: !image || (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0),
        imageNaturalWidth: image?.naturalWidth ?? 0,
        imageNaturalHeight: image?.naturalHeight ?? 0,
        imageRendering: image ? getComputedStyle(image).imageRendering : null
      };
    });
    if (!defenseLanding.visible || !defenseLanding.imageLoaded ||
        defenseLanding.imageNaturalWidth < 56 || defenseLanding.imageNaturalHeight < 84 ||
        defenseLanding.imageRendering !== "auto" ||
        Math.abs(defenseLanding.width - 56) > 0.5 ||
        Math.abs(defenseLanding.height - 84) > 0.5) {
      throw new Error("Карта защиты должна остаться видимой на столе после полёта: " + JSON.stringify(defenseLanding));
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
