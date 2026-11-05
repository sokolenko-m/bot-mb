"use strict";
/** Місяць "РРРР-ММ": перевірка, межі, вікно фіксації. Дати — київські. */
const { kyivDateStr } = require("./dates");

/** Помилка, яку можна показати користувачу. */
class PlanError extends Error {
  constructor(message, httpStatus = 400) {
    super(message);
    this.httpStatus = httpStatus;
  }
}

function parseMonth(month) {
  if (typeof month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new PlanError("Місяць має бути у форматі РРРР-ММ.");
  }
  const [y, m] = month.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return { month, monthStart: `${month}-01`, monthEndExclusive: `${next}-01` };
}

function nextMonth(month) {
  return parseMonth(month).monthEndExclusive.slice(0, 7);
}

/** Фіксувати можна лише поточний і наступний місяць. */
function canFixMonth(month, today) {
  const current = today.slice(0, 7);
  return month === current || month === nextMonth(current);
}

function todayKyiv() {
  return kyivDateStr(new Date().toISOString());
}

/** "2027-01-01" → "2026-12-31": остання дата перед виключною межею. */
function lastDay(exclusive) {
  const d = new Date(`${exclusive}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

module.exports = { PlanError, parseMonth, nextMonth, canFixMonth, todayKyiv, lastDay };
