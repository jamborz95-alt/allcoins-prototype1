import express from "express";
import { configuredAdminTelegramId } from "./commission.js";

const router = express.Router();
const submissionWindows = new Map();
const CATEGORIES = new Set([
  "Зависание / тормоза",
  "Ошибка или вылет",
  "Карты / анимация",
  "Комнаты / подключение",
  "Баланс / ставка",
  "Другое"
]);

function clip(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function isConfiguredAdmin(user) {
  const adminId = configuredAdminTelegramId();
  return Boolean(adminId && user?.id && String(user.id) === adminId);
}

function isRateLimited(userId) {
  const now = Date.now();
  const key = String(userId);
  const recent = (submissionWindows.get(key) || []).filter(at => now - at < 15 * 60_000);
  if (recent.length >= 3) {
    submissionWindows.set(key, recent);
    return true;
  }
  recent.push(now);
  submissionWindows.set(key, recent);
  if (submissionWindows.size > 2000) {
    for (const [id, timestamps] of submissionWindows) {
      const kept = timestamps.filter(at => now - at < 15 * 60_000);
      if (kept.length) submissionWindows.set(id, kept);
      else submissionWindows.delete(id);
    }
  }
  return false;
}

async function analyzeTicket(ticket) {
  const apiKey = String(process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey) {
    return {
      severity: "unknown",
      summary: "ИИ-диагностика недоступна: GEMINI_API_KEY не настроен. Обращение сохранено.",
      needsDeveloper: true
    };
  }

  const model = String(process.env.GEMINI_MODEL || "gemini-3.5-flash-lite").trim();
  const prompt = [
    "Ты — технический помощник поддержки Telegram-игры ALLCOINS.",
    "Проанализируй сообщение игрока, не выдумывай логи и факты, которых нет в сообщении.",
    "Верни по-русски краткий ответ строго в формате:",
    "Приоритет: низкий / средний / высокий",
    "Кратко: одно предложение",
    "Что проверить: 1–3 конкретных пункта",
    "Нужен разработчик: да / нет",
    "Если данных мало, явно напиши, какой скриншот или шаги воспроизведения нужны.",
    "Категория: " + ticket.category,
    "Сообщение игрока: " + ticket.description,
    "Игрок: " + (ticket.first_name || "неизвестно") +
      (ticket.username ? " (@" + ticket.username + ")" : "")
  ].join("\n");

  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" +
        encodeURIComponent(model) + ":generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{
              text: "Помогай диагностировать баги честно и кратко. Не утверждай, что уже исправил код или отправил данные в ChatGPT. Не запрашивай пароли, API-ключи и токены."
            }]
          },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 220, temperature: 0.2 }
        }),
        signal: AbortSignal.timeout(20000)
      }
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error("Support AI analysis error:", response.status, payload?.error?.status || "unknown");
      return {
        severity: "unknown",
        summary: "ИИ временно не смог проанализировать обращение. Проверь текст заявки и при необходимости повтори диагностику.",
        needsDeveloper: true
      };
    }
    const candidate = Array.isArray(payload?.candidates) ? payload.candidates[0] : null;
    const summary = (Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [])
      .map(part => typeof part?.text === "string" ? part.text : "")
      .filter(Boolean)
      .join("\n")
      .trim()
      .slice(0, 1800);
    if (!summary) {
      return {
        severity: "unknown",
        summary: "ИИ вернул пустую диагностику. Нужны воспроизводимые шаги или скриншот проблемы.",
        needsDeveloper: true
      };
    }
    const severityMatch = summary.match(/Приоритет\s*:\s*(низкий|средний|высокий)/i);
    const needsMatch = summary.match(/Нужен разработчик\s*:\s*(да|нет)/i);
    return {
      severity: severityMatch ? severityMatch[1].toLowerCase() : "unknown",
      summary,
      needsDeveloper: needsMatch ? needsMatch[1].toLowerCase() === "да" : true
    };
  } catch (error) {
    console.error("Support AI analysis failed:", error?.name || "network");
    return {
      severity: "unknown",
      summary: "ИИ-диагностика временно недоступна. Обращение сохранено; проверь серверные логи и попробуй позже.",
      needsDeveloper: true
    };
  }
}

async function notifyAdmin(ticket, triage) {
  const botToken = String(process.env.BOT_TOKEN || "").trim();
  const adminId = configuredAdminTelegramId();
  if (!botToken || !adminId) return false;

  const notification = [
    "🛟 Новое обращение ALLCOINS #" + ticket.id,
    "Статус: " + (triage.needsDeveloper ? "нужна проверка разработчика" : "первичная проверка ИИ"),
    "Категория: " + ticket.category,
    "Игрок: " + (ticket.first_name || "Игрок") +
      (ticket.username ? " (@" + ticket.username + ")" : ""),
    "Telegram ID: " + ticket.telegram_id,
    "",
    "Сообщение:",
    ticket.description,
    "",
    "Диагностика ALLCOINS ИИ:",
    triage.summary
  ].join("\n").slice(0, 3900);

  try {
    const response = await fetch("https://api.telegram.org/bot" + botToken + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: adminId, text: notification, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(12000)
    });
    const result = await response.json().catch(() => ({}));
    return response.ok && result?.ok === true;
  } catch (error) {
    console.error("Support Telegram notification failed:", error?.name || "network");
    return false;
  }
}

async function processTicket(ticket) {
  try {
    const triage = await analyzeTicket(ticket);
    // Every support ticket must reach the owner; AI triage only sets the urgency.
    const notificationSent = await notifyAdmin(ticket, triage);
    const notificationStatus = notificationSent ? "sent" : "failed";
    await ticket.pool.query(
      `UPDATE allcoins_support_tickets
       SET ai_summary = $1,
           ai_severity = $2,
           needs_developer = $3,
           notification_status = $4,
           updated_at = NOW()
       WHERE id = $5`,
      [
        triage.summary,
        triage.severity,
        triage.needsDeveloper,
        notificationStatus,
        ticket.id
      ]
    );
  } catch (error) {
    console.error("Support ticket background processing failed:", error?.message || error);
    try {
      await ticket.pool.query(
        `UPDATE allcoins_support_tickets
         SET ai_summary = $1, notification_status = 'failed', updated_at = NOW()
         WHERE id = $2`,
        ["Обращение сохранено, но автоматическая диагностика/уведомление не завершились. Проверь панель поддержки в ALLCOINS.", ticket.id]
      );
    } catch (saveError) {
      console.error("Support ticket status update failed:", saveError?.message || saveError);
    }
  }
}

export function createSupportRouter({ pool, verifyTelegram }) {
  router.initialize = async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS allcoins_support_tickets (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        telegram_id BIGINT NOT NULL,
        username TEXT,
        first_name TEXT,
        category TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open'
          CHECK (status IN ('open', 'in_progress', 'resolved')),
        ai_summary TEXT,
        ai_severity TEXT,
        needs_developer BOOLEAN NOT NULL DEFAULT TRUE,
        notification_status TEXT NOT NULL DEFAULT 'pending'
          CHECK (notification_status IN ('pending', 'sent', 'failed', 'not_needed')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(
      "ALTER TABLE allcoins_support_tickets DROP CONSTRAINT IF EXISTS allcoins_support_tickets_notification_status_check"
    );
    await pool.query(
      "ALTER TABLE allcoins_support_tickets ADD CONSTRAINT allcoins_support_tickets_notification_status_check " +
      "CHECK (notification_status IN ('pending', 'sent', 'failed', 'not_needed'))"
    );
    await pool.query(
      "CREATE INDEX IF NOT EXISTS allcoins_support_tickets_created_idx " +
      "ON allcoins_support_tickets(created_at DESC)"
    );
    await pool.query(
      "CREATE INDEX IF NOT EXISTS allcoins_support_tickets_status_idx " +
      "ON allcoins_support_tickets(status, created_at DESC)"
    );
  };

  router.post("/submit", async (req, res) => {
    try {
      const user = verifyTelegram(req.body?.initData);
      if (!user?.id) {
        return res.status(401).json({ ok: false, error: "Открой ALLCOINS через Telegram, чтобы отправить обращение." });
      }

      const category = clip(req.body?.category, 60);
      const description = clip(req.body?.description, 1500);
      if (!CATEGORIES.has(category)) {
        return res.status(400).json({ ok: false, error: "Выбери категорию обращения." });
      }
      if (description.length < 10) {
        return res.status(400).json({ ok: false, error: "Опиши проблему подробнее — не менее 10 символов." });
      }
      if (isRateLimited(user.id)) {
        return res.status(429).json({ ok: false, error: "Можно отправить не более 3 обращений за 15 минут. Попробуй позже." });
      }

      const result = await pool.query(
        `INSERT INTO allcoins_support_tickets
          (telegram_id, username, first_name, category, description)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, telegram_id, username, first_name, category, description, status, created_at`,
        [
          String(user.id),
          clip(user.username, 80) || null,
          clip(user.first_name, 100) || "Игрок",
          category,
          description
        ]
      );
      const row = result.rows?.[0];
      if (!row) throw new Error("Support ticket insert returned no row");

      const ticket = {
        ...row,
        id: String(row.id),
        telegram_id: String(row.telegram_id),
        pool
      };

      // Save first and respond fast. AI triage and Telegram notification run afterward.
      res.status(201).json({
        ok: true,
        ticketId: ticket.id,
        status: "open",
        message: "Обращение сохранено. ALLCOINS ИИ анализирует проблему и отправит уведомление владельцу."
      });
      void processTicket(ticket);
      return;
    } catch (error) {
      console.error("Support ticket submit error:", error?.message || error);
      return res.status(500).json({ ok: false, error: "Не удалось сохранить обращение. Попробуй ещё раз." });
    }
  });

  router.post("/admin/list", async (req, res) => {
    try {
      const user = verifyTelegram(req.body?.initData);
      if (!user?.id) return res.status(401).json({ ok: false, error: "Открой приложение через Telegram." });
      const adminId = configuredAdminTelegramId();
      if (!adminId) return res.status(503).json({ ok: false, error: "ADMIN_TELEGRAM_ID не настроен в Render." });
      if (String(user.id) !== adminId) return res.status(403).json({ ok: false, error: "Доступ только для администратора." });

      const result = await pool.query(
        `SELECT id, telegram_id, username, first_name, category, description, status,
                ai_summary, ai_severity, needs_developer, notification_status, created_at, updated_at
         FROM allcoins_support_tickets
         ORDER BY created_at DESC
         LIMIT 50`
      );
      const counts = await pool.query(
        `SELECT COUNT(*)::INTEGER AS total,
                COUNT(*) FILTER (WHERE status = 'open')::INTEGER AS open,
                COUNT(*) FILTER (WHERE status = 'in_progress')::INTEGER AS in_progress,
                COUNT(*) FILTER (WHERE status = 'resolved')::INTEGER AS resolved
         FROM allcoins_support_tickets`
      );
      return res.json({
        ok: true,
        admin: true,
        counts: counts.rows?.[0] || { total: 0, open: 0, in_progress: 0, resolved: 0 },
        tickets: (result.rows || []).map(row => ({
          ...row,
          id: String(row.id),
          telegram_id: String(row.telegram_id)
        }))
      });
    } catch (error) {
      console.error("Support admin list error:", error?.message || error);
      return res.status(500).json({ ok: false, error: "Не удалось загрузить обращения поддержки." });
    }
  });

  router.post("/admin/status", async (req, res) => {
    try {
      const user = verifyTelegram(req.body?.initData);
      if (!user?.id) return res.status(401).json({ ok: false, error: "Открой приложение через Telegram." });
      const adminId = configuredAdminTelegramId();
      if (!adminId) return res.status(503).json({ ok: false, error: "ADMIN_TELEGRAM_ID не настроен в Render." });
      if (String(user.id) !== adminId) return res.status(403).json({ ok: false, error: "Доступ только для администратора." });

      const ticketId = String(req.body?.ticketId || "");
      const status = String(req.body?.status || "");
      if (!/^\d{1,18}$/.test(ticketId) || !["open", "in_progress", "resolved"].includes(status)) {
        return res.status(400).json({ ok: false, error: "Неверный номер обращения или статус." });
      }
      const result = await pool.query(
        `UPDATE allcoins_support_tickets
         SET status = $1, updated_at = NOW()
         WHERE id = $2
         RETURNING id, status`,
        [status, ticketId]
      );
      if (!result.rows?.length) return res.status(404).json({ ok: false, error: "Обращение не найдено." });
      return res.json({ ok: true, ticketId: String(result.rows[0].id), status: result.rows[0].status });
    } catch (error) {
      console.error("Support admin status update error:", error?.message || error);
      return res.status(500).json({ ok: false, error: "Не удалось обновить статус обращения." });
    }
  });

  return router;
}
