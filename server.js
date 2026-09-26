"use strict";
const path = require("path");
const express = require("express");

const { listConstructors, listObjectsForConstructor } = require("./notion");
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

app.get("/api/objects", requireTelegramAuth, async (req, res) => {
  try {
    const { constructorId } = req.query;
    if (!constructorId) return res.status(400).json({ error: "Потрібен constructorId." });
    res.json(await listObjectsForConstructor(constructorId));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function reportOptionsFromBody(body) {
  const { startDate, endDate, objectId } = body || {};
  if (objectId) return { objectId };
  return { startDateStr: startDate, endDateStr: endDate };
}

app.post("/api/report", requireTelegramAuth, async (req, res) => {
  try {
    const { constructorId, startDate, endDate, objectId } = req.body || {};
    if (!constructorId) return res.status(400).json({ error: "Потрібен constructorId." });
    if (!objectId && (!startDate || !endDate)) {
      return res.status(400).json({ error: "Потрібен період (startDate, endDate) або objectId." });
    }
    res.json(await buildReport(constructorId, reportOptionsFromBody(req.body)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/export", requireTelegramAuth, async (req, res) => {
  try {
    const { constructorId, constructorName, startDate, endDate, objectId, periodLabel, format } = req.body || {};
    if (!constructorId || !format) {
      return res.status(400).json({ error: "Потрібні constructorId, format." });
    }
    if (!objectId && (!startDate || !endDate)) {
      return res.status(400).json({ error: "Потрібен період (startDate, endDate) або objectId." });
    }

    const { tasks, totals } = await buildReport(constructorId, reportOptionsFromBody(req.body));
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
