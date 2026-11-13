(() => {
  "use strict";

  // Set this to the public HTTPS Cloudflare Tunnel address for the local Engine.
  const RACING_API_BASE = "https://harold-overcome-acdbentity-breeding.trycloudflare.com";
  const CHUNK_SIZE = 16 * 1024 * 1024;

  let engineToken = "";
  let overlay = null;
  let frame = null;
  let statusNode = null;
  let activeRoomCode = "";
  let cachedModel = null;
  let loadingModel = null;
  let oldBodyOverflow = "";

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
      "position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;" +
      "background:#070b13;color:#fff;overflow:hidden;overscroll-behavior:contain;");
    overlay.id = "allcoinsRacingV24Overlay";

    const header = makeElement("div",
      "height:52px;min-height:52px;display:flex;align-items:center;gap:10px;" +
      "padding:6px 10px;background:#111a2a;border-bottom:1px solid #344158;" +
      "font:600 14px Arial,sans-serif;");
    const back = makeElement("button",
      "border:1px solid #506078;border-radius:9px;background:#202d42;color:#fff;" +
      "padding:8px 12px;font:700 14px Arial,sans-serif;cursor:pointer;",
      "← Назад");
    back.type = "button";
    back.addEventListener("click", closeOverlay);

    const title = makeElement("div",
      "flex:1;min-width:0;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
      "ALLCOINS Racing V24");

    statusNode = makeElement("div",
      "max-width:42%;font:11px Arial,sans-serif;color:#cbd5e1;text-align:right;",
      "Подключение…");
    statusNode.setAttribute("aria-live", "polite");

    header.append(back, title, statusNode);

    frame = document.createElement("iframe");
    frame.title = "ALLCOINS Racing V24";
    frame.allow = "fullscreen; autoplay; gamepad; picture-in-picture";
    frame.allowFullscreen = true;
    frame.style.cssText = "display:block;flex:1 1 auto;width:100%;height:calc(100% - 52px);" +
      "min-height:0;border:0;background:#080d18;";
    frame.addEventListener("load", () => setStatus("Гоночный экран загружен", false));

    overlay.append(header, frame);
    oldBodyOverflow = document.body.style.overflow;
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

  async function loadSharedModel() {
    if (cachedModel) return cachedModel;
    if (loadingModel) return loadingModel;

    loadingModel = (async () => {
      const chunks = [];
      let total = null;
      let fileName = "vaz-2107.glb";

      for (let start = 0; total === null || start < total; start += CHUNK_SIZE) {
        const end = total === null ? start + CHUNK_SIZE - 1 : Math.min(total - 1, start + CHUNK_SIZE - 1);
        let response = null;

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

        const buffer = await response.arrayBuffer();
        if (response.status === 200) {
          if (!buffer.byteLength) throw new Error("Сервер вернул пустую 3D-модель.");
          return { buffer, fileName };
        }
        if (response.status !== 206) throw new Error("Неожиданный ответ при загрузке 3D-модели.");

        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("Content-Range") || "");
        if (!range || Number(range[1]) !== start) throw new Error("Сервер вернул неверный диапазон GLB.");
        total = Number(range[3]);
        if (!Number.isSafeInteger(total) || total <= 0 ||
            buffer.byteLength !== Number(range[2]) - Number(range[1]) + 1) {
          throw new Error("Получен неполный фрагмент GLB.");
        }
        chunks.push(new Uint8Array(buffer));
      }

      if (!total) throw new Error("Сохранённая 3D-модель пуста.");
      const combined = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      if (offset !== total) throw new Error("Получен неполный файл GLB.");
      return { buffer: combined.buffer, fileName };
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
    document.body.style.overflow = oldBodyOverflow;
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
      void openRacing();
    });
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && overlay) void closeOverlay();
  });
})();