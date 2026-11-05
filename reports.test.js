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
const { buildPdf, COLUMNS, PAGE_OPTS, MARGIN, FONT_BOLD, FONT_REGULAR } = require("./export_pdf");

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
  assert.ok(!done.getCell(3).alignment.wrapText);
  const added = findRow(rows, "Задача без номера");
  assert.equal(added.getCell(10).font.color.argb, "FFC00000");
  assert.equal(added.getCell(4).fill.fgColor.argb, "FFFFF3CD");
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
