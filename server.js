"use strict";
const path = require("path");
const express = require("express");

const { listConstructors } = require("./notion");
const { buildReport } = require("./report");
const { buildXlsx } = require("./export_xlsx");
const { buildPdf } = require("./export_pdf");
const { requireTelegramAuth } = require("./telegram_auth");
const { sendDocument } = require("./telegram_bot");

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/assets", express.static(path.join(__dirname, "assets")));

app.get("/api/constructors", requireTelegramAuth, async (req, res) => {
  try {
    res.json(await listConstructors());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/report", requireTelegramAuth, async (req, res) => {
  try {
    const { constructorId, startDate, endDate } = req.body || {};
    if (!constructorId || !startDate || !endDate) {
      return res.status(400).json({ error: "Потрібні constructorId, startDate, endDate." });
    }
    res.json(await buildReport(constructorId, startDate, endDate));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/export", requireTelegramAuth, async (req, res) => {
  try {
    const { constructorId, constructorName, startDate, endDate, periodLabel, format } = req.body || {};
    if (!constructorId || !startDate || !endDate || !format) {
      return res.status(400).json({ error: "Потрібні constructorId, startDate, endDate, format." });
    }

    const { tasks, totals } = await buildReport(constructorId, startDate, endDate);
    const payload = { constructorName: constructorName || "Конструктор", periodLabel: periodLabel || "", tasks, totals };

    let buffer, filename;
    if (format === "xlsx") {
      buffer = await buildXlsx(payload);
      filename = `Звіт ${payload.constructorName}.xlsx`;
    } else if (format === "pdf") {
      buffer = await buildPdf(payload);
      filename = `Звіт ${payload.constructorName}.pdf`;
    } else {
      return res.status(400).json({ error: "format має бути 'xlsx' або 'pdf'." });
    }

    await sendDocument(req.telegramUser.id, buffer, filename, payload.periodLabel);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Telegram report app listening on port ${PORT}`);
});
