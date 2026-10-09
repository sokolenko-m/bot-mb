"use strict";
const path = require("path");
const PDFDocument = require("pdfkit");
const { formatDateCompact: formatDateShort } = require("./dates");

const LOGO_PATH = path.join(__dirname, "assets", "logo.png");
const FONT_REGULAR = path.join(__dirname, "assets", "fonts", "DejaVuSans.ttf");
const FONT_BOLD = path.join(__dirname, "assets", "fonts", "DejaVuSans-Bold.ttf");
const BRAND_RED = "#C00000";
const HEADER_BG = "#1A1A1A";
const BORDER = "#CCCCCC";
const NEW_TASK_BG = "#FFF3CD";
const ABSENCE_BG = "#EDEDED";
const ABSENCE_TEXT = "#8B8886";
const PAUSED_TEXT = "#B45309";

const MARGIN = 40;
const PAGE_OPTS = { margin: MARGIN, size: "A4", layout: "landscape" };

// [ключ, заголовок, ширина, вирівнювання]
const COLUMNS = [
  { key: "n", title: "№", width: 32, align: "center" },
  { key: "object", title: "Об'єкт", width: 90, align: "left" },
  { key: "title", title: "Найменування задачі", width: 182, align: "left" },
  { key: "type", title: "Тип задачі", width: 72, align: "left" },
  { key: "added", title: "Додано", width: 56, align: "center" },
  { key: "start", title: "Початок", width: 56, align: "center" },
  { key: "end", title: "Кінець", width: 52, align: "center" },
  { key: "planned", title: "План, год", width: 48, align: "center" },
  { key: "status", title: "Статус", width: 74, align: "center" },
  { key: "fact", title: "Факт, год", width: 48, align: "center" },
];

function formatOrder(order) {
  if (order === null || order === undefined) return "";
  return String(Math.round(order * 10) / 10);
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

    const hasOrigin = Boolean(totals.byOrigin);
    const hasAbsence = Boolean(totals.absence);

    // Стандартні шрифти pdfkit (Helvetica тощо) не мають кириличних гліфів —
    // без цього кирилиця/українські літери рендерились би "абракадаброю".
    doc.registerFont("UA", FONT_REGULAR);
    doc.registerFont("UA-Bold", FONT_BOLD);

    let headerHeight = drawHeader(doc, constructorName, periodLabel, hasOrigin, hasAbsence);
    let y = drawTableHeader(doc, MARGIN + headerHeight);

    for (const t of tasks) {
      const row = {
        n: formatOrder(t.order),
        object: t.objectName || "—",
        title: t.title,
        type: t.taskType || "",
        added: formatDateShort(t.originCreatedTime || t.createdTime),
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
      drawRow(doc, row, y, rowHeight, t.status, { isNew: t.isNew, isAbsence: t.isAbsence });
      y += rowHeight;
    }

    // --- підсумковий рядок ---
    const totalRow = {
      n: "",
      object: "",
      title: "Разом",
      type: "",
      added: "",
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
    drawRow(doc, totalRow, y, totalHeight, null, { isTotal: true });
    y += totalHeight;

    if (hasAbsence) {
      const absenceRow = {
        ...totalRow,
        title: "Відсутність (відпустка тощо)",
        planned: String(totals.absence.hours),
        status: `Записів: ${totals.absence.count}`,
        fact: "",
      };
      const h = computeRowHeight(doc, absenceRow);
      if (y + h > doc.page.height - MARGIN) {
        doc.addPage(PAGE_OPTS);
        y = drawTableHeader(doc, MARGIN);
      }
      drawRow(doc, absenceRow, y, h, null, { isAbsence: true });
      y += h;
    }

    if (hasOrigin) {
      y += 10;
      if (y + 70 > doc.page.height - MARGIN) {
        doc.addPage(PAGE_OPTS);
        y = MARGIN;
      }
      const o = totals.byOrigin;
      doc.font("UA-Bold").fontSize(10).fillColor("#000000");
      doc.text(`Заплановано заздалегідь: ${o.planned.count} задач, ${o.planned.hours} год`, MARGIN, y);
      y = doc.y + 2;
      doc.fillColor(BRAND_RED).text(`Додано протягом місяця: ${o.added.count} задач, ${o.added.hours} год`, MARGIN, y);
      y = doc.y + 2;
      doc.fillColor("#000000").text(`Всього: ${o.planned.count + o.added.count} задач, ${o.totalHours} год`, MARGIN, y);
    }

    doc.end();
  });
}

function drawHeader(doc, constructorName, periodLabel, hasOrigin, hasAbsence) {
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

  if (hasOrigin) {
    const legendY = doc.y + 6;
    doc.rect(textX, legendY, 12, 12).fill(NEW_TASK_BG);
    doc
      .font("UA")
      .fontSize(9)
      .fillColor("#806600")
      .text("— задачі, додані протягом місяця (не було в плані на початок періоду)", textX + 16, legendY + 1);
  }
  if (hasAbsence) {
    const legendY = doc.y + 4;
    doc.rect(textX, legendY, 12, 12).fill(ABSENCE_BG);
    doc
      .font("UA")
      .fontSize(9)
      .fillColor(ABSENCE_TEXT)
      .text("— відпустка / відсутність (не входить у підсумки годин)", textX + 16, legendY + 1);
  }

  return Math.max(78, doc.y - MARGIN + 8);
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

function drawRow(doc, row, y, height, status, { isTotal = false, isNew = false, isAbsence = false } = {}) {
  let x = MARGIN;
  if (isTotal) {
    doc.rect(MARGIN, y, TABLE_WIDTH, height).fill("#F2F2F2");
  } else if (isAbsence) {
    doc.rect(MARGIN, y, TABLE_WIDTH, height).fill(ABSENCE_BG);
  } else if (isNew) {
    doc.rect(MARGIN, y, TABLE_WIDTH, height).fill(NEW_TASK_BG);
  }
  doc.font(isTotal ? "UA-Bold" : "UA").fontSize(9);

  for (const col of COLUMNS) {
    doc.rect(x, y, col.width, height).stroke(BORDER);
    let color = isAbsence ? ABSENCE_TEXT : "#000000";
    if (col.key === "status" && status === "Виконано") color = "#16A34A";
    else if (col.key === "status" && status === "В роботі") color = BRAND_RED;
    else if (col.key === "status" && status === "На паузі") color = PAUSED_TEXT;
    doc.fillColor(color).text(String(row[col.key] ?? ""), x + CELL_PAD, y + CELL_PAD, {
      width: col.width - 2 * CELL_PAD,
      align: col.align,
    });
    x += col.width;
  }
}

module.exports = { buildPdf };
