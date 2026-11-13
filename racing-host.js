(() => {
  "use strict";

  // Set this to the public HTTPS Cloudflare Tunnel address for the local Engine.
  const RACING_API_BASE = "https://harold-overcome-acdbentity-breeding.trycloudflare.com";
  const CHUNK_SIZE = 16 * 1024 * 1024;
  // Bump this key whenever the saved VAZ-2107 GLB is replaced.
  const MODEL_CACHE_DB = "allcoins-racing-model-cache";
  const MODEL_CACHE_STORE = "models";
  const MODEL_CACHE_KEY = "v24-vaz-2107-glb-63426260-v1";

  let engineToken = "";
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
    if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(RACING_API_BASE)) {
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

  async function readModelResponse(response, start, total) {
    // Keep the proven small-buffer download path; the visible bar animates while each range arrives.
    const buffer = await response.arrayBuffer();
    const loaded = start + buffer.byteLength;
    const currentMb = (loaded / 1048576).toFixed(1);
    const totalMb = total ? (total / 1048576).toFixed(1) : "";
    const percent = total ? Math.min(100, loaded / total * 100) : null;
    setModelProgress(
      total ? "Загрузка автомобиля · " + currentMb + " / " + totalMb + " МБ" :
        "Получено " + currentMb + " МБ. Подготавливаем автомобиль…",
      percent
    );
    return buffer;
  }

  async function requestApi(path, options) {
    const settings = options || {};
    const headers = Object.assign({}, settings.headers || {});
    if (settings.authorized !== false) {
      if (!engineToken) throw new Error("Сначала необходимо подтвердить вход через Telegram.");
      headers.Authorization = "Bearer " + engineToken;
    }
    const request = {
      method: settings.method || "GET",
      headers,
      cache: "no-store"
    };
    if (settings.body !== undefined) {
      headers["Content-Type"] = "application/json";
      request.body = JSON.stringify(settings.body);
    }

    let response;
    try {
      response = await fetch(apiUrl(path), request);
    } catch (error) {
      throw new Error("Не удалось связаться с гоночным сервером. Проверь подключение к ПК.");
    }

    const raw = await response.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch (_) {
      throw new Error("Сервер вернул некорректный ответ.");
    }

    if (!response.ok) {
      if (response.status === 401) engineToken = "";
      throw new Error(data.error || ("Ошибка гоночного сервера: HTTP " + response.status));
    }
    return data;
  }

  async function authenticateTelegram() {
    const tg = window.Telegram && window.Telegram.WebApp;
    if (!tg || !tg.initData) {
      throw new Error("Открой ALLCOINS через Telegram, чтобы войти в гонку.");
    }
    try {
      tg.ready();
      tg.expand();
    } catch (_) {}

    const result = await requestApi("/api/auth/telegram", {
      method: "POST",
      body: { initData: tg.initData },
      authorized: false
    });
    if (!result || typeof result.token !== "string" || !result.token) {
      throw new Error("Сервер не выдал игровую сессию Telegram.");
    }
    engineToken = result.token;
    return result.user || null;
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

    overlay.append(frame, back, statusNode, progressStyle, modelProgressPanel);
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

  async function readCachedModel() {
    const db = await openModelCache();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction(MODEL_CACHE_STORE, "readonly");
        const request = transaction.objectStore(MODEL_CACHE_STORE).get(MODEL_CACHE_KEY);
        let value = null;
        request.onsuccess = () => { value = request.result || null; };
        request.onerror = () => reject(request.error || new Error("Не удалось прочитать кэш модели"));
        transaction.oncomplete = () => {
          if (value && value.buffer instanceof ArrayBuffer && value.buffer.byteLength >= 4) {
            const magic = new TextDecoder().decode(new Uint8Array(value.buffer, 0, 4));
            resolve(magic === "glTF" ? value : null);
          } else {
            resolve(null);
          }
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
      setStatus("Проверяем кэш 3D-модели…", false);
      try {
        const saved = await readCachedModel();
        if (saved) {
          setStatus("3D-модель загружена с устройства", false);
          hideModelProgress();
          return { buffer: saved.buffer, fileName: saved.fileName || "vaz-2107.glb" };
        }
      } catch (error) {
        console.warn("ALLCOINS Racing: could not read cached model:", error);
      }

      const chunks = [];
      let total = null;
      let fileName = "vaz-2107.glb";

      let start = 0;
      while (total === null || start < total) {
        const end = total === null ? start + CHUNK_SIZE - 1 : Math.min(total - 1, start + CHUNK_SIZE - 1);
        let response = null;

        setStatus("Загружаем 3D-модель автомобиля…", false);
        setModelProgress(
          total ? "Загрузка автомобиля · " + (start / 1048576).toFixed(1) + " / " + (total / 1048576).toFixed(1) + " МБ" :
            "Подключаемся к локальной базе автомобиля…",
          total ? (start / total) * 100 : 0
        );

        for (let attempt = 1; attempt <= 5; attempt++) {
          try {
            response = await fetch(apiUrl("/api/racing/shared-model-asset"), {
              method: "GET",
              headers: {
                Authorization: "Bearer " + engineToken,
                Range: "bytes=" + start + "-" + end
              },
              cache: "no-store"
            });
          } catch (error) {
            if (attempt === 5) throw new Error("Сеть прервала загрузку 3D-модели.");
            await new Promise(resolve => setTimeout(resolve, Math.min(10000, 1000 * 2 ** (attempt - 1))));
            continue;
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
          if (!Number.isSafeInteger(total) || total <= 0 || !Number.isSafeInteger(rangeEnd) ||
              rangeEnd < start || rangeEnd >= total) {
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
          if (!buffer.byteLength) throw new Error("Сервер вернул пустую 3D-модель.");
          const model = { buffer, fileName };
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
      const model = { buffer: combined.buffer, fileName };
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
    const transferable = model.buffer.slice(0);
    target.postMessage({
      type: "allcoins:car-model",
      fileName: model.fileName,
      buffer: transferable
    }, targetOrigin, [transferable]);
    hideModelProgress();
  }

  async function handleRacingAction(data) {
    const action = String(data.action || "");
    let result;

    switch (action) {
      case "rooms:list":
        result = await requestApi("/api/racing/rooms");
        break;

      case "room:create": {
        const maxPlayers = Number(data.maxPlayers === undefined ? 5 : data.maxPlayers);
        if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 5) {
          throw new Error("В комнате должно быть от 2 до 5 игроков.");
        }
        result = await requestApi("/api/racing/rooms", {
          method: "POST",
          body: { maxPlayers }
        });
        activeRoomCode = result.room && result.room.code ? String(result.room.code) : "";
        break;
      }

      case "room:info": {
        const code = roomCode(data.code);
        result = await requestApi("/api/racing/rooms/" + encodeURIComponent(code));
        activeRoomCode = code;
        break;
      }

      case "room:join": {
        const code = roomCode(data.code);
        result = await requestApi("/api/racing/rooms/" + encodeURIComponent(code) + "/join", {
          method: "POST",
          body: {}
        });
        activeRoomCode = code;
        break;
      }

      case "room:ready": {
        const code = roomCode(data.code);
        result = await requestApi("/api/racing/rooms/" + encodeURIComponent(code) + "/ready", {
          method: "POST",
          body: { ready: data.ready === true }
        });
        activeRoomCode = code;
        break;
      }

      case "room:leave": {
        const code = roomCode(data.code || activeRoomCode);
        result = await requestApi("/api/racing/rooms/" + encodeURIComponent(code) + "/leave", {
          method: "POST",
          body: {}
        });
        if (activeRoomCode === code) activeRoomCode = "";
        break;
      }

      case "room:start": {
        const code = roomCode(data.code);
        result = await requestApi("/api/racing/rooms/" + encodeURIComponent(code) + "/start", {
          method: "POST",
          body: {}
        });
        activeRoomCode = code;
        break;
      }

      case "room:ticket": {
        result = await requestApi("/api/racing/ticket", {
          method: "POST",
          body: {}
        });
        const socketUrl = new URL("/ws/racing", RACING_API_BASE);
        socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
        result.wsUrl = socketUrl.toString();
        break;
      }

      default:
        throw new Error("Неизвестная операция гоночного режима.");
    }

    return result;
  }

  window.addEventListener("message", async event => {
    if (!frame || event.source !== frame.contentWindow) return;
    if (event.origin !== window.location.origin) return;

    const data = event.data || {};
    if (data.type === "allcoins:request-car-model") {
      try {
        await sendCarModel(event.source, event.origin);
      } catch (error) {
        event.source.postMessage({
          type: "allcoins:car-model-error",
          message: error && error.message ? error.message : "Не удалось получить GLB-модель."
        }, event.origin);
        setModelProgress("Не удалось загрузить автомобиль: " +
          (error && error.message ? error.message : "ошибка загрузки"), 0);
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
    if (code && engineToken) {
      try {
        await requestApi("/api/racing/rooms/" + encodeURIComponent(code) + "/leave", {
          method: "POST",
          body: {}
        });
      } catch (_) {}
    }
    activeRoomCode = "";
    cachedModel = null;
    if (frame) frame.srcdoc = "";
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
    setStatus("Проверяем Telegram…", false);

    try {
      await authenticateTelegram();
      setStatus("Загружаем V24…", false);
      const game = await requestApi("/api/racing/game");
      if (!game || typeof game.content !== "string" ||
          !/<html[\s>]/i.test(game.content) || !/<script[\s>]/i.test(game.content)) {
        throw new Error("Сервер не вернул корректный игровой файл V24.");
      }
      frame.srcdoc = game.content;
      setStatus("V24 подключена", false);
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