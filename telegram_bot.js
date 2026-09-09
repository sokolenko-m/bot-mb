"use strict";
/** Sends the generated report file to the user's own Telegram chat via the Bot API. */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

async function sendDocument(chatId, buffer, filename, caption) {
  if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN не задан на сервере.");

  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) form.append("caption", caption);
  form.append("document", new Blob([buffer]), filename);

  const resp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, {
    method: "POST",
    body: form,
  });
  const data = await resp.json();
  if (!resp.ok || !data.ok) {
    throw new Error(`Telegram sendDocument: ${data.description || resp.status}`);
  }
  return data;
}

module.exports = { sendDocument };
