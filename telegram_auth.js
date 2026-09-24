"use strict";
/**
 * Validates Telegram Mini App `initData` per the official algorithm:
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * Also enforces an allowlist of Telegram user ids (ALLOWED_USER_IDS env var,
 * comma-separated) — only "я + руководители отделов" should see reports.
 */

const crypto = require("crypto");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_USER_IDS = new Set(
  (process.env.ALLOWED_USER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);
const MAX_AGE_SECONDS = 24 * 3600;

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
  const user = JSON.parse(userRaw);

  // Якщо ALLOWED_USER_IDS не задано (порожньо) — доступ відкритий для всіх,
  // хто відкриє бота. Підпис initData все одно перевіряється вище, тобто
  // підробити запит без справжнього Telegram неможливо в будь-якому разі.
  if (ALLOWED_USER_IDS.size > 0 && !ALLOWED_USER_IDS.has(String(user.id))) {
    throw new AuthError(`Доступ заборонено для користувача ${user.id}.`);
  }

  return user;
}

/** Express middleware: reads initData from the X-Telegram-Init-Data header. */
function requireTelegramAuth(req, res, next) {
  try {
    req.telegramUser = validateInitData(req.header("X-Telegram-Init-Data"));
    next();
  } catch (e) {
    res.status(e.status || 403).json({ error: e.message });
  }
}

module.exports = { validateInitData, requireTelegramAuth, AuthError };
