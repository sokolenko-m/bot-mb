"use strict";
const PDFDocument = require("pdfkit");

function buildPdf({ constructorName, periodLabel, tasks, totals }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: "A4", layout: "landscape" });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(16).text(`Отчёт по загрузке: ${constructorName}`, { continued: false });
    doc.fontSize(11).fillColor("#555").text(periodLabel);
    doc.moveDown();

    const colX = [40, 340, 430, 530, 610, 690];
    const colW = [300, 90, 100, 80, 80, 90];
    const headers = ["Задача", "Начало", "Окончание (план)", "План, ч", "Факт, ч", "Статус"];

    doc.fillColor("#000").fontSize(10).font("Helvetica-Bold");
    headers.forEach((h, i) => doc.text(h, colX[i], doc.y, { width: colW[i] }));
    doc.moveDown(0.5);
    doc.font("Helvetica");

    for (const t of tasks) {
      const y = doc.y;
      if (y > 500) doc.addPage({ margin: 40, size: "A4", layout: "landscape" });
      const rowY = doc.y;
      doc.text(t.title, colX[0], rowY, { width: colW[0] });
      doc.text(formatDate(t.start), colX[1], rowY, { width: colW[1] });
      doc.text(formatDate(t.end), colX[2], rowY, { width: colW[2] });
      doc.text(String(t.plannedHours ?? ""), colX[3], rowY, { width: colW[3] });
      doc.text(String(t.factHours ?? ""), colX[4], rowY, { width: colW[4] });
      doc.text(t.done ? "Завершена" : "В работе", colX[5], rowY, { width: colW[5] });
      doc.moveDown(0.6);
    }

    doc.moveDown();
    doc.font("Helvetica-Bold").text(
      `Итого: план ${totals.plannedHours} ч, факт ${totals.factHours} ч, задач: ${totals.count}`
    );

    doc.end();
  });
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

module.exports = { buildPdf };
