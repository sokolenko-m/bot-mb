"use strict";
/** Перетворює збережений план і звірку на дані для export_pdf.js та export_xlsx.js. */
const { ABSENCE_STATUS } = require("./report");
const { parseMonth, lastDay } = require("./month");
const { formatDate } = require("./dates");

const PLANNED_STATUS = "Заплановано";

function round2(n) {
  return Math.round(n * 100) / 100;
}

function monthRange(month) {
  const { monthStart, monthEndExclusive } = parseMonth(month);
  return `${formatDate(monthStart)}–${formatDate(lastDay(monthEndExclusive))}`;
}

/** PDF/Excel зафіксованого плану: лише збережені дані, поточні задачі сюди не потрапляють. */
function planPayload(plan, constructorName) {
  const tasks = plan.tasks.map((t) => ({
    ...t,
    status: t.isAbsence ? ABSENCE_STATUS : PLANNED_STATUS,
    factHours: null,
    isNew: false,
  }));
  const work = tasks.filter((t) => !t.isAbsence);
  const absence = tasks.filter((t) => t.isAbsence);
  const totals = {
    plannedHours: round2(work.reduce((s, t) => s + (t.plannedHours || 0), 0)),
    factHours: 0,
    count: work.length,
  };
  if (absence.length) {
    totals.absence = { count: absence.length, hours: round2(absence.reduce((s, t) => s + (t.plannedHours || 0), 0)) };
  }
  const parts = [monthRange(plan.month), `План, версія ${plan.version}`, `зафіксовано ${formatDate(plan.fixedAt)}`];
  if (plan.note) parts.push(plan.note);
  return { constructorName, periodLabel: parts.join(" · "), tasks, totals };
}

function titleWithPlanned(row) {
  return row.plannedTitle ? `${row.title} (у плані: ${row.plannedTitle})` : row.title;
}

/** PDF/Excel звірки: той самий вигляд, що й звіт, з трьома підсумковими рядками. */
function reconciliationPayload(data, constructorName) {
  const tasks = data.rows.map((r) => ({
    ...r,
    title: titleWithPlanned(r),
    // видалені показуємо тим самим сірим, що й відсутність
    isAbsence: r.isAbsence || r.isDeleted,
  }));
  const parts = [data.monthLabel || monthRange(data.month), `План: версія ${data.plan.version}, зафіксовано ${formatDate(data.plan.fixedAt)}`];
  if (data.plan.note) parts.push(data.plan.note);
  if (data.asOf) parts.push(`станом на ${formatDate(data.asOf)}`);
  const t = data.totals;
  return {
    constructorName,
    heading: "Звірка плану з фактом",
    periodLabel: parts.join(" · "),
    tasks,
    totals: {
      summary: [
        { label: "Заплановано на місяць:", ...t.planned },
        { label: "Виконано із запланованих:", ...t.done },
        { label: "Нових задач додано протягом місяця:", ...t.added, accent: true },
      ],
      greyLegend: "видалені задачі та відпустка / відсутність",
    },
  };
}

module.exports = { planPayload, reconciliationPayload };
