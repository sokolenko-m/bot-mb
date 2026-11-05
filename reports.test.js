"use strict";
/**
 * Колонка «№ задачі» (постійний номер KV-…) у звітах: читання з Notion, Excel, PDF.
 * Мережі немає: Notion підмінено через global.fetch.
 * Запуск: npm test
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");

process.env.NOTION_TOKEN = "test";
process.env.NOTION_DATA_SOURCE_ID = "ds-test";

const notion = require("./notion");
const { buildXlsx } = require("./export_xlsx");
const { reconciliationPayload, planPayload } = require("./plan_payloads");
const { buildPdf, formatOrder, COLUMNS, PAGE_OPTS, MARGIN, FONT_BOLD, FONT_REGULAR } = require("./export_pdf");

const SCHEMA_PROPS = {
  название: { type: "title" },
  Конструктор: { type: "people" },
  Порядок: { type: "number" },
  "Трудозатраты, часы": { type: "number" },
  Начало: { type: "date" },
  Конец: { type: "date" },
  "Виконання %": { type: "number" },
  "Факт. завершення": { type: "date" },
  "Факт. трудозатраты, часы": { type: "number" },
  "🏗️ Об`єкт": { type: "relation" },
};

function notionPage(extraProps) {
  return {
    id: "page-1",
    created_time: "2026-10-01T08:00:00.000Z",
    properties: {
      название: { title: [{ plain_text: "Задача" }] },
      Конструктор: { people: [{ id: "u1", name: "Тест" }] },
      Порядок: { type: "number", number: 134.6 },
      "Трудозатраты, часы": { number: 8 },
      Начало: { date: { start: "2026-10-05" } },
      Конец: { date: { start: "2026-10-06" } },
      "Виконання %": { number: 0 },
      "Факт. завершення": { date: null },
      "Факт. трудозатраты, часы": { number: null },
      "🏗️ Об`єкт": { relation: [] },
      ...extraProps,
    },
  };
}

function mockNotion(page) {
  const original = global.fetch;
  global.fetch = async (url) => {
    const body = String(url).endsWith("/query") ? { results: [page], has_more: false } : { properties: SCHEMA_PROPS };
    return { ok: true, json: async () => body };
  };
  return () => {
    global.fetch = original;
  };
}

function sampleReport(overrides = {}) {
  return {
    constructorName: "Тест Конструктор",
    periodLabel: "01.10.2026–31.10.2026",
    tasks: [
      {
        taskNumber: "KV-420",
        order: 134.6,
        objectName: "Об'єкт А",
        title: "Плановa задача",
        taskType: "КМД",
        createdTime: "2026-09-20T08:00:00.000Z",
        start: "2026-10-05",
        end: "2026-10-06",
        plannedHours: 8,
        status: "Виконано",
        factHours: 7,
      },
      {
        taskNumber: "",
        order: 2,
        objectName: "Об'єкт Б",
        title: "Задача без номера",
        taskType: "",
        createdTime: "2026-10-02T08:00:00.000Z",
        start: "2026-10-07",
        end: "2026-10-08",
        plannedHours: 4,
        status: "В роботі",
        factHours: null,
        isNew: true,
      },
      {
        taskNumber: "KV-500",
        order: 3,
        title: "Відпустка",
        createdTime: "2026-09-20T08:00:00.000Z",
        start: "2026-10-09",
        end: "2026-10-10",
        plannedHours: 16,
        status: "Відсутність",
        factHours: null,
        isAbsence: true,
      },
    ],
    totals: {
      plannedHours: 12,
      factHours: 7,
      count: 2,
      absence: { count: 1, hours: 16 },
      byOrigin: { planned: { count: 1, hours: 7 }, added: { count: 1, hours: 4 }, totalHours: 11 },
    },
    ...overrides,
  };
}

async function loadSheet(report) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await buildXlsx(report));
  const sheet = wb.worksheets[0];
  const rows = [];
  sheet.eachRow((row) => rows.push(row));
  return { sheet, rows };
}

const findRow = (rows, text) => rows.find((r) => r.values.includes(text));

test("Notion: номер задачі читається з поля «№ задачі» як KV-420", async () => {
  const restore = mockNotion(notionPage({ "№ задачі": { type: "unique_id", unique_id: { prefix: "KV", number: 420 } } }));
  try {
    const [task] = await notion.getTasksForReport("u1", { startDateStr: "2026-10-01", endDateStr: "2026-11-01" });
    assert.equal(task.taskNumber, "KV-420");
    assert.equal(task.order, 134.6, "«Порядок» лишається окремо");
  } finally {
    restore();
  }
});

test("Notion: номер без префікса — просто число", async () => {
  const restore = mockNotion(notionPage({ "№ задачі": { type: "unique_id", unique_id: { prefix: null, number: 7 } } }));
  try {
    const [task] = await notion.getTasksForReport("u1", { startDateStr: "2026-10-01", endDateStr: "2026-11-01" });
    assert.equal(task.taskNumber, "7");
  } finally {
    restore();
  }
});

test("Notion: якщо поля немає, звіт формується, номер порожній", async () => {
  const restore = mockNotion(notionPage({}));
  try {
    const [task] = await notion.getTasksForReport("u1", { startDateStr: "2026-10-01", endDateStr: "2026-11-01" });
    assert.equal(task.taskNumber, "");
    assert.equal(task.order, 134.6);
  } finally {
    restore();
  }
});

test("Excel: шапка починається з «№ задачі» і «Порядок», решта колонок на місці", async () => {
  const { rows } = await loadSheet(sampleReport());
  const header = findRow(rows, "№ задачі");
  assert.ok(header, "немає шапки з «№ задачі»");
  assert.deepEqual(header.values.slice(1), [
    "№ задачі",
    "Порядок",
    "Об'єкт",
    "Найменування задачі",
    "Тип задачі",
    "Додано",
    "Початок",
    "Кінець",
    "План, год",
    "Статус",
    "Факт, год",
  ]);
});

test("Excel: у рядку задачі номер і порядок у своїх колонках", async () => {
  const { rows } = await loadSheet(sampleReport());
  const row = findRow(rows, "Плановa задача");
  assert.equal(row.getCell(1).value, "KV-420");
  assert.equal(row.getCell(2).value, 134.6);
  assert.equal(row.getCell(3).value, "Об'єкт А");
  assert.equal(row.getCell(4).value, "Плановa задача");
  assert.equal(row.getCell(9).value, 8);
  assert.equal(row.getCell(10).value, "Виконано");
  assert.equal(row.getCell(11).value, 7);
});

test("Excel: задача без номера не ламає рядок", async () => {
  const { rows } = await loadSheet(sampleReport());
  const row = findRow(rows, "Задача без номера");
  assert.ok(!row.getCell(1).value, "номер порожній");
  assert.equal(row.getCell(2).value, 2);
  assert.equal(row.getCell(10).value, "В роботі");
});

test("Excel: колір статусу, перенос назви і заливка нових задач зсунуті разом з колонками", async () => {
  const { rows } = await loadSheet(sampleReport());
  const done = findRow(rows, "Плановa задача");
  assert.equal(done.getCell(10).font.color.argb, "FF16A34A");
  assert.equal(done.getCell(4).alignment.wrapText, true);
  const added = findRow(rows, "Задача без номера");
  assert.equal(added.getCell(10).font.color.argb, "FFC00000");
  assert.equal(added.getCell(4).fill.fgColor.argb, "FFFFF3CD");
});

test("Excel: довгі «Об'єкт» і «Тип задачі» переносяться, а не обрізаються", async () => {
  const { rows } = await loadSheet(sampleReport());
  const row = findRow(rows, "Плановa задача");
  assert.equal(row.getCell(3).alignment.wrapText, true, "Об'єкт");
  assert.equal(row.getCell(5).alignment.wrapText, true, "Тип задачі");
  assert.ok(!row.getCell(1).alignment.wrapText, "номер не переноситься");
});

test("Порядок не втрачає другий знак: 134.4 і 134.42 — різні значення", async () => {
  const report = sampleReport();
  report.tasks[0].order = 134.42;
  const { rows } = await loadSheet(report);
  assert.equal(findRow(rows, "Плановa задача").getCell(2).value, 134.42, "Excel");
  assert.equal(formatOrder(134.42), "134.42", "PDF");
  assert.equal(formatOrder(134.4), "134.4", "PDF без зайвого нуля");
  assert.equal(formatOrder(134), "134", "PDF ціле");
});

function sampleReconciliation() {
  return {
    month: "2026-12",
    monthLabel: "01.12.2026–31.12.2026",
    asOf: "2026-12-15",
    plan: { version: 2, fixedAt: "2026-12-12T10:00:00.000Z", note: "" },
    rows: [
      {
        taskNumber: "KV-1",
        order: 1,
        title: "Нова назва",
        plannedTitle: "Стара назва",
        objectName: "Об'єкт А",
        taskType: "КМД",
        createdTime: "2026-11-20T08:00:00.000Z",
        start: "2026-12-07",
        end: "2026-12-08",
        plannedHours: 8,
        factHours: 7,
        hours: 7,
        status: "Виконано",
        isDone: true,
        isNew: false,
        isDeleted: false,
        isAbsence: false,
      },
      {
        taskNumber: "KV-2",
        order: 2,
        title: "Видалена",
        plannedTitle: null,
        objectName: "Об'єкт Б",
        taskType: "",
        createdTime: null,
        start: "2026-12-09",
        end: "2026-12-09",
        plannedHours: 4,
        factHours: null,
        hours: 0,
        status: "Видалена",
        isDone: false,
        isNew: false,
        isDeleted: true,
        isAbsence: false,
      },
      {
        taskNumber: "KV-3",
        order: 3,
        title: "Позапланова",
        plannedTitle: null,
        objectName: "Об'єкт В",
        taskType: "",
        createdTime: "2026-12-10T08:00:00.000Z",
        start: "2026-12-10",
        end: "2026-12-10",
        plannedHours: 2,
        factHours: 3,
        hours: 3,
        status: "В роботі",
        isDone: false,
        isNew: true,
        isDeleted: false,
        isAbsence: false,
      },
    ],
    totals: {
      planned: { count: 2, hours: 12 },
      done: { count: 1, hours: 7 },
      added: { count: 1, hours: 3 },
      absence: { count: 0, hours: 0 },
    },
  };
}

test("звірка в Excel: заголовок, версія плану, назва в плані, три рядки підсумку", async () => {
  const { sheet, rows } = await loadSheet(reconciliationPayload(sampleReconciliation(), "Тест Конструктор"));
  assert.equal(sheet.getCell("C1").value, "Звірка плану з фактом");
  const period = sheet.getCell("C3").value;
  assert.match(period, /версія 2/);
  assert.match(period, /12\.12\.2026/);
  assert.match(period, /станом на 15\.12\.2026/);

  assert.ok(findRow(rows, "Нова назва (у плані: Стара назва)"), "перейменована");
  assert.ok(!findRow(rows, "Разом"), "у звірці лише три підсумкові рядки");

  const line = (label) => findRow(rows, label);
  assert.equal(line("Заплановано на місяць:").getCell(9).value, "2 задач");
  assert.equal(line("Заплановано на місяць:").getCell(11).value, "12 год");
  assert.equal(line("Виконано із запланованих:").getCell(9).value, "1 задач");
  assert.equal(line("Виконано із запланованих:").getCell(11).value, "7 год");
  assert.equal(line("Нових задач додано протягом місяця:").getCell(9).value, "1 задач");
  assert.equal(line("Нових задач додано протягом місяця:").getCell(11).value, "3 год");

  assert.equal(findRow(rows, "Видалена").getCell(4).fill.fgColor.argb, "FFEDEDED", "видалена сіра");
  assert.equal(findRow(rows, "Позапланова").getCell(4).fill.fgColor.argb, "FFFFF3CD", "нова жовта");
});

test("звірка: пов'язана легенда каже правду про сірі рядки", async () => {
  const { rows } = await loadSheet(reconciliationPayload(sampleReconciliation(), "Тест"));
  const legend = rows.find((r) => String(r.getCell(4).value || "").startsWith("Сірим"));
  assert.match(legend.getCell(4).value, /видалені/);
});

test("звірка в PDF будується", async () => {
  const pdf = await buildPdf(reconciliationPayload(sampleReconciliation(), "Тест"));
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
});

test("підсумок після місяця без «станом на», примітка про копію показується", async () => {
  const data = { ...sampleReconciliation(), asOf: null };
  data.plan = { ...data.plan, note: "Відновлено з резервної копії 30.10" };
  const payload = reconciliationPayload(data, "Тест");
  assert.doesNotMatch(payload.periodLabel, /станом/);
  assert.match(payload.periodLabel, /Відновлено з резервної копії 30\.10/);
});

test("PDF плану: збережені дані, статус «Заплановано», без жовтих", async () => {
  const payload = planPayload(
    {
      month: "2026-12",
      version: 1,
      fixedAt: "2026-11-30T10:00:00.000Z",
      note: "",
      tasks: [
        { pageId: "1", taskNumber: "KV-1", title: "Робота", objectName: "О", taskType: "", order: 1, plannedHours: 8, start: "2026-12-07", end: "2026-12-07", createdTime: "2026-12-05T08:00:00.000Z", isAbsence: false },
        { pageId: "2", taskNumber: "KV-2", title: "Відпустка", objectName: "—", taskType: "", order: 2, plannedHours: 16, start: "2026-12-08", end: "2026-12-09", createdTime: null, isAbsence: true },
      ],
    },
    "Тест"
  );
  assert.equal(payload.tasks[0].status, "Заплановано");
  assert.equal(payload.tasks[0].isNew, false);
  assert.equal(payload.tasks[1].status, "Відсутність");
  assert.deepEqual(payload.totals.absence, { count: 1, hours: 16 });
  assert.equal(payload.totals.plannedHours, 8);
  assert.equal(payload.totals.count, 1);
  assert.match(payload.periodLabel, /План, версія 1/);
  assert.equal((await buildPdf(payload)).subarray(0, 5).toString(), "%PDF-");
  const { rows } = await loadSheet(payload);
  assert.ok(findRow(rows, "Разом"), "план має звичайний підсумок");
});

test("Excel: підсумки і легенда у правильних колонках", async () => {
  const { rows } = await loadSheet(sampleReport());
  const total = findRow(rows, "Разом");
  assert.equal(total.getCell(4).value, "Разом");
  assert.equal(total.getCell(9).value, 12);
  assert.equal(total.getCell(10).value, "Задач: 2");
  assert.equal(total.getCell(11).value, 7);

  const absence = findRow(rows, "Відсутність (відпустка тощо)");
  assert.equal(absence.getCell(9).value, 16);
  assert.equal(absence.getCell(10).value, "Записів: 1");

  const planned = findRow(rows, "Заплановано заздалегідь:");
  assert.equal(planned.getCell(4).value, "Заплановано заздалегідь:");
  assert.equal(planned.getCell(9).value, "1 задач");
  assert.equal(planned.getCell(11).value, "7 год");

  const legend = rows.find((r) => String(r.getCell(4).value || "").startsWith("Жовтим"));
  assert.ok(legend, "легенда не в колонці назви");
});

test("Excel: шапка звіту тягнеться до останньої колонки", async () => {
  const { sheet } = await loadSheet(sampleReport());
  const merged = sheet.model.merges;
  assert.ok(merged.every((m) => m.endsWith(`K${m.match(/\d+$/)[0]}`)), `очікується злиття до K: ${merged}`);
});

test("PDF: перші колонки — № задачі і Порядок, таблиця вміщується на аркуш", () => {
  assert.deepEqual(COLUMNS.slice(0, 2).map((c) => c.title), ["№ задачі", "Порядок"]);
  const doc = new PDFDocument(PAGE_OPTS);
  const usable = doc.page.width - 2 * MARGIN;
  const width = COLUMNS.reduce((s, c) => s + c.width, 0);
  assert.ok(width <= usable, `таблиця ${width} ширша за аркуш ${usable}`);
  doc.end();
});

test("PDF: номер і заголовок «Порядок» не переносяться всередині слова", () => {
  const doc = new PDFDocument(PAGE_OPTS);
  doc.registerFont("UA", FONT_REGULAR);
  doc.registerFont("UA-Bold", FONT_BOLD);
  const PAD = 10;
  const [numberCol, orderCol] = COLUMNS;
  doc.font("UA").fontSize(9);
  assert.ok(doc.widthOfString("KV-1000") <= numberCol.width - PAD, "KV-1000 не вміщується");
  doc.font("UA-Bold").fontSize(9);
  assert.ok(doc.widthOfString("задачі") <= numberCol.width - PAD, "«задачі» не вміщується");
  assert.ok(doc.widthOfString("Порядок") <= orderCol.width - PAD, "«Порядок» не вміщується");
  doc.end();
});

test("PDF: файл будується і з номером, і без нього", async () => {
  const pdf = await buildPdf(sampleReport());
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
});
