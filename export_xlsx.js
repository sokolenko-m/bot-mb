"use strict";
const ExcelJS = require("exceljs");

async function buildXlsx({ constructorName, periodLabel, tasks, totals }) {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Отчёт");

  sheet.mergeCells("A1:F1");
  sheet.getCell("A1").value = `Отчёт по загрузке: ${constructorName} — ${periodLabel}`;
  sheet.getCell("A1").font = { bold: true, size: 14 };

  sheet.addRow([]);
  const header = sheet.addRow(["Задача", "Начало", "Окончание (план)", "План, ч", "Факт, ч", "Статус"]);
  header.font = { bold: true };
  header.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE5E7EB" } };
  });

  for (const t of tasks) {
    sheet.addRow([
      t.title,
      formatDate(t.start),
      formatDate(t.end),
      t.plannedHours ?? "",
      t.factHours ?? "",
      t.done ? "Завершена" : "В работе",
    ]);
  }

  sheet.addRow([]);
  const totalRow = sheet.addRow(["Итого", "", "", totals.plannedHours, totals.factHours, `Задач: ${totals.count}`]);
  totalRow.font = { bold: true };

  sheet.columns = [{ width: 42 }, { width: 14 }, { width: 16 }, { width: 10 }, { width: 10 }, { width: 14 }];

  return wb.xlsx.writeBuffer();
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

module.exports = { buildXlsx };
