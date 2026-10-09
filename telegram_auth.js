"use strict";
/**
 * Validates Telegram Mini App `initData` per the official algorithm:
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * Доступ мають лише:
 *  - Telegram ID зі змінної оточення ALLOWED_USER_IDS (через кому) — запасний
 *    "ключ" адміністратора, працює навіть якщо Notion недоступний;
 *  - люди з "Участники_1" в Notion, у яких заповнено "Telegram ID" і стоїть
 *    галочка "Доступ до звітів" (список кешується на 5 хв).
 * Якщо список із Notion отримати не вдалося — доступ закритий (крім ALLOWED_USER_IDS).
 */

const crypto = require("crypto");
const { listReportAccessTelegramIds } = require("./notion");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_USER_IDS = new Set(
  (process.env.ALLOWED_USER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);
const MAX_AGE_SECONDS = 24 * 3600;
const ACCESS_CACHE_TTL_MS = 5 * 60 * 1000;
// Якщо Notion тимчасово не відповідає — ще годину користуємось останнім
// успішно отриманим списком, далі доступ закривається.
const ACCESS_CACHE_MAX_STALE_MS = 60 * 60 * 1000;

class AuthError extends Error {
  constructor(message, status = 403) {
    super(message);
    this.status = status;
  }
}

/** Returns the validated Telegram user object, or throws AuthError. */
function validateInitData(initData) {
  if (!BOT_TOKEN) throw new AuthError("TELEGRAM_BOT_TOKEN не задано на сервері.", 500);
  if (!initData) throw new AuthError("Немає initData — відкривайте цей застосунок лише через Telegram.");

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) throw new AuthError("initData без підпису.");
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  const hashBuf = Buffer.from(hash, "hex");
  const computedBuf = Buffer.from(computedHash, "hex");
  if (hashBuf.length !== computedBuf.length || !crypto.timingSafeEqual(hashBuf, computedBuf)) {
    throw new AuthError("Неверная подпись initData.");
  }

  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Date.now() / 1000 - authDate > MAX_AGE_SECONDS) {
    throw new AuthError("initData застаріла, відкрийте застосунок ще раз.");
  }

  const userRaw = params.get("user");
  if (!userRaw) throw new AuthError("У initData немає даних користувача.");
  return JSON.parse(userRaw);
}

let accessCache = { ids: null, fetchedAt: 0 };
let accessFetch = null;

/** Set Telegram ID з галочкою "Доступ до звітів" або null, якщо Notion недоступний. */
async function notionAllowedIds() {
  const age = Date.now() - accessCache.fetchedAt;
  if (accessCache.ids && age < ACCESS_CACHE_TTL_MS) return accessCache.ids;
  if (!accessFetch) {
    accessFetch = listReportAccessTelegramIds()
      .then((ids) => {
        accessCache = { ids, fetchedAt: Date.now() };
      })
      .catch((e) => {
        console.error("Не вдалося отримати список доступу з Notion:", e.message);
      })
      .finally(() => {
        accessFetch = null;
      });
  }
  await accessFetch;
  const freshAge = Date.now() - accessCache.fetchedAt;
  return accessCache.ids && freshAge < ACCESS_CACHE_MAX_STALE_MS ? accessCache.ids : null;
}

async function assertAllowed(user) {
  const id = String(user.id);
  if (ALLOWED_USER_IDS.has(id)) return;
  const ids = await notionAllowedIds();
  if (!ids) {
    throw new AuthError("Не вдалося перевірити доступ (Notion недоступний). Спробуйте за кілька хвилин.", 503);
  }
  if (!ids.has(id)) {
    throw new AuthError(
      `Доступ до звітів закритий. Ваш Telegram ID: ${id}. ` +
        "Попросіть адміністратора вписати його в Notion («Участники_1» → «Telegram ID») і поставити галочку «Доступ до звітів»."
    );
  }
}

/** Express middleware: reads initData from the X-Telegram-Init-Data header. */
async function requireTelegramAuth(req, res, next) {
  try {
    const user = validateInitData(req.header("X-Telegram-Init-Data"));
    await assertAllowed(user);
    req.telegramUser = user;
    next();
  } catch (e) {
    res.status(e.status || 403).json({ error: e.message });
  }
}

module.exports = { validateInitData, requireTelegramAuth, AuthError };
