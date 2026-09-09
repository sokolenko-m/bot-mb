"use strict";
const { getTasksForReport } = require("./notion");

/** Builds the report payload (tasks + totals) for one constructor and period. */
async function buildReport(constructorId, startDateStr, endDateStr) {
  const tasks = await getTasksForReport(constructorId, startDateStr, endDateStr);

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
