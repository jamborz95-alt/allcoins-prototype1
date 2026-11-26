(() => {
  "use strict";

  // 3D-модель и сетевые комнаты работают напрямую через Amvera Engine HTTP API.
  const RACING_API_BASE = "https://allcoins-engine-a-allcoins95.msk1.amvera.tech";
  const CHUNK_SIZE = 4 * 1024 * 1024;
  // Set by the allcoins-racing-amvera-api meta tag in index.html.
  // GLB-модель также загружается с Amvera через отдельную настройку ниже.
  const RACING_AMVERA_API_META = document.querySelector('meta[name="allcoins-racing-amvera-api"]');
  // Пустой meta не меняет адрес игрового API: он всегда остаётся на Amvera.
  const RACING_AMVERA_API_BASE = String(
    RACING_AMVERA_API_META
      ? RACING_AMVERA_API_META.content
      : "https://allcoins-engine-a-allcoins95.msk1.amvera.tech"
  ).trim().replace(/\/+$/, "");
  // A separate cache key forces a clean fetch from the Amvera asset endpoint.
  const MODEL_CACHE_DB = "allcoins-racing-model-cache";
  const MODEL_CACHE_STORE = "models";
  // Restore the last pre-import Racing cache instead of replacing the pink VAZ-2107
  // with the newly uploaded GLB. This keeps the previous known-good model on the device.
  const MODEL_CACHE_KEY = RACING_AMVERA_API_BASE
    ? "v24-vaz-2107-amvera-glb-v2"
    : "v24-vaz-2107-glb-63426260-v1";

  let authenticationPromise = null;
  let overlay = null;
  let frame = null;
  let statusNode = null;
  let modelProgressPanel = null;
  let modelProgressText = null;
  let modelProgressPercent = null;
  let modelProgressFill = null;
  let activeRoomCode = "";
  let cachedModel = null;
  let loadingModel = null;
  let oldBodyOverflow = "";
  let oldRootOverflow = "";

  function apiUrl(path) {
    if (!RACING_API_BASE || !RACING_API_BASE.startsWith("https://")) {
      throw new Error("Адрес гоночного сервера ещё не настроен.");
    }
    return RACING_API_BASE.replace(/\/+$/, "") + path;
  }

  function setStatus(message, isError) {
    if (!statusNode) return;
    statusNode.textContent = message || "";
    statusNode.style.color = isError ? "#ff9b9b" : "#cbd5e1";
  }

  function setModelProgress(message, percent) {
    if (!modelProgressPanel) return;
    modelProgressPanel.style.display = "block";
    modelProgressText.textContent = message || "Загружаем 3D-модель автомобиля…";
    const validPercent = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null;
    modelProgressPercent.textContent = validPercent === null ? "…" : Math.round(validPercent) + "%";
    modelProgressFill.style.width = validPercent === null ? "38%" : validPercent + "%";
    modelProgressFill.style.animationName = validPercent === null ? "allcoins-model-progress-sweep" : "none";
    modelProgressPanel.setAttribute("aria-valuenow", validPercent === null ? "0" : String(Math.round(validPercent)));
  }

  function hideModelProgress() {
    if (modelProgressPanel) modelProgressPanel.style.display = "none";
  }

  async function requestApi(path, options) {
    const settings = options || {};
    const headers = Object.assign({}, settings.headers || {});
    const request = { method: settings.method || "GET", headers, cache: "no-store" };
    if (settings.body !== undefined) {
      headers["Content-Type"] = "application/json";
      request.body = JSON.stringify(settings.body);
    }
    let response;
    const controller = new AbortController();
    const requestTimeout = setTimeout(() => controller.abort(), 20000);
    request.signal = controller.signal;
    try {
      response = await fetch(apiUrl(path), request);
    } catch (error) {
      if (error && error.name === "AbortError") {
        throw new Error("Гоночный сервер Amvera не ответил за 20 секунд.");
      }
      throw new Error("Не удалось связаться с гоночным сервером Amvera.");
    } finally {
      clearTimeout(requestTimeout);
    }
    const raw = await response.text();
    if (response.status === 429) {
      const retryHeader = response.headers.get("retry-after");
      const retrySeconds = Number(retryHeader);
      const retryDate = Date.parse(retryHeader || "");
      const retryAfterMs = Number.isFinite(retrySeconds) && retryHeader
        ? retrySeconds * 1000
        : Number.isFinite(retryDate) ? Math.max(0, retryDate - Date.now()) : 15000;
      const error = new Error("Сервер временно ограничил запросы к гоночному API (HTTP 429). Клиент сделает паузу и повторит подключение.");
      error.retryAfterMs = retryAfterMs;
      throw error;
    }
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch (_) {
      const contentType = response.headers.get("content-type") || "Content-Type не указан";
      const preview = String(raw || "").replace(/\\s+/g, " ").trim().slice(0, 180);
      throw new Error(
        "Ответ API не JSON (HTTP " + response.status + "; " + contentType + "). " +
        (preview ? "Ответ: " + preview : "Тело ответа пустое.")
      );
    }
    if (!response.ok || data.ok === false) {
      throw new Error(data.error || ("Ошибка гоночного сервера: HTTP " + response.status));
    }
    return data;
  }

  function telegramInitData() {
    const tg = window.Telegram && window.Telegram.WebApp;
    if (!tg || !tg.initData) {
      throw new Error("Открой ALLCOINS через Telegram, чтобы войти в гонку.");
    }
    try { tg.ready(); tg.expand(); } catch (_) {}
    return tg.initData;
  }

  async function ensureTelegramAuthentication() {
    telegramInitData();
    return true;
  }

  async function dragRacingPost(path, body = {}) {
    const initData = telegramInitData();
    return requestApi("/api/drag-racing" + path, {
      method: "POST",
      body: Object.assign({}, body, { initData })
    });
  }

  function normalizeRoomPayload(payload) {
    const room = payload.room || {};
    return Object.assign({}, payload, {
      isHost: Boolean(room.isOwner),
      room: Object.assign({}, room, {
        code: String(room.id || ""),
        host_name: String(room.ownerName || "Игрок"),
        players: Number(room.playersCount || 0),
        max_players: Number(room.maxPlayers || 2)
      }),
      players: (payload.players || []).map(player => ({
        ...player,
        is_me: Boolean(player.isYou),
        is_host: Boolean(player.isOwner),
        finish_time_ms: player.finishTimeMs == null ? null : Number(player.finishTimeMs),
        mode_choice: player.modeChoice === "free" || player.modeChoice === "ad" ? player.modeChoice : null,
        ad_rewarded: Boolean(player.adRewarded),
        is_ready: Boolean(player.isReady),
        speedKmh: player.motion?.speedKmh ?? 0,
        distanceM: player.motion?.distanceM ?? 0,
        gear: player.motion?.gear ?? 0,
        progress: player.motion?.progress ?? 0,
        updatedAt: player.motion?.updatedAt ?? 0,
        fresh: Boolean(player.motion?.fresh)
      }))
    });
  }

  function makeElement(tag, styles, text) {
    const element = document.createElement(tag);
    if (styles) element.style.cssText = styles;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function createOverlay() {
    if (overlay) return;
    overlay = makeElement("div",
      "position:fixed;inset:0;z-index:2147483000;display:block;width:100vw;height:100vh;height:100dvh;" +
      "background:#070b13;color:#fff;overflow:hidden;overscroll-behavior:none;touch-action:pan-x pan-y;");
    overlay.id = "allcoinsRacingV24Overlay";

    frame = document.createElement("iframe");
    frame.title = "ALLCOINS Racing V24";
    frame.allow = "fullscreen; autoplay; gamepad; picture-in-picture";
    frame.allowFullscreen = true;
    frame.style.cssText = "position:absolute;inset:0;display:block;width:100%;height:100%;height:100dvh;" +
      "min-height:0;border:0;background:#080d18;";
    frame.addEventListener("load", () => setStatus("Гоночный экран загружен", false));

    const back = makeElement("button",
      "position:absolute;left:12px;top:calc(env(safe-area-inset-top, 0px) + 10px);z-index:40;" +
      "min-width:42px;min-height:42px;padding:8px 12px;border:1px solid #ffffff55;border-radius:12px;" +
      "background:rgba(9,15,24,.78);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);" +
      "color:#fff;font:800 13px Arial,sans-serif;box-shadow:0 3px 14px #0007;cursor:pointer;",
      "← Назад");
    back.type = "button";
    back.setAttribute("aria-label", "Выйти из гонки");
    back.addEventListener("click", closeOverlay);

    statusNode = makeElement("div",
      "position:absolute;right:12px;top:calc(env(safe-area-inset-top, 0px) + 12px);z-index:35;" +
      "max-width:48%;padding:7px 10px;border:1px solid #ffffff25;border-radius:10px;" +
      "background:rgba(9,15,24,.66);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);" +
      "font:10px/1.25 Arial,sans-serif;color:#d6deea;text-align:right;pointer-events:none;",
      "Подключение…");
    statusNode.setAttribute("aria-live", "polite");

    modelProgressPanel = makeElement("div",
      "position:absolute;top:calc(env(safe-area-inset-top, 0px) + 62px);left:14px;right:14px;" +
      "z-index:30;max-width:560px;margin:0 auto;display:none;padding:14px 16px 15px;" +
      "border:1px solid #d7b65f;border-radius:15px;background:rgba(12,19,31,.96);" +
      "box-shadow:0 12px 36px rgba(0,0,0,.45);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);");
    modelProgressPanel.id = "allcoinsRacingModelProgress";
    modelProgressPanel.setAttribute("role", "progressbar");
    modelProgressPanel.setAttribute("aria-label", "Загрузка 3D-модели автомобиля");
    modelProgressPanel.setAttribute("aria-valuemin", "0");
    modelProgressPanel.setAttribute("aria-valuemax", "100");

    const progressTop = makeElement("div",
      "display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px;");
    modelProgressText = makeElement("div",
      "font:700 13px/1.35 Arial,sans-serif;color:#fff;min-width:0;",
      "Загружаем 3D-модель автомобиля…");
    modelProgressPercent = makeElement("div",
      "font:800 17px Arial,sans-serif;color:#f2d27c;white-space:nowrap;",
      "0%");
    progressTop.append(modelProgressText, modelProgressPercent);

    const progressTrack = makeElement("div",
      "height:9px;border-radius:99px;overflow:hidden;background:#29364a;border:1px solid #536078;");
    modelProgressFill = makeElement("div",
      "height:100%;width:0%;border-radius:99px;background:linear-gradient(90deg,#c49a3b,#ffe28c);" +
      "box-shadow:0 0 14px rgba(255,211,103,.42);transition:width .12s linear;");
    progressTrack.append(modelProgressFill);

    const progressStyle = makeElement("style");
    progressStyle.textContent = "@keyframes allcoins-model-progress-sweep{" +
      "from{transform:translateX(-115%)}to{transform:translateX(270%)}}";
    const progressHint = makeElement("div",
      "margin-top:8px;font:11px/1.35 Arial,sans-serif;color:#aebbd0;",
      "Первая загрузка может занять время. После неё модель сохранится на устройстве.");
    modelProgressPanel.append(progressTop, progressTrack, progressHint);

    overlay.append(frame, back); // Скрываем служебные статусы и панель передачи 3D-модели.
    oldBodyOverflow = document.body.style.overflow;
    oldRootOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    document.body.appendChild(overlay);
  }

  function roomCode(value) {
    const code = String(value || "").trim().toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{8}$/.test(code)) {
      throw new Error("Проверь восьмизначный код комнаты.");
    }
    return code;
  }

  function openModelCache() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error("IndexedDB недоступна"));
        return;
      }
      let request;
      try {
        request = window.indexedDB.open(MODEL_CACHE_DB, 1);
      } catch (error) {
        reject(error);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(MODEL_CACHE_STORE)) {
          db.createObjectStore(MODEL_CACHE_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Не удалось открыть кэш 3D-модели"));
      request.onblocked = () => reject(new Error("Хранилище 3D-модели занято"));
    });
  }

  function isValidGlbBuffer(buffer) {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 20 || buffer.byteLength > 104857600) {
      return false;
    }
    const header = new DataView(buffer, 0, 12);
    return header.getUint32(0, true) === 0x46546c67 &&
      header.getUint32(4, true) === 2 &&
      header.getUint32(8, true) === buffer.byteLength;
  }

  async function fetchRemoteModelVersion() {
    if (!RACING_AMVERA_API_BASE) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(
        RACING_AMVERA_API_BASE + "/api/racing/vaz-2107.glb?info=1",
        {
          method: "GET",
          cache: "no-store",
          credentials: "omit",
          signal: controller.signal
        }
      );
      if (!response.ok) {
        throw new Error("Проверка версии модели завершилась с HTTP " + response.status);
      }
      const info = await response.json();
      const updatedAt = Date.parse(info?.updatedAt || "");
      const bytes = Number(info?.bytes);
      if (info?.status !== "ok" || !Number.isFinite(updatedAt) ||
          !Number.isSafeInteger(bytes) || bytes < 20 || bytes > 104857600) {
        throw new Error("Amvera вернула некорректные сведения о версии ВАЗ-2107.");
      }
      return [
        String(updatedAt),
        String(bytes),
        String(info.fileName || "vaz-2107.glb")
      ].join(":");
    } finally {
      clearTimeout(timeout);
    }
  }

  async function readCachedModel(cacheKey = MODEL_CACHE_KEY) {
    const db = await openModelCache();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction(MODEL_CACHE_STORE, "readonly");
        const request = transaction.objectStore(MODEL_CACHE_STORE).get(cacheKey);
        let value = null;
        request.onsuccess = () => { value = request.result || null; };
        request.onerror = () => reject(request.error || new Error("Не удалось прочитать кэш модели"));
        transaction.oncomplete = () => {
          resolve(value && isValidGlbBuffer(value.buffer) ? value : null);
        };
        transaction.onerror = () => reject(transaction.error || new Error("Ошибка чтения кэша модели"));
        transaction.onabort = () => reject(transaction.error || new Error("Чтение кэша модели отменено"));
      });
    } finally {
      db.close();
    }
  }

  async function writeCachedModel(model) {
    let db;
    try {
      db = await openModelCache();
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(MODEL_CACHE_STORE, "readwrite");
        transaction.objectStore(MODEL_CACHE_STORE).put({
          buffer: model.buffer,
          fileName: model.fileName,
          remoteVersion: model.remoteVersion || null,
          savedAt: Date.now()
        }, MODEL_CACHE_KEY);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error("Не удалось сохранить модель"));
        transaction.onabort = () => reject(transaction.error || new Error("Сохранение модели отменено"));
      });
    } catch (error) {
      // Storage quotas or private browsing must never prevent the game from loading.
      console.warn("ALLCOINS Racing: persistent model cache unavailable:", error);
    } finally {
      if (db) db.close();
    }
  }

  async function loadSharedModel() {
    if (cachedModel) return cachedModel;
    if (loadingModel) return loadingModel;

    loadingModel = (async () => {
      // First recover the last model already stored on this device. The current
      // Amvera GLB was replaced with a different import, so version mismatch must
      // not evict the older known-good Racing car.
      setStatus("Восстанавливаем прежнюю ВАЗ-2107 с устройства…", false);
      const previousCacheKeys = [
        MODEL_CACHE_KEY,
        "v24-vaz-2107-glb-63426260-v1"
      ];
      let savedPrevious = null;
      let savedPreviousKey = null;
      for (const cacheKey of [...new Set(previousCacheKeys)]) {
        try {
          const candidate = await readCachedModel(cacheKey);
          if (candidate && isValidGlbBuffer(candidate.buffer)) {
            savedPrevious = candidate;
            savedPreviousKey = cacheKey;
            break;
          }
        } catch (error) {
          console.warn("ALLCOINS Racing: cached VAZ lookup failed for", cacheKey, error);
        }
      }
      if (savedPrevious) {
        const previousModel = {
          buffer: savedPrevious.buffer,
          fileName: savedPrevious.fileName || "vaz-2107-previous.glb",
          remoteVersion: savedPrevious.remoteVersion || null,
          source: "previous-device-cache",
          cacheKey: savedPreviousKey
        };
        cachedModel = previousModel;
        // Migrate the recovered known-good GLB into the active cache key so the
        // next launch restores it immediately, without downloading the newer import.
        if (savedPreviousKey !== MODEL_CACHE_KEY) await writeCachedModel(previousModel);
        setStatus("Прежняя ВАЗ-2107 восстановлена с устройства", false);
        hideModelProgress();
        return previousModel;
      }

      setStatus("Проверяем актуальность 3D-модели…", false);
      let remoteVersion = null;
      if (RACING_AMVERA_API_BASE) {
        try {
          remoteVersion = await fetchRemoteModelVersion();
        } catch (error) {
          // Offline play remains possible: a previously cached GLB may still be used.
          console.warn("ALLCOINS Racing: could not check the Amvera model version:", error);
        }
      }

      if (cachedModel && remoteVersion && cachedModel.remoteVersion === remoteVersion) {
        setStatus(remoteVersion
          ? "Актуальная 3D-модель уже загружена"
          : "Нет связи с Amvera: используем сохранённую модель", false);
        hideModelProgress();
        return cachedModel;
      }
      if (cachedModel && remoteVersion && cachedModel.remoteVersion !== remoteVersion) {
        cachedModel = null;
      }

      try {
        const saved = await readCachedModel();
        if (saved && remoteVersion && saved.remoteVersion === remoteVersion) {
          const model = {
            buffer: saved.buffer,
            fileName: saved.fileName || "vaz-2107.glb",
            remoteVersion: saved.remoteVersion || null
          };
          cachedModel = model;
          setStatus(remoteVersion
            ? "Актуальная 3D-модель загружена с устройства"
            : "Нет связи с Amvera: используем сохранённую модель", false);
          hideModelProgress();
          return model;
        }
      } catch (error) {
        console.warn("ALLCOINS Racing: could not read cached model:", error);
      }

      const chunks = [];
      let total = null;
      let fileName = "vaz-2107.glb";
      const useAmveraAsset = Boolean(RACING_AMVERA_API_BASE);
      const assetUrl = useAmveraAsset
        ? RACING_AMVERA_API_BASE + "/api/racing/vaz-2107.glb" +
          (remoteVersion ? "?v=" + encodeURIComponent(remoteVersion) : "?fresh=" + Date.now())
        : apiUrl("/api/racing/shared-model-asset");

      if (!useAmveraAsset) {
        console.warn("ALLCOINS Racing: Amvera model URL is not configured; retaining the legacy PC-tunnel model source.");
      }

      let start = 0;
      while (total === null || start < total) {
        const end = total === null ? start + CHUNK_SIZE - 1 : Math.min(total - 1, start + CHUNK_SIZE - 1);
        let response = null;

        setStatus("Загружаем 3D-модель автомобиля…", false);
        setModelProgress(
          total ? "Загрузка автомобиля · " + (start / 1048576).toFixed(1) + " / " + (total / 1048576).toFixed(1) + " МБ" :
            useAmveraAsset ? "Подключаемся к облачному хранилищу Amvera…" : "Подключаемся к локальной базе автомобиля…",
          total ? (start / total) * 100 : 0
        );

        for (let attempt = 1; attempt <= 5; attempt++) {
          const modelController = new AbortController();
          const modelTimeout = setTimeout(() => modelController.abort(), 30000);
          try {
            const modelHeaders = { Range: "bytes=" + start + "-" + end };
            // The fixed VAZ-2107 game asset is read-only/public; Amvera does not need a PC tunnel token.
            // Keep the bearer token only for backward compatibility with the legacy tunnel endpoint.
            // Public Amvera GLB asset; no separate racing token is used.
            response = await fetch(assetUrl, {
              method: "GET",
              headers: modelHeaders,
              cache: "no-store",
              signal: modelController.signal
            });
          } catch (error) {
            if (error && error.name === "AbortError") {
              throw new Error(useAmveraAsset
                ? "Amvera не передала файл автомобиля за 30 секунд. Проверь доступность приложения и хранилища."
                : "ПК не передал файл автомобиля за 30 секунд. Проверь работу Engine и туннеля.");
            }
            if (attempt === 5) {
              throw new Error(useAmveraAsset
                ? "Не удалось связаться с хранилищем Amvera. Проверь доступность адреса модели и настройки CORS."
                : "Сеть прервала загрузку 3D-модели.");
            }
            await new Promise(resolve => setTimeout(resolve, Math.min(10000, 1000 * 2 ** (attempt - 1))));
            continue;
          } finally {
            clearTimeout(modelTimeout);
          }

          if ([429, 502, 503, 504].includes(response.status)) {
            if (attempt === 5) throw new Error("Сервер временно не может передать 3D-модель. Повтори загрузку позже.");
            try { await response.body?.cancel(); } catch (_) {}
            await new Promise(resolve => setTimeout(resolve, Math.min(15000, 1200 * 2 ** (attempt - 1))));
            continue;
          }
          break;
        }

        if (!response || !response.ok) {
          throw new Error("Не удалось загрузить 3D-модель: HTTP " + (response ? response.status : "нет ответа"));
        }

        const headerName = response.headers.get("X-File-Name");
        if (headerName) {
          try { fileName = decodeURIComponent(headerName); } catch (_) { fileName = headerName; }
        }

        let range = null;
        let rangeEnd = null;
        if (response.status === 206) {
          range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("Content-Range") || "");
          if (!range || Number(range[1]) !== start) throw new Error("Сервер вернул неверный диапазон GLB.");
          rangeEnd = Number(range[2]);
          total = Number(range[3]);
          if (!Number.isSafeInteger(total) || total < 20 || total > 104857600 ||
              !Number.isSafeInteger(rangeEnd) || rangeEnd < start || rangeEnd >= total) {
            throw new Error("Сервер вернул неверный размер GLB.");
          }
        } else if (response.status === 200) {
          const contentLength = Number(response.headers.get("Content-Length") || 0);
          if (Number.isSafeInteger(contentLength) && contentLength > 0) total = contentLength;
        } else {
          throw new Error("Неожиданный ответ при загрузке 3D-модели.");
        }

        const buffer = await readModelResponse(response, start, total);
        if (response.status === 200) {
          if (!isValidGlbBuffer(buffer)) {
            throw new Error("Amvera вернула файл, который не прошёл проверку заголовка GLB 2.0.");
          }
          const model = { buffer, fileName, remoteVersion };
          setModelProgress("Сохранение 3D-модели на устройстве…", 100);
          await writeCachedModel(model);
          setStatus("3D-модель готова", false);
          return model;
        }

        if (buffer.byteLength !== rangeEnd - start + 1) {
          throw new Error("Получен неполный фрагмент GLB.");
        }
        chunks.push(new Uint8Array(buffer));
        start = rangeEnd + 1;
      }

      if (!total) throw new Error("Сохранённая 3D-модель пуста.");
      const combined = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      if (offset !== total) throw new Error("Получен неполный файл GLB.");
      if (!isValidGlbBuffer(combined.buffer)) {
        throw new Error("Собранный файл из Amvera не прошёл проверку GLB 2.0.");
      }
      const model = { buffer: combined.buffer, fileName, remoteVersion };
      await writeCachedModel(model);
      setModelProgress("Модель загружена и сохранена на устройстве", 100);
      setStatus("3D-модель сохранена на устройстве", false);
      return model;
    })();

    try {
      cachedModel = await loadingModel;
      return cachedModel;
    } finally {
      loadingModel = null;
    }
  }

  async function sendCarModel(target, targetOrigin) {
    target.postMessage({ type: "allcoins:car-model-loading" }, targetOrigin);
    const model = await loadSharedModel();
    // Telegram Android WebView may reject a single ~10 MB postMessage payload.
    // Transfer small ArrayBuffer chunks instead of one large GLB message.
    const chunkSize = 256 * 1024;
    const totalChunks = Math.ceil(model.buffer.byteLength / chunkSize);
    const transferId = "glb-" + Date.now().toString(36) + "-" +
      Math.random().toString(36).slice(2, 10);
    target.postMessage({
      type: "allcoins:car-model-start",
      transferId,
      fileName: model.fileName,
      byteLength: model.buffer.byteLength,
      remoteVersion: model.remoteVersion || null,
      chunkSize,
      totalChunks
    }, targetOrigin);

    for (let index = 0; index < totalChunks; index++) {
      const byteOffset = index * chunkSize;
      const chunk = model.buffer.slice(
        byteOffset,
        Math.min(model.buffer.byteLength, byteOffset + chunkSize)
      );
      target.postMessage({
        type: "allcoins:car-model-chunk",
        transferId,
        index,
        byteOffset,
        buffer: chunk
      }, targetOrigin, [chunk]);
      // Yield to the WebView event loop so incoming chunks are processed smoothly.
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    hideModelProgress();
  }

  async function handleRacingAction(data) {
    const action = String(data.action || "");

    // Paint purchases use the main ALLCOINS wallet API, not the racing-room server.
    if (action === "paint:profile") {
      if (!window.allcoinsRacingPaintApi || typeof window.allcoinsRacingPaintApi.profile !== "function") {
        throw new Error("Сервис гаража ALLCOINS ещё не готов.");
      }
      return await window.allcoinsRacingPaintApi.profile();
    }
    if (action === "paint:buy") {
      if (!window.allcoinsRacingPaintApi || typeof window.allcoinsRacingPaintApi.buy !== "function") {
        throw new Error("Сервис покупки красок ALLCOINS ещё не готов.");
      }
      return await window.allcoinsRacingPaintApi.buy(data.paintId);
    }
    if (action === "rims:profile") {
      if (!window.allcoinsRacingRimsApi || typeof window.allcoinsRacingRimsApi.profile !== "function") {
        throw new Error("Сервис дисков ALLCOINS ещё не готов.");
      }
      return await window.allcoinsRacingRimsApi.profile();
    }
    if (action === "rims:select") {
      if (!window.allcoinsRacingRimsApi || typeof window.allcoinsRacingRimsApi.select !== "function") {
        throw new Error("Установка дисков ALLCOINS ещё не подключена.");
      }
      return await window.allcoinsRacingRimsApi.select(data.rimId);
    }
    if (action === "rims:buy") {
      if (!window.allcoinsRacingRimsApi || typeof window.allcoinsRacingRimsApi.buy !== "function") {
        throw new Error("Покупка дисков ALLCOINS ещё не подключена.");
      }
      return await window.allcoinsRacingRimsApi.buy(data.rimId);
    }
    if (action === "parts:profile") {
      if (!window.allcoinsRacingPartsApi || typeof window.allcoinsRacingPartsApi.profile !== "function") {
        throw new Error("Сервис запчастей ALLCOINS ещё не готов.");
      }
      return await window.allcoinsRacingPartsApi.profile();
    }
    if (action === "parts:buy") {
      if (!window.allcoinsRacingPartsApi || typeof window.allcoinsRacingPartsApi.buy !== "function") {
        throw new Error("Сервис покупки запчастей ALLCOINS ещё не готов.");
      }
      return await window.allcoinsRacingPartsApi.buy(data.partId);
    }
    if (action === "parts:remove") {
      if (!window.allcoinsRacingPartsApi || typeof window.allcoinsRacingPartsApi.remove !== "function") {
        throw new Error("Снятие запчастей ALLCOINS ещё не подключено.");
      }
      return await window.allcoinsRacingPartsApi.remove(data.partId);
    }
    if (action === "parts:install") {
      if (!window.allcoinsRacingPartsApi || typeof window.allcoinsRacingPartsApi.install !== "function") {
        throw new Error("Установка запчастей со склада ALLCOINS ещё не подключена.");
      }
      return await window.allcoinsRacingPartsApi.install(data.partId);
    }
    if (action === "suspension:profile") {
      if (!window.allcoinsRacingSuspensionApi || typeof window.allcoinsRacingSuspensionApi.profile !== "function") {
        throw new Error("Сервис пневмоподвески ALLCOINS ещё не готов.");
      }
      return await window.allcoinsRacingSuspensionApi.profile();
    }
    if (action === "suspension:buy") {
      if (!window.allcoinsRacingSuspensionApi || typeof window.allcoinsRacingSuspensionApi.buy !== "function") {
        throw new Error("Покупка пневмоподвески ALLCOINS ещё не подключена.");
      }
      return await window.allcoinsRacingSuspensionApi.buy();
    }
    if (action === "fuel:profile") {
      if (!window.allcoinsRacingFuelApi || typeof window.allcoinsRacingFuelApi.profile !== "function") {
        throw new Error("АЗС ALLCOINS ещё не подключена.");
      }
      return await window.allcoinsRacingFuelApi.profile();
    }
    if (action === "fuel:buy") {
      if (!window.allcoinsRacingFuelApi || typeof window.allcoinsRacingFuelApi.buy !== "function") {
        throw new Error("Покупка бензина ALLCOINS ещё не подключена.");
      }
      return await window.allcoinsRacingFuelApi.buy(data.liters);
    }
    if (action === "fuel:use") {
      if (!window.allcoinsRacingFuelApi || typeof window.allcoinsRacingFuelApi.use !== "function") {
        throw new Error("Сохранение расхода бензина ALLCOINS ещё не подключено.");
      }
      return await window.allcoinsRacingFuelApi.use(data.usedLiters);
    }
    if (action === "garage:profile") {
      if (!window.allcoinsRacingGarageApi || typeof window.allcoinsRacingGarageApi.profile !== "function") {
        throw new Error("Автосалон ALLCOINS ещё не подключён.");
      }
      return await window.allcoinsRacingGarageApi.profile();
    }
    if (action === "garage:buy") {
      if (!window.allcoinsRacingGarageApi || typeof window.allcoinsRacingGarageApi.buyCar !== "function") {
        throw new Error("Покупка автомобиля ALLCOINS ещё не подключена.");
      }
      return await window.allcoinsRacingGarageApi.buyCar(data.carId);
    }
    if (action === "garage:claim-ad") {
      if (!window.allcoinsRacingGarageApi || typeof window.allcoinsRacingGarageApi.claimRewardedCar !== "function") {
        throw new Error("Награда за рекламу ALLCOINS ещё не подключена.");
      }
      return await window.allcoinsRacingGarageApi.claimRewardedCar(data.carId);
    }

    await ensureTelegramAuthentication();
    let result;
    switch (action) {
      case "rooms:list": {
        const data = await dragRacingPost("/rooms/list");
        result = {
          rooms: (data.rooms || []).map(room => ({
            code: String(room.id || ""),
            host_name: String(room.ownerName || "Игрок"),
            players: Number(room.playersCount || 0),
            max_players: Number(room.maxPlayers || 2),
            stake: Number(room.stake || 0),
            mode: String(room.mode || "quarter")
          })),
          currentRoom: data.currentRoom ? normalizeRoomPayload(data.currentRoom) : null
        };
        break;
      }
      case "room:create": {
        const maxPlayers = Number(data.maxPlayers === undefined ? 2 : data.maxPlayers);
        if (maxPlayers !== 2) throw new Error("В ALLCOINS Racing доступны комнаты строго на 2 игроков.");
        const payload = await dragRacingPost("/rooms/create", {
          maxPlayers: 2,
          mode: data.mode || "quarter",
          carId: data.carId
        });
        result = normalizeRoomPayload(payload);
        activeRoomCode = String(result.room?.code || "");
        break;
      }
      case "room:info":
      case "room:join":
      case "room:ready":
      case "room:start":
      case "room:leave":
      case "room:state":
      case "room:finish": {
        const code = String(data.code || data.roomId || activeRoomCode || "").trim().toUpperCase();
        const roomId = code.replace(/^DR-/, "");
        if (!/^[1-9]\d{0,17}$/.test(roomId)) throw new Error("Номер комнаты указан неверно.");
        const routes = {
          "room:info": "/rooms/state",
          "room:join": "/rooms/join",
          "room:ready": "/rooms/ready",
          "room:start": "/rooms/start",
          "room:leave": "/rooms/leave",
          "room:state": "/rooms/state",
          "room:finish": "/rooms/finish"
        };
        const body = { roomId };
        if (action === "room:state" && data.telemetry) body.telemetry = data.telemetry;
        if (action === "room:finish") body.timeMs = data.timeMs;
        if (action === "room:ready") body.ready = data.ready === true;
        const payload = await dragRacingPost(routes[action], body);
        result = normalizeRoomPayload(payload);
        if (action === "room:leave") {
          if (activeRoomCode === "DR-" + roomId) activeRoomCode = "";
        } else {
          activeRoomCode = "DR-" + roomId;
        }
        break;
      }
      case "room:ticket":
        throw new Error("WebSocket отключён. Используется HTTP-синхронизация.");
      default:
        throw new Error("Неизвестная операция гоночного режима.");
    }

    return result;
  }

  window.addEventListener("message", async event => {
    // The racing scene is loaded from the same GitHub Pages origin as this
    // Mini App. Check that origin, but do not rely on event.source identity:
    // Android Telegram WebView may wrap/replace WindowProxy objects.
    if (!frame || event.origin !== window.location.origin) return;

    const data = event.data || {};

    if (data.type === "allcoins:request-car-model") {
      setStatus("Запрос ВАЗ-2107 получен. Подключаемся к Amvera…", false);
      // Send a visible acknowledgement before any PC/network request starts.
      event.source.postMessage({ type: "allcoins:car-model-loading" }, event.origin);
      try {
        // The VAZ-2107 GLB is a public read-only asset on Amvera.
        // Do not block its delivery on Telegram room-server/PC-tunnel authentication.
        await sendCarModel(event.source, event.origin);
        setStatus("3D-модель передана в игровую сцену", false);
      } catch (error) {
        const message = error && error.message ? error.message : "Не удалось получить GLB-модель.";
        event.source.postMessage({
          type: "allcoins:car-model-error",
          message
        }, event.origin);
        setStatus("Ошибка загрузки автомобиля: " + message, true);
        setModelProgress("Не удалось загрузить автомобиль: " + message, 0);
        console.error("ALLCOINS Racing model transfer failed:", error);
      }
      return;
    }

    if (data.type !== "allcoins:racing:request") return;
    const requestId = typeof data.requestId === "string" ? data.requestId : "";
    if (!requestId || requestId.length > 80) return;

    try {
      const result = await handleRacingAction(data);
      event.source.postMessage({
        type: "allcoins:racing:response",
        requestId,
        ok: true,
        data: result
      }, event.origin);
    } catch (error) {
      event.source.postMessage({
        type: "allcoins:racing:response",
        requestId,
        ok: false,
        error: error && error.message ? error.message : "Ошибка подключения к гоночному серверу."
      }, event.origin);
    }
  });

  async function closeOverlay() {
    if (!overlay) return;
    const tg = window.Telegram && window.Telegram.WebApp;
    try {
      if (tg && tg.isFullscreen && typeof tg.exitFullscreen === "function") tg.exitFullscreen();
    } catch (error) {
      console.warn("ALLCOINS Racing: Telegram fullscreen exit was not available:", error);
    }
    const code = activeRoomCode;
    if (code) {
      try { await dragRacingPost("/rooms/leave", { roomId: code.replace(/^DR-/, "") }); } catch (_) {}
    }
    activeRoomCode = "";
    cachedModel = null;
    if (frame) {
      frame.srcdoc = "";
      frame.src = "about:blank";
    }
    overlay.remove();
    overlay = null;
    frame = null;
    statusNode = null;
    modelProgressPanel = null;
    modelProgressText = null;
    modelProgressPercent = null;
    modelProgressFill = null;
    document.body.style.overflow = oldBodyOverflow;
    document.documentElement.style.overflow = oldRootOverflow;
  }

  function requestRacingFullscreen() {
    const tg = window.Telegram && window.Telegram.WebApp;
    if (!tg) return;
    try {
      if (typeof tg.ready === "function") tg.ready();
      if (typeof tg.expand === "function") tg.expand();
      if (typeof tg.setHeaderColor === "function") tg.setHeaderColor("#070b13");
      if (typeof tg.setBackgroundColor === "function") tg.setBackgroundColor("#070b13");
      if (typeof tg.requestFullscreen === "function") {
        // Telegram Mini Apps Bot API 8.0+: use native immersive fullscreen.
        tg.requestFullscreen();
      } else if (document.documentElement.requestFullscreen) {
        const result = document.documentElement.requestFullscreen();
        if (result && typeof result.catch === "function") result.catch(() => {});
      }
    } catch (error) {
      console.warn("ALLCOINS Racing: fullscreen request was not accepted:", error);
    }
  }

  async function openRacing() {
    if (overlay) return;
    createOverlay();
    setStatus("Загружаем игровую сцену Telegram Mini App…", false);

    // Do not connect to the PC tunnel on single-player launch.
    // Telegram authentication is requested only when the player opens online rooms.
    try {
      const sceneUrl = new URL("./racing-game.html?v=20261127-opponent-sync-fix1", document.baseURI);
      const launchParams = new URLSearchParams(window.location.search);
      const restoreFactoryRims = launchParams.get("restoreFactoryRims") === "1";
      const perfTestMode = launchParams.get("perfTest");
      if (["render","physics","full"].includes(perfTestMode)) {
        sceneUrl.searchParams.set("perfTest", perfTestMode);
      }
      if (restoreFactoryRims) {
        sceneUrl.searchParams.set("restoreFactoryRims","1");
        const cleanLaunchUrl = new URL(window.location.href);
        cleanLaunchUrl.searchParams.delete("restoreFactoryRims");
        window.history.replaceState(window.history.state,"",cleanLaunchUrl.pathname+cleanLaunchUrl.search+cleanLaunchUrl.hash);
      }
      const sceneResponse = await fetch(sceneUrl.toString(), {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin"
      });
      if (!sceneResponse.ok) {
        throw new Error("Не удалось загрузить сцену Mini App: HTTP " + sceneResponse.status);
      }
      const sceneHtml = await sceneResponse.text();
      if (typeof sceneHtml !== "string" ||
          !/<html[\s>]/i.test(sceneHtml) ||
          !/<script[\s>]/i.test(sceneHtml) ||
          !/id=["']view["']/i.test(sceneHtml) ||
          !/allcoins:request-car-model/.test(sceneHtml)) {
        throw new Error("Файл racing-game.html не прошёл проверку игровой сцены и загрузчика автомобиля.");
      }

      // Load the scene as a real same-origin page, not srcdoc. This gives
      // Android WebView a normal base URL for ES modules/import maps and a
      // stable same-origin postMessage channel.
      frame.src = sceneUrl.toString();
      setStatus("Игровая сцена загружается…", false);
    } catch (error) {
      setStatus(error && error.message ? error.message : "Не удалось открыть гонку.", true);
      const note = makeElement("div",
        "position:absolute;left:18px;right:18px;top:50%;transform:translateY(-50%);" +
        "text-align:center;color:#ffb4b4;font:14px/1.5 Arial,sans-serif;padding:18px;" +
        "background:#171f2e;border:1px solid #513b48;border-radius:14px;",
        error && error.message ? error.message : "Не удалось открыть гонку.");
      overlay.appendChild(note);
      console.error("ALLCOINS Racing launch failed:", error);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const link = document.getElementById("openDragRacing");
    if (!link) return;
    link.addEventListener("click", event => {
      event.preventDefault();
      // Must run synchronously in the tap handler for Telegram to accept fullscreen.
      requestRacingFullscreen();
      void openRacing();
    });
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && overlay) void closeOverlay();
  });
})();