"use strict";
const path = require("path");
const PDFDocument = require("pdfkit");

const LOGO_PATH = path.join(__dirname, "assets", "logo.png");
const FONT_REGULAR = path.join(__dirname, "assets", "fonts", "DejaVuSans.ttf");
const FONT_BOLD = path.join(__dirname, "assets", "fonts", "DejaVuSans-Bold.ttf");
const BRAND_RED = "#C00000";
const HEADER_BG = "#1A1A1A";
const BORDER = "#CCCCCC";

const MARGIN = 40;
const PAGE_OPTS = { margin: MARGIN, size: "A4", layout: "landscape" };

// [ключ, заголовок, ширина, вирівнювання]
const COLUMNS = [
  { key: "n", title: "№", width: 24, align: "center" },
  { key: "object", title: "Об'єкт", width: 108, align: "left" },
  { key: "title", title: "Найменування задачі", width: 258, align: "left" },
  { key: "start", title: "Початок", width: 58, align: "center" },
  { key: "end", title: "Кінець", width: 58, align: "center" },
  { key: "planned", title: "План, год", width: 58, align: "center" },
  { key: "status", title: "Статус", width: 78, align: "center" },
  { key: "fact", title: "Факт, год", width: 58, align: "center" },
];

function formatDateShort(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)}`;
}
const TABLE_WIDTH = COLUMNS.reduce((s, c) => s + c.width, 0);
const CELL_PAD = 5;
const ROW_MIN_HEIGHT = 20;

function buildPdf({ constructorName, periodLabel, tasks, totals }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument(PAGE_OPTS);
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // Стандартні шрифти pdfkit (Helvetica тощо) не мають кириличних гліфів —
    // без цього кирилиця/українські літери рендерились би "абракадаброю".
    doc.registerFont("UA", FONT_REGULAR);
    doc.registerFont("UA-Bold", FONT_BOLD);

    drawHeader(doc, constructorName, periodLabel);
    let y = drawTableHeader(doc, MARGIN + 78);

    for (const [i, t] of tasks.entries()) {
      const row = {
        n: String(i + 1),
        object: t.objectName || "—",
        title: t.title,
        start: formatDateShort(t.start),
        end: formatDateShort(t.end),
        planned: String(t.plannedHours ?? ""),
        status: t.status,
        fact: t.factHours === null || t.factHours === undefined ? "" : String(t.factHours),
      };
      const rowHeight = computeRowHeight(doc, row);

      if (y + rowHeight > doc.page.height - MARGIN) {
        doc.addPage(PAGE_OPTS);
        y = drawTableHeader(doc, MARGIN);
      }
      drawRow(doc, row, y, rowHeight, t.status);
      y += rowHeight;
    }

    // --- підсумковий рядок ---
    const totalRow = {
      n: "",
      object: "",
      title: "Разом",
      start: "",
      end: "",
      planned: String(totals.plannedHours),
      status: `Задач: ${totals.count}`,
      fact: String(totals.factHours),
    };
    const totalHeight = computeRowHeight(doc, totalRow);
    if (y + totalHeight > doc.page.height - MARGIN) {
      doc.addPage(PAGE_OPTS);
      y = drawTableHeader(doc, MARGIN);
    }
    drawRow(doc, totalRow, y, totalHeight, null, true);

    doc.end();
  });
}

function drawHeader(doc, constructorName, periodLabel) {
  try {
    doc.image(LOGO_PATH, MARGIN, MARGIN, { width: 130 });
  } catch {
    /* лого не знайдено — продовжуємо без нього */
  }

  const textX = MARGIN + 150;
  doc.font("UA-Bold").fontSize(18).fillColor("#000000").text("Графік завантаженості конструктора", textX, MARGIN, {
    width: TABLE_WIDTH - 150,
  });
  doc.font("UA-Bold").fontSize(13).fillColor(BRAND_RED).text(constructorName, textX, doc.y + 4, {
    width: TABLE_WIDTH - 150,
  });
  doc.font("UA").fontSize(10.5).fillColor("#555555").text(`Період: ${periodLabel}`, textX, doc.y + 4);
}

function drawTableHeader(doc, y) {
  doc.font("UA-Bold").fontSize(9);
  let maxLines = 1;
  for (const col of COLUMNS) {
    const h = doc.heightOfString(col.title, { width: col.width - 2 * CELL_PAD });
    maxLines = Math.max(maxLines, Math.ceil(h / 11));
  }
  const height = Math.max(ROW_MIN_HEIGHT, maxLines * 11 + 2 * CELL_PAD);

  let x = MARGIN;
  doc.rect(MARGIN, y, TABLE_WIDTH, height).fill(HEADER_BG);
  doc.fillColor("#FFFFFF");
  for (const col of COLUMNS) {
    doc.text(col.title, x + CELL_PAD, y + CELL_PAD, { width: col.width - 2 * CELL_PAD, align: col.align });
    x += col.width;
  }
  return y + height;
}

function computeRowHeight(doc, row) {
  doc.font("UA").fontSize(9);
  let maxLines = 1;
  for (const col of COLUMNS) {
    const text = String(row[col.key] ?? "");
    const h = doc.heightOfString(text, { width: col.width - 2 * CELL_PAD });
    maxLines = Math.max(maxLines, Math.ceil(h / 11));
  }
  return Math.max(ROW_MIN_HEIGHT, maxLines * 11 + 2 * CELL_PAD);
}

function drawRow(doc, row, y, height, status, isTotal = false) {
  let x = MARGIN;
  if (isTotal) {
    doc.rect(MARGIN, y, TABLE_WIDTH, height).fill("#F2F2F2");
  }
  doc.font(isTotal ? "UA-Bold" : "UA").fontSize(9);

  for (const col of COLUMNS) {
    doc.rect(x, y, col.width, height).stroke(BORDER);
    let color = "#000000";
    if (col.key === "status" && status === "Виконано") color = "#16A34A";
    else if (col.key === "status" && status === "В роботі") color = BRAND_RED;
    doc.fillColor(color).text(String(row[col.key] ?? ""), x + CELL_PAD, y + CELL_PAD, {
      width: col.width - 2 * CELL_PAD,
      align: col.align,
    });
    x += col.width;
  }
}

module.exports = { buildPdf };
