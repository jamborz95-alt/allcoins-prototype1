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
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(out, "01-home-mobile.png"), fullPage: true });

    const gamesNav = page.locator('.nav [data-page="games"]');
    if (await gamesNav.count()) await gamesNav.click();
    await page.waitForTimeout(200);

    const openButton = page.locator("#openDurak");
    if (await openButton.count()) {
      await openButton.click();
      await page.waitForTimeout(350);
      await page.screenshot({ path: path.join(out, "02-durak-entry-mobile.png"), fullPage: true });

      const createButton = page.locator("#durakShowCreate");
      if (await createButton.isVisible().catch(() => false)) {
        await createButton.click();
        await page.waitForTimeout(250);
        await page.screenshot({ path: path.join(out, "03-durak-create-mobile.png"), fullPage: true });
      }
    } else {
      throw new Error("Не найдена кнопка #openDurak на фактической странице index.html");
    }

    const diagnostics = await page.evaluate(() => ({
      title: document.title,
      viewport: { width: innerWidth, height: innerHeight },
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
      durakGameExists: Boolean(document.querySelector("#durakGame")),
      cardImageFiles: [...document.querySelectorAll('img[src*="cards/"]')].map(img => ({
        src: img.getAttribute("src"),
        loaded: img.complete && img.naturalWidth > 0
      }))
    }));
    fs.writeFileSync(path.join(out, "diagnostics.json"), JSON.stringify({ diagnostics, errors }, null, 2));

    // This first stage establishes a reproducible mobile visual baseline.
    // Drag-and-drop gameplay assertions will be added once the real game state is
    // deterministic in the test browser; this does not claim Telegram WebView parity.
    if (diagnostics.documentWidth > diagnostics.viewport.width + 2) {
      throw new Error("Горизонтальное переполнение: " + diagnostics.documentWidth + "px при viewport " + diagnostics.viewport.width + "px");
    }
    if (!diagnostics.durakGameExists) throw new Error("Экран Дурака отсутствует в DOM");
    if (errors.length) {
      fs.writeFileSync(path.join(out, "browser-errors.txt"), errors.join("\n"));
      throw new Error("Есть ошибки браузера: " + errors.length + ". См. visual-test-output/browser-errors.txt");
    }
    console.log("Visual baseline passed:", JSON.stringify(diagnostics));
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
