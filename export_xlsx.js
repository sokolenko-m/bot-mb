"use strict";
const path = require("path");
const ExcelJS = require("exceljs");
const { formatDate } = require("./dates");

const LOGO_PATH = path.join(__dirname, "assets", "logo.png");
const BRAND_RED = "FFC00000";
const HEADER_BG = "FF1A1A1A";
const NEW_TASK_BG = "FFFFF3CD";
const ABSENCE_BG = "FFEDEDED";
const ABSENCE_TEXT = "FF8B8886";
const PAUSED_TEXT = "FFB45309";

async function buildXlsx({ constructorName, periodLabel, tasks, totals }) {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Графік завантаженості");
  const hasOrigin = Boolean(totals.byOrigin);
  const hasAbsence = Boolean(totals.absence);

  // 1:№ задачі 2:Порядок 3:Об'єкт 4:Найменування задачі 5:Тип задачі 6:Додано 7:Початок 8:Кінець 9:План, год 10:Статус 11:Факт, год
  sheet.columns = [
    { width: 10 },
    { width: 10 },
    { width: 20 },
    { width: 38 },
    { width: 16 },
    { width: 12 },
    { width: 12 },
    { width: 12 },
    { width: 10 },
    { width: 14 },
    { width: 12 },
  ];

  // --- лого ---
  const imageId = wb.addImage({ filename: LOGO_PATH, extension: "png" });
  sheet.addImage(imageId, { tl: { col: 0, row: 0 }, ext: { width: 170, height: 67.4 } });
  sheet.getRow(1).height = 22;
  sheet.getRow(2).height = 22;
  sheet.getRow(3).height = 22;

  // --- заголовок ---
  sheet.mergeCells("C1:K1");
  const titleCell = sheet.getCell("C1");
  titleCell.value = "Графік завантаженості конструктора";
  titleCell.font = { bold: true, size: 16, color: { argb: "FF000000" } };
  titleCell.alignment = { vertical: "middle", indent: 1 };

  sheet.mergeCells("C2:K2");
  const nameCell = sheet.getCell("C2");
  nameCell.value = constructorName;
  nameCell.font = { bold: true, size: 13, color: { argb: BRAND_RED } };
  nameCell.alignment = { vertical: "middle", indent: 1 };

  sheet.mergeCells("C3:K3");
  const periodCell = sheet.getCell("C3");
  periodCell.value = `Період: ${periodLabel}`;
  periodCell.font = { size: 11, color: { argb: "FF555555" } };
  periodCell.alignment = { vertical: "middle", indent: 1 };

  sheet.addRow([]);

  if (hasOrigin) {
    const legendRow = sheet.addRow(["", "", "", "Жовтим — задачі, додані протягом місяця (не було в плані на початок періоду)"]);
    legendRow.getCell(4).font = { italic: true, size: 10, color: { argb: "FF806600" } };
    legendRow.getCell(4).fill = { type: "pattern", pattern: "solid", fgColor: { argb: NEW_TASK_BG } };
  }
  if (hasAbsence) {
    const legendRow = sheet.addRow(["", "", "", "Сірим — відпустка / відсутність (не входить у підсумки годин)"]);
    legendRow.getCell(4).font = { italic: true, size: 10, color: { argb: ABSENCE_TEXT } };
    legendRow.getCell(4).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ABSENCE_BG } };
  }
  if (hasOrigin || hasAbsence) sheet.addRow([]);

  // --- шапка таблиці ---
  const headerRow = sheet.addRow(["№ задачі", "Порядок", "Об'єкт", "Найменування задачі", "Тип задачі", "Додано", "Початок", "Кінець", "План, год", "Статус", "Факт, год"]);
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_BG } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = thinBorder();
  });
  headerRow.height = 26;

  // --- рядки задач ---
  const CENTER_COLS = new Set([1, 2, 6, 7, 8, 9, 11]);
  const WRAP_COLS = new Set([3, 4, 5]); // Об'єкт, Найменування задачі, Тип задачі
  tasks.forEach((t) => {
    const row = sheet.addRow([
      t.taskNumber || "",
      Math.round((t.order ?? 0) * 100) / 100,
      t.objectName || "—",
      t.title,
      t.taskType || "",
      formatDate(t.originCreatedTime || t.createdTime),
      formatDate(t.start),
      formatDate(t.end),
      t.plannedHours || 0,
      t.status,
      t.factHours ?? "",
    ]);
    row.eachCell((cell, colNumber) => {
      cell.border = thinBorder();
      cell.alignment = { vertical: "middle", wrapText: WRAP_COLS.has(colNumber), horizontal: CENTER_COLS.has(colNumber) ? "center" : "left" };
      if (t.isAbsence) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ABSENCE_BG } };
        cell.font = { color: { argb: ABSENCE_TEXT } };
      } else if (t.isNew) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NEW_TASK_BG } };
      }
    });
    if (t.status === "Виконано") row.getCell(10).font = { color: { argb: "FF16A34A" } };
    else if (t.status === "В роботі") row.getCell(10).font = { color: { argb: BRAND_RED } };
    else if (t.status === "На паузі") row.getCell(10).font = { color: { argb: PAUSED_TEXT } };
  });

  // --- підсумок (без відпусток) ---
  const totalRow = sheet.addRow(["", "", "", "Разом", "", "", "", "", totals.plannedHours, `Задач: ${totals.count}`, totals.factHours]);
  totalRow.eachCell((cell) => {
    cell.font = { bold: true };
    cell.border = thinBorder();
  });
  if (hasAbsence) {
    const r = sheet.addRow(["", "", "", "Відсутність (відпустка тощо)", "", "", "", "", totals.absence.hours, `Записів: ${totals.absence.count}`, ""]);
    r.eachCell((cell) => {
      cell.font = { color: { argb: ABSENCE_TEXT } };
      cell.border = thinBorder();
    });
  }

  if (hasOrigin) {
    sheet.addRow([]);
    const o = totals.byOrigin;
    const rows = [
      ["Заплановано заздалегідь:", `${o.planned.count} задач`, `${o.planned.hours} год`],
      ["Додано протягом місяця:", `${o.added.count} задач`, `${o.added.hours} год`],
      ["Всього:", `${o.planned.count + o.added.count} задач`, `${o.totalHours} год`],
    ];
    for (const [label, count, hours] of rows) {
      const r = sheet.addRow(["", "", "", label, "", "", "", "", count, "", hours]);
      r.getCell(4).font = { bold: true };
      r.getCell(9).font = { bold: true };
      r.getCell(11).font = { bold: true };
    }
  }

  return wb.xlsx.writeBuffer();
}

function thinBorder() {
  const side = { style: "thin", color: { argb: "FFD0D0D0" } };
  return { top: side, left: side, bottom: side, right: side };
}

module.exports = { buildXlsx };
