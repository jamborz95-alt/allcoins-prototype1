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
  if (url.includes("i18n-extra.js") || url.includes("jamborz95-alt.github.io/allcoins-prototype1")) {
    relevantFailedRequests.push({ url, error: request.failure()?.errorText || "failed" });
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
    title: document.title,
    viewport: { width: innerWidth, height: innerHeight },
    documentWidth: document.documentElement.scrollWidth,
    extraLocaleCounts: Object.fromEntries(
      ["de", "fr", "pt", "zh"].map(lang => [lang, Object.keys(window.ALLCOINS_I18N_EXTRA[lang]).length])
    )
  }));
  assert.match(baseState.title, /ALLCOINS/i, "Page title does not identify ALLCOINS.");
  assert.equal(baseState.documentWidth, baseState.viewport.width, "Home page has horizontal overflow.");
  await page.screenshot({ path: resolve(out, "live-link-home-mobile.png") });

  await page.locator('button[data-page="games"]').click();
  await page.waitForFunction(() =>
    document.getElementById("games") && !document.getElementById("games").classList.contains("hidden")
  );
  for (const id of ["durakEntry", "bombEntry", "towersEntry", "unoEntry", "billiardsEntry",
                    "lottoEntry", "twentyOneEntry", "sekaEntry", "rpsEntry", "checkersEntry"]) {
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
    { code: "en", home: "Home", games: "Games", bomb: "Pass the Bomb" },
    { code: "nl", home: "Home", games: "Spellen", bomb: "Geef de bom door" },
    { code: "tr", home: "Ana sayfa", games: "Oyunlar", bomb: "Bombayı aktar" },
    { code: "es", home: "Inicio", games: "Juegos", bomb: "Pasa la bomba" },
    { code: "de", home: "Startseite", games: "Spiele", bomb: "Bombe weitergeben" },
    { code: "fr", home: "Accueil", games: "Jeux", bomb: "Passer la bombe" },
    { code: "pt", home: "Início", games: "Jogos", bomb: "Passe a bomba" },
    { code: "zh", home: "首页", games: "游戏", bomb: "传递炸弹" }
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
    renderedLocales.push(item.code);
    if (["de", "fr", "pt", "zh"].includes(item.code)) {
      await page.screenshot({ path: resolve(out, "live-link-games-" + item.code + "-mobile.png") });
    }
    await page.locator('button[data-page="profile"]').click();
  }

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
    narrowState,
    pageErrors,
    relevantFailedRequests
  };
  fs.writeFileSync(resolve(out, "live-link-visual-report.json"), JSON.stringify(report, null, 2));
  assert.equal(relevantFailedRequests.length, 0,
    "Public page or locale script requests failed: " + JSON.stringify(relevantFailedRequests));
  assert.equal(pageErrors.length, 0, "Browser runtime errors: " + pageErrors.join(" | "));
  console.log("LIVE LINK VISUAL TEST PASSED", JSON.stringify(report));
} finally {
  await browser.close();
}
