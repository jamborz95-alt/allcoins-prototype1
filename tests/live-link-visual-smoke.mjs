import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs";
import { resolve } from "node:path";

const publicUrl = process.env.ALLCOINS_PUBLIC_URL ||
  "https://jamborz95-alt.github.io/allcoins-prototype1/?v=20261021b";
const out = resolve(process.cwd(), "visual-test-output");
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true
});
const pageErrors = [];
const relevantFailedRequests = [];
page.on("pageerror", error => pageErrors.push(error.message));
page.on("requestfailed", request => {
  const url = request.url();
  const failure = request.failure()?.errorText || "failed";
  if (url.includes("i18n-extra.js") && failure !== "net::ERR_ABORTED") {
    relevantFailedRequests.push({ url, error: failure });
  }
});

try {
  const response = await page.goto(publicUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  assert.ok(response, "The public ALLCOINS link did not return a document.");
  assert.equal(response.status(), 200, "The public ALLCOINS link must return HTTP 200.");

  await page.waitForSelector('button[data-page="games"]', { timeout: 20000 });
  await page.waitForFunction(() =>
    window.ALLCOINS_I18N_EXTRA &&
    ["de", "fr", "pt", "zh"].every(lang =>
      window.ALLCOINS_I18N_EXTRA[lang] &&
      Object.keys(window.ALLCOINS_I18N_EXTRA[lang]).length >= 440
    ), { timeout: 25000 }
  );

  const baseState = await page.evaluate(() => ({
    brand: document.querySelector("#allcoinsBrand strong")?.textContent?.trim() || "",
    viewport: { width: innerWidth, height: innerHeight },
    documentWidth: document.documentElement.scrollWidth,
    extraLocaleCounts: Object.fromEntries(
      ["de", "fr", "pt", "zh"].map(lang => [lang, Object.keys(window.ALLCOINS_I18N_EXTRA[lang]).length])
    )
  }));
  assert.match(baseState.brand, /ALLCOINS/i, "Visible ALLCOINS brand is missing.");
  assert.equal(baseState.documentWidth, baseState.viewport.width, "Home page has horizontal overflow.");
  await page.screenshot({ path: resolve(out, "live-link-home-mobile.png") });

  await page.locator('button[data-page="games"]').click();
  await page.waitForFunction(() =>
    document.getElementById("games") && !document.getElementById("games").classList.contains("hidden")
  );
  for (const id of ["durakEntry", "bombEntry", "towersEntry", "unoEntry", "billiardsEntry",
                    "lottoEntry", "twentyOneEntry", "sekaEntry", "rpsEntry", "checkersEntry", "baldaEntry"]) {
    assert.ok(await page.locator("#" + id).count(), "Games menu is missing #" + id + ".");
    assert.ok(await page.locator("#" + id).isVisible(), "Games menu tile #" + id + " is not visible.");
  }
  const gamesWidth = await page.evaluate(() => ({
    viewportWidth: innerWidth, documentWidth: document.documentElement.scrollWidth,
    tileCount: document.querySelectorAll("#games .game-app-tile").length
  }));
  assert.equal(gamesWidth.documentWidth, gamesWidth.viewportWidth, "Games menu has horizontal overflow.");
  await page.screenshot({ path: resolve(out, "live-link-games-ru-mobile.png") });

  const languageChecks = [
    { code: "en", home: "Home", games: "Games", bomb: "Pass the Bomb", promo: "Weekly Tournament" },
    { code: "nl", home: "Home", games: "Spellen", bomb: "Geef de bom door", promo: "Wekelijks toernooi" },
    { code: "tr", home: "Ana sayfa", games: "Oyunlar", bomb: "Bombayı aktar", promo: "Haftalık turnuva" },
    { code: "es", home: "Inicio", games: "Juegos", bomb: "Pasa la bomba", promo: "Torneo semanal" },
    { code: "de", home: "Startseite", games: "Spiele", bomb: "Bombe weitergeben", promo: "Wochenturnier" },
    { code: "fr", home: "Accueil", games: "Jeux", bomb: "Passer la bombe", promo: "Tournoi hebdomadaire" },
    { code: "pt", home: "Início", games: "Jogos", bomb: "Passe a bomba", promo: "Torneio semanal" },
    { code: "zh", home: "首页", games: "游戏", bomb: "传递炸弹", promo: "每周锦标赛" }
  ];
  const renderedLocales = [];
  await page.locator('button[data-page="profile"]').click();
  for (const item of languageChecks) {
    await page.locator("#allcoinsLanguage").selectOption(item.code);
    await page.waitForFunction(code => document.documentElement.lang === code &&
      document.getElementById("allcoinsLanguage")?.value === code, item.code, { timeout: 10000 });
    const nav = await page.evaluate(() => ({
      home: document.querySelector('button[data-page="home"]')?.textContent || "",
      games: document.querySelector('button[data-page="games"]')?.textContent || "",
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: innerWidth
    }));
    assert.ok(nav.home.includes(item.home), item.code + " language did not translate Home navigation.");
    assert.ok(nav.games.includes(item.games), item.code + " language did not translate Games navigation.");
    assert.equal(nav.documentWidth, nav.viewportWidth, item.code + " navigation has horizontal overflow.");

    await page.locator('button[data-page="games"]').click();
    const bombTitle = (await page.locator("#bombEntry").innerText()).replace(/\s+/g, " ").trim();
    assert.ok(bombTitle.includes(item.bomb),
      item.code + " language did not translate the Pass the Bomb tile: " + bombTitle);
    const promoText = (await page.locator("#openBlockBlast").innerText()).replace(/\s+/g, " ").trim();
    assert.ok(promoText.includes(item.promo),
      item.code + " language did not translate the Block Blast promotion: " + promoText);
    renderedLocales.push(item.code);
    if (["de", "fr", "pt", "zh"].includes(item.code)) {
      await page.screenshot({ path: resolve(out, "live-link-games-" + item.code + "-mobile.png") });
    }
    await page.locator('button[data-page="profile"]').click();
  }

  const standalonePages = [
    { file: "blockblast.html", source: "Недельный турнир ALLCOINS", translations: {
      en: "ALLCOINS weekly tournament",
      nl: "ALLCOINS-weektoernooi",
      tr: "ALLCOINS haftalık turnuvası",
      es: "Torneo semanal de ALLCOINS",
      de: "ALLCOINS-Wochenturnier",
      fr: "Tournoi hebdomadaire ALLCOINS",
      pt: "Torneio semanal ALLCOINS",
      zh: "ALLCOINS 每周锦标赛"
    }},
    { file: "billiards.html", source: "Бильярд Онлайн", translations: {
      en: "Online Billiards",
      nl: "Biljart Online",
      tr: "Çevrimiçi Bilardo",
      es: "Billar en línea",
      de: "Online-Billard",
      fr: "Billard en ligne",
      pt: "Bilhar online",
      zh: "在线台球"
    }},
    { file: "balda.html", source: "Балда Онлайн", translations: {
      en: "Online Balda",
      nl: "Balda Online",
      tr: "Çevrimiçi Balda",
      es: "Balda en línea",
      de: "Online-Balda",
      fr: "Balda en ligne",
      pt: "Balda Online",
      zh: "在线巴尔达"
    }},
    { file: "bomb.html", source: "Передай бомбу", translations: {
      en: "Pass the Bomb",
      nl: "Geef de bom door",
      tr: "Bombayı aktar",
      es: "Pasa la bomba",
      de: "Bombe weitergeben",
      fr: "Passer la bombe",
      pt: "Passe a bomba",
      zh: "传递炸弹"
    }},
    { file: "checkers.html", source: "Шашки Онлайн", translations: {
      en: "Online Checkers",
      nl: "Dammen Online",
      tr: "Çevrimiçi Dama",
      es: "Damas en línea",
      de: "Online-Dame",
      fr: "Jeu de dames en ligne",
      pt: "Damas online",
      zh: "在线跳棋"
    }},
    { file: "rps.html", source: "Камень · Ножницы · Бумага", translations: {
      en: "Rock · Paper · Scissors",
      nl: "Steen · Papier · Schaar",
      tr: "Taş · Kağıt · Makas",
      es: "Piedra · Papel · Tijera",
      de: "Schere · Stein · Papier",
      fr: "Pierre · Feuille · Ciseaux",
      pt: "Pedra · Papel · Tesoura",
      zh: "石头 · 剪刀 · 布"
    }},
    { file: "seka.html", source: "Сека Онлайн", translations: {
      en: "Seka Online",
      nl: "Seka Online",
      tr: "Seka Online",
      es: "Seka Online",
      de: "Online-Seka",
      fr: "Seka en ligne",
      pt: "Seka online",
      zh: "在线 Seka"
    }},
    { file: "towers.html", source: "Захватывай башни.", translations: {
      en: "Capture towers.",
      nl: "Verover torens.",
      tr: "Kuleleri ele geçir.",
      es: "Conquista las torres.",
      de: "Erobere Türme.",
      fr: "Capture les tours.",
      pt: "Conquiste as torres.",
      zh: "占领塔楼。"
    }},
    { file: "uno.html", source: "УНО Онлайн", translations: {
      en: "UNO Online",
      nl: "UNO Online",
      tr: "UNO Çevrimiçi",
      es: "UNO en línea",
      de: "UNO Online",
      fr: "UNO en ligne",
      pt: "UNO online",
      zh: "UNO 在线"
    }}
  ];
  const standaloneLocaleResults = [];
  const standaloneLocales = ["en", "nl", "tr", "es", "de", "fr", "pt", "zh"];
  // Standalone game pages are tested against this commit, not the live Pages deployment,
  // which may still be publishing while the push-triggered workflow starts.
  const publicRoot = "http://127.0.0.1:4173/";
  for (const game of standalonePages) {
    for (const locale of standaloneLocales) {
      await page.goto(publicRoot, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.evaluate(code => localStorage.setItem("allcoins_language", code), locale);
      const url = new URL(game.file + "?locale-visual-check=20261026g", publicRoot).href;
      const gameResponse = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      assert.ok(gameResponse, locale + " " + game.file + " did not return a page response.");
      assert.equal(gameResponse.status(), 200, locale + " " + game.file + " should return HTTP 200.");
      const minExtraKeyCount = ["de", "fr", "pt", "zh"].includes(locale) ? 489 : 20;
      await page.waitForFunction(({ code, minimum }) => document.documentElement.lang === code &&
        !!window.ALLCOINS_I18N_EXTRA &&
        Object.keys(window.ALLCOINS_I18N_EXTRA[code] || {}).length >= minimum,
        { code: locale, minimum: minExtraKeyCount }, { timeout: 25000 }
      );
      const localeState = await page.evaluate(() => ({
        language: document.documentElement.lang,
        storedLanguage: localStorage.getItem("allcoins_language"),
        extraLocaleCount: Object.keys(window.ALLCOINS_I18N_EXTRA?.[document.documentElement.lang] || {}).length,
        requestedLocaleCount: Object.keys(window.ALLCOINS_I18N_EXTRA?.[localStorage.getItem("allcoins_language")] || {}).length,
        requestedLocale: localStorage.getItem("allcoins_language")
      }));
      assert.equal(localeState.language, locale,
        game.file + " reset document language: " + JSON.stringify(localeState));
      assert.equal(localeState.storedLanguage, locale,
        game.file + " lost stored language: " + JSON.stringify(localeState));
      assert.ok(localeState.requestedLocaleCount >= minExtraKeyCount,
        game.file + " shared dictionary is incomplete: " + JSON.stringify(localeState));
      await page.waitForFunction(({ target }) => document.body.innerText.includes(target),
        { target: game.translations[locale] }, { timeout: 10000 }
      );
      // Let asynchronous room-list messages settle and pass through the shared MutationObserver translator.
      await page.waitForTimeout(300);
      const state = await page.evaluate(({ source, target }) => {
        const visibleText = (document.body.innerText || "").replace(/\s+/g, " ").trim();
        const cyrillicLines = [...new Set((document.body.innerText || "")
          .split(/\n+/)
          .map(line => line.replace(/\s+/g, " ").trim())
          .filter(line => line.length > 1 && /[А-Яа-яЁё]/.test(line)))];
        return {
          language: document.documentElement.lang,
          storedLanguage: localStorage.getItem("allcoins_language"),
          targetVisible: visibleText.includes(target),
          sourceVisible: visibleText.includes(source),
          untranslatedCyrillicCount: cyrillicLines.length,
          untranslatedCyrillicSamples: cyrillicLines.slice(0, 5),
          viewportWidth: innerWidth,
          documentWidth: document.documentElement.scrollWidth
        };
      }, { source: game.source, target: game.translations[locale] });
      assert.equal(state.language, locale, game.file + " reset language " + locale + " on entry.");
      assert.equal(state.storedLanguage, locale, game.file + " failed to preserve " + locale + " in storage.");
      assert.ok(state.targetVisible, game.file + " did not display its " + locale + " label.");
      assert.ok(!state.sourceVisible, game.file + " still shows untranslated source label: " + game.source);
      assert.equal(state.documentWidth, state.viewportWidth,
        game.file + " has horizontal overflow in " + locale + ": " + JSON.stringify(state));
      standaloneLocaleResults.push({ file: game.file, locale, ...state });
      if (locale === "de") {
        await page.screenshot({ path: resolve(out, "standalone-" + game.file.replace(".html", "") + "-de-mobile.png") });
      }
    }
  }

  // Balda must work as a free practice game, and tapping a cell must focus the real text field.
  // On Android Telegram this user gesture is what requests the native keyboard.
  await page.goto(new URL("balda.html?balda-keyboard-smoke=20261027a", publicRoot).href,
    { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.locator("#practiceBotBtn").click();
  await page.waitForFunction(() => {
    const view = document.getElementById("gameView");
    return view && !view.classList.contains("hidden") &&
      document.querySelectorAll("#baldaBoard .cell.can-pick").length > 0;
  }, null, { timeout: 20000 });
  await page.locator("#baldaBoard .cell.can-pick").first().click();
  await page.waitForFunction(() => {
    const modal = document.getElementById("letterModal");
    return modal && !modal.classList.contains("hidden") &&
      document.activeElement && document.activeElement.id === "letterTypeInput";
  }, null, { timeout: 5000 });
  const baldaKeyboardState = await page.evaluate(() => ({
    gameVisible: !document.getElementById("gameView").classList.contains("hidden"),
    letterModalVisible: !document.getElementById("letterModal").classList.contains("hidden"),
    inputFocused: document.activeElement?.id === "letterTypeInput",
    wordCells: document.querySelectorAll("#baldaBoard .cell.filled").length
  }));
  assert.ok(baldaKeyboardState.gameVisible && baldaKeyboardState.letterModalVisible &&
    baldaKeyboardState.inputFocused && baldaKeyboardState.wordCells === 5,
    "Balda bot practice / keyboard-focus flow failed: " + JSON.stringify(baldaKeyboardState));

  await page.goto(publicUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector('button[data-page="games"]', { timeout: 20000 });
  await page.locator('button[data-page="profile"]').click();
  await page.locator("#allcoinsLanguage").selectOption("zh");
  await page.locator('button[data-page="games"]').click();
  await page.setViewportSize({ width: 360, height: 740 });
  const narrowState = await page.evaluate(() => ({
    viewportWidth: innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    gamesVisible: !!document.getElementById("games") &&
      !document.getElementById("games").classList.contains("hidden")
  }));
  assert.equal(narrowState.documentWidth, narrowState.viewportWidth,
    "The localized games menu has horizontal overflow at 360px.");
  await page.locator('button[data-page="games"]').click();
  await page.screenshot({ path: resolve(out, "live-link-games-zh-small-mobile.png") });

  const report = {
    publicUrl,
    httpStatus: response.status(),
    baseState,
    gamesWidth,
    renderedLocales,
    standalonePageCount: standalonePages.length,
    standaloneLocaleChecks: standaloneLocaleResults.length,
    standaloneLocaleResults,
    narrowState,
    pageErrors,
    relevantFailedRequests
  };
  fs.writeFileSync(resolve(out, "live-link-visual-report.json"), JSON.stringify(report, null, 2));
  const untranslated = standaloneLocaleResults.filter(item => item.untranslatedCyrillicCount > 0)
    .map(item => ({ file: item.file, locale: item.locale, samples: item.untranslatedCyrillicSamples }));
  assert.equal(untranslated.length, 0,
    "Standalone game pages still contain untranslated Cyrillic labels: " + JSON.stringify(untranslated));
  assert.equal(relevantFailedRequests.length, 0,
    "Public page or locale script requests failed: " + JSON.stringify(relevantFailedRequests));
  assert.equal(pageErrors.length, 0, "Browser runtime errors: " + pageErrors.join(" | "));
  console.log("LIVE LINK VISUAL TEST PASSED", JSON.stringify(report));
} finally {
  await browser.close();
}
