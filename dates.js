"use strict";
/**
 * Дати у звітах — завжди за київським часом, незалежно від часового поясу
 * сервера (Render працює в UTC: задача, створена о 01:30 за Києвом, інакше
 * показувалась би попереднім днем і хибно рахувалась як "нова" / "не нова").
 */

const TZ = "Europe/Kyiv";

const partsFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** "2026-10-09" — календарна дата в Києві. */
function kyivDateStr(iso) {
  if (!iso) return "";
  // дата без часу ("2026-10-09") — вже календарна, не зсуваємо
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  return partsFmt.format(new Date(iso));
}

/** "09.10.2026" */
function formatDate(iso) {
  const s = kyivDateStr(iso);
  if (!s) return "";
  const [y, m, d] = s.split("-");
  return `${d}.${m}.${y}`;
}

/** "09.10.26" — для вузьких колонок PDF. */
function formatDateCompact(iso) {
  const s = kyivDateStr(iso);
  if (!s) return "";
  const [y, m, d] = s.split("-");
  return `${d}.${m}.${y.slice(2)}`;
}

module.exports = { TZ, kyivDateStr, formatDate, formatDateCompact };
