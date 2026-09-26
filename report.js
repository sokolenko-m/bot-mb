"use strict";
const { getTasksForReport } = require("./notion");

/** Обчислює статус життєвого циклу задачі станом на зараз. */
function computeStatus(task, now = new Date()) {
  if (task.done) return "Виконано";
  const start = task.start ? new Date(task.start) : null;
  if (start && start.getTime() > now.getTime()) return "Заплановано";
  return "В роботі";
}

/**
 * Формує дані звіту (задачі + підсумки) по одному конструктору.
 * options: { startDateStr, endDateStr } для звіту за період,
 * або { objectId } для звіту за весь час роботи на конкретному об'єкті
 * (період тоді ігнорується).
 */
async function buildReport(constructorId, options = {}) {
  const rawTasks = await getTasksForReport(constructorId, options.objectId ? { objectId: options.objectId } : options);
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

  return { tasks, totals };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { buildReport };
