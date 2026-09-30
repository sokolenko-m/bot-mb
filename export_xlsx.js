"use strict";
const path = require("path");
const ExcelJS = require("exceljs");

const LOGO_PATH = path.join(__dirname, "assets", "logo.png");
const BRAND_RED = "FFC00000";
const HEADER_BG = "FF1A1A1A";
const NEW_TASK_BG = "FFFFF3CD";

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric" });
}

async function buildXlsx({ constructorName, periodLabel, tasks, totals }) {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Графік завантаженості");
  const hasOrigin = Boolean(totals.byOrigin);

  sheet.columns = [
    { width: 5 }, // №
    { width: 20 }, // Об'єкт
    { width: 38 }, // Найменування задачі
    { width: 16 }, // Тип задачі
    { width: 12 }, // Початок
    { width: 12 }, // Кінець
    { width: 10 }, // План, год
    { width: 14 }, // Статус
    { width: 12 }, // Факт, год
  ];

  // --- лого ---
  const imageId = wb.addImage({ filename: LOGO_PATH, extension: "png" });
  sheet.addImage(imageId, { tl: { col: 0, row: 0 }, ext: { width: 170, height: 67.4 } });
  sheet.getRow(1).height = 22;
  sheet.getRow(2).height = 22;
  sheet.getRow(3).height = 22;

  // --- заголовок ---
  sheet.mergeCells("B1:I1");
  const titleCell = sheet.getCell("B1");
  titleCell.value = "Графік завантаженості конструктора";
  titleCell.font = { bold: true, size: 16, color: { argb: "FF000000" } };
  titleCell.alignment = { vertical: "middle" };

  sheet.mergeCells("B2:I2");
  const nameCell = sheet.getCell("B2");
  nameCell.value = constructorName;
  nameCell.font = { bold: true, size: 13, color: { argb: BRAND_RED } };
  nameCell.alignment = { vertical: "middle" };

  sheet.mergeCells("B3:I3");
  const periodCell = sheet.getCell("B3");
  periodCell.value = `Період: ${periodLabel}`;
  periodCell.font = { size: 11, color: { argb: "FF555555" } };
  periodCell.alignment = { vertical: "middle" };

  sheet.addRow([]);

  if (hasOrigin) {
    const legendRow = sheet.addRow(["", "", "Жовтим — задачі, додані протягом місяця (не було в плані на початок періоду)"]);
    legendRow.getCell(3).font = { italic: true, size: 10, color: { argb: "FF806600" } };
    legendRow.getCell(3).fill = { type: "pattern", pattern: "solid", fgColor: { argb: NEW_TASK_BG } };
    sheet.addRow([]);
  }

  // --- шапка таблиці ---
  const headerRow = sheet.addRow(["№", "Об'єкт", "Найменування задачі", "Тип задачі", "Початок", "Кінець", "План, год", "Статус", "Факт, год"]);
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_BG } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = thinBorder();
  });
  headerRow.height = 26;

  // --- рядки задач ---
  const CENTER_COLS = new Set([1, 5, 6, 7, 9]);
  tasks.forEach((t) => {
    const row = sheet.addRow([
      Math.round((t.order ?? 0) * 10) / 10,
      t.objectName || "—",
      t.title,
      t.taskType || "",
      formatDate(t.start),
      formatDate(t.end),
      t.plannedHours || 0,
      t.status,
      t.factHours ?? "",
    ]);
    row.eachCell((cell, colNumber) => {
      cell.border = thinBorder();
      cell.alignment = { vertical: "middle", wrapText: colNumber === 3, horizontal: CENTER_COLS.has(colNumber) ? "center" : "left" };
      if (t.isNew) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NEW_TASK_BG } };
    });
    if (t.status === "Виконано") row.getCell(8).font = { color: { argb: "FF16A34A" } };
    else if (t.status === "В роботі") row.getCell(8).font = { color: { argb: BRAND_RED } };
  });

  // --- підсумок ---
  const totalRow = sheet.addRow(["", "", "Разом", "", "", "", totals.plannedHours, `Задач: ${totals.count}`, totals.factHours]);
  totalRow.eachCell((cell) => {
    cell.font = { bold: true };
    cell.border = thinBorder();
  });

  if (hasOrigin) {
    sheet.addRow([]);
    const o = totals.byOrigin;
    const rows = [
      ["Заплановано заздалегідь:", `${o.planned.count} задач`, `${o.planned.hours} год`],
      ["Додано протягом місяця:", `${o.added.count} задач`, `${o.added.hours} год`],
      ["Всього:", `${o.planned.count + o.added.count} задач`, `${o.totalHours} год`],
    ];
    for (const [label, count, hours] of rows) {
      const r = sheet.addRow(["", "", label, "", "", "", count, "", hours]);
      r.getCell(3).font = { bold: true };
      r.getCell(7).font = { bold: true };
      r.getCell(9).font = { bold: true };
    }
  }

  return wb.xlsx.writeBuffer();
}

function thinBorder() {
  const side = { style: "thin", color: { argb: "FFD0D0D0" } };
  return { top: side, left: side, bottom: side, right: side };
}

module.exports = { buildXlsx };
