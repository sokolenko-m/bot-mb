"use strict";
const path = require("path");
const express = require("express");

const { listConstructors, listObjectsForConstructor } = require("./notion");
const { buildReport } = require("./report");
const { buildXlsx } = require("./export_xlsx");
const { buildPdf } = require("./export_pdf");
const { requireTelegramAuth } = require("./telegram_auth");
const { sendDocument } = require("./telegram_bot");
const plans = require("./plans");
const { planPayload, reconciliationPayload } = require("./plan_payloads");
const { PlanError, parseMonth, canFixMonth, nextMonth, todayKyiv } = require("./month");

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
  const { startDate, endDate, objectIds, objectNames } = body || {};
  if (Array.isArray(objectIds) && objectIds.length > 0) return { objectIds, objectNames };
  return { startDateStr: startDate, endDateStr: endDate };
}

function validateReportParams(body) {
  const { constructorId, startDate, endDate, objectIds } = body || {};
  if (!constructorId) return "Потрібен constructorId.";
  const hasObjects = Array.isArray(objectIds) && objectIds.length > 0;
  if (!hasObjects && (!startDate || !endDate)) {
    return "Потрібен період (startDate, endDate) або хоча б один об'єкт.";
  }
  return null;
}

app.post("/api/report", requireTelegramAuth, async (req, res) => {
  try {
    const error = validateReportParams(req.body);
    if (error) return res.status(400).json({ error });
    res.json(await buildReport(req.body.constructorId, reportOptionsFromBody(req.body)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/export", requireTelegramAuth, async (req, res) => {
  try {
    const { constructorId, constructorName, format } = req.body || {};
    const error = validateReportParams(req.body);
    if (error) return res.status(400).json({ error });
    if (!format) return res.status(400).json({ error: "Потрібен format." });

    const { tasks, totals, periodLabel } = await buildReport(constructorId, reportOptionsFromBody(req.body));
    const payload = { constructorName: constructorName || "Конструктор", periodLabel, tasks, totals };

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

// --- Плани місяця і звірка ---

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function planEditorIds() {
  return new Set(
    (process.env.PLAN_EDITOR_IDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}
function canFixPlans(user) {
  return planEditorIds().has(String(user.id));
}

function parseConstructorId(value) {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new PlanError("Потрібен коректний constructorId.");
  return value;
}

/** Ім'я береться з Notion, а не з запиту: у план не можна записати підроблене. */
async function constructorNameOf(constructorId) {
  const found = (await listConstructors()).find((c) => c.id === constructorId);
  if (!found) throw new PlanError("Такого конструктора не знайдено.");
  return found.name;
}

function planRoute(handler) {
  return async (req, res) => {
    try {
      res.json(await handler(req));
    } catch (e) {
      if (e instanceof PlanError) return res.status(e.httpStatus).json({ error: e.message });
      console.error("Помилка планів:", e.message);
      res.status(500).json({ error: e.message });
    }
  };
}

function telegramAuthor(user) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ") || "Без імені";
  return `${name} (${user.id})`;
}

async function sendPlanPdf(user, plan, constructorName) {
  const payload = planPayload(plan, constructorName);
  const buffer = await buildPdf(payload);
  await sendDocument(user.id, buffer, `План ${constructorName} ${plan.month}.pdf`, payload.periodLabel);
}

app.get(
  "/api/me",
  requireTelegramAuth,
  planRoute(async (req) => {
    const today = todayKyiv();
    const currentMonth = today.slice(0, 7);
    return { canFixPlans: canFixPlans(req.telegramUser), today, currentMonth, nextMonth: nextMonth(currentMonth) };
  })
);

app.get(
  "/api/plans",
  requireTelegramAuth,
  planRoute((req) => {
    parseMonth(req.query.month);
    return plans.listPlanStatuses(req.query.month);
  })
);

app.get(
  "/api/plans/preview",
  requireTelegramAuth,
  planRoute((req) => {
    parseMonth(req.query.month);
    return plans.previewPlan(req.query.month, parseConstructorId(req.query.constructorId));
  })
);

app.get(
  "/api/plans/versions",
  requireTelegramAuth,
  planRoute((req) => {
    parseMonth(req.query.month);
    return plans.listVersions(req.query.month, parseConstructorId(req.query.constructorId));
  })
);

app.post(
  "/api/plans/fix",
  requireTelegramAuth,
  planRoute(async (req) => {
    if (!canFixPlans(req.telegramUser)) throw new PlanError("Фіксувати план може лише керівник.", 403);
    const { month } = parseMonth(req.body?.month);
    const constructorId = parseConstructorId(req.body?.constructorId);
    if (!canFixMonth(month, todayKyiv())) throw new PlanError("Зафіксувати можна лише поточний або наступний місяць.");
    const constructorName = await constructorNameOf(constructorId);

    const result = await plans.fixPlan({ month, constructorId, constructorName, fixedBy: telegramAuthor(req.telegramUser) });
    if (result.status !== "fixed") return result;

    try {
      await sendPlanPdf(req.telegramUser, await plans.getActivePlan(month, constructorId), constructorName);
      return { ...result, pdfSent: true };
    } catch (e) {
      console.error("План збережено, але PDF не надіслано:", e.message);
      return { ...result, pdfSent: false };
    }
  })
);

app.post(
  "/api/plans/pdf",
  requireTelegramAuth,
  planRoute(async (req) => {
    const { month } = parseMonth(req.body?.month);
    const constructorId = parseConstructorId(req.body?.constructorId);
    const plan = await plans.getActivePlan(month, constructorId);
    if (!plan) throw new PlanError("План на цей місяць не зафіксовано.", 404);
    await sendPlanPdf(req.telegramUser, plan, await constructorNameFromPlan(constructorId));
    return { ok: true };
  })
);

/** Для вже зафіксованого плану конструктор міг зникнути з поточних задач: ім'я не критичне. */
async function constructorNameFromPlan(constructorId) {
  try {
    return await constructorNameOf(constructorId);
  } catch (e) {
    if (e instanceof PlanError) return "Конструктор";
    throw e;
  }
}

app.post(
  "/api/reconcile",
  requireTelegramAuth,
  planRoute((req) => {
    const { month } = parseMonth(req.body?.month);
    return plans.buildReconciliation(month, parseConstructorId(req.body?.constructorId));
  })
);

app.post(
  "/api/reconcile/export",
  requireTelegramAuth,
  planRoute(async (req) => {
    const { month } = parseMonth(req.body?.month);
    const constructorId = parseConstructorId(req.body?.constructorId);
    const format = req.body?.format;
    if (format !== "pdf" && format !== "xlsx") throw new PlanError("format має бути 'xlsx' або 'pdf'.");
    const data = await plans.buildReconciliation(month, constructorId);
    const constructorName = await constructorNameFromPlan(constructorId);
    const payload = reconciliationPayload(data, constructorName);
    const buffer = format === "pdf" ? await buildPdf(payload) : await buildXlsx(payload);
    await sendDocument(req.telegramUser.id, buffer, `Звірка ${constructorName} ${month}.${format}`, payload.periodLabel);
    return { ok: true };
  })
);

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Telegram report app listening on port ${PORT}`);
  });
}

module.exports = { app };
