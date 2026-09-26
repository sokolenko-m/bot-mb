"use strict";
const { getTasksForReport } = require("./notion");

/** Обчислює статус життєвого циклу задачі станом на зараз. */
function computeStatus(task, now = new Date()) {
  if (task.done) return "Виконано";
  const start = task.start ? new Date(task.start) : null;
  if (start && start.getTime() > now.getTime()) return "Заплановано";
  return "В роботі";
}

function formatDateShort(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric" });
}

/** Період за фактичними датами задач: від найранішого початку до найпізнішого кінця. */
function actualRangeLabel(tasks) {
  const starts = tasks.map((t) => t.start).filter(Boolean).sort();
  const ends = tasks.map((t) => t.end || t.start).filter(Boolean).sort();
  if (!starts.length) return "немає задач";
  return `${formatDateShort(starts[0])}–${formatDateShort(ends[ends.length - 1])}`;
}

/**
 * Формує дані звіту (задачі + підсумки + підпис періоду) по одному конструктору.
 * options:
 *  - { startDateStr, endDateStr } — звіт за заданий період;
 *  - { objectIds: [...], objectNames } — звіт за весь час роботи на об'єкті(ах)
 *    (період ігнорується, обчислюється фактично за датами знайдених задач).
 */
async function buildReport(constructorId, options = {}) {
  const isObjectMode = Array.isArray(options.objectIds) && options.objectIds.length > 0;
  const rawTasks = await getTasksForReport(
    constructorId,
    isObjectMode ? { objectIds: options.objectIds } : options
  );
  const now = new Date();

  const tasks = rawTasks.map((t) => ({ ...t, status: computeStatus(t, now) }));

  const totals = tasks.reduce(
    (acc, t) => {
      acc.plannedHours += t.plannedHours || 0;
      acc.factHours += t.factHours || 0;
      acc.count += 1;
      return acc;
    },
    { plannedHours: 0, factHours: 0, count: 0 }
  );
  totals.plannedHours = round2(totals.plannedHours);
  totals.factHours = round2(totals.factHours);

  let periodLabel;
  if (isObjectMode) {
    const objectPart = options.objectNames ? `Об'єкт: ${options.objectNames} — ` : "";
    periodLabel = objectPart + actualRangeLabel(tasks);
  } else {
    periodLabel = `${formatDateShort(options.startDateStr)}–${formatDateShort(options.endDateStr)}`;
  }

  return { tasks, totals, periodLabel };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { buildReport };
