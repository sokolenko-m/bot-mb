"use strict";
/**
 * Звірка зафіксованого плану місяця з фактом. Чиста логіка без мережі:
 * правила описані в PRODUCT_SPEC.md, вхідні дані збирає plans.js.
 *
 * Підсумки рахуються лише з готових рядків, щоб таблиця й підсумок не могли розійтись.
 */
const { baseTitle, isContinuation } = require("./notion");
const { ABSENCE_RE, ABSENCE_STATUS, KNOWN_STATES, computeStatus } = require("./report");
const { kyivDateStr } = require("./dates");

const STATUS_DONE = "Виконано";
const STATUS_DELETED = "Видалена";
const STATUS_FUTURE = "Дата закриття в майбутньому";

function round2(n) {
  return Math.round(n * 100) / 100;
}
function sum(list, fn) {
  return round2(list.reduce((s, x) => s + (fn(x) || 0), 0));
}
function norm(title) {
  return (title || "").trim();
}
function time(iso) {
  return iso ? new Date(iso).getTime() : NaN;
}

/** Дата закриття в Києві: "Факт. завершення", інакше при 100 % плановий кінець. */
function closeDate(task) {
  if (task.factEnd) return kyivDateStr(task.factEnd);
  return task.done && task.end ? kyivDateStr(task.end) : null;
}

/** Факт-години; якщо задачу закрито раніше початку, факт неправдивий і не враховується. */
function validFact(task) {
  if (task.factHours === null || task.factHours === undefined) return null;
  const closed = closeDate(task);
  if (closed && task.start && closed < kyivDateStr(task.start)) return null;
  return task.factHours;
}

function compactDayMonth(dateStr) {
  const [, m, d] = dateStr.split("-");
  return `${d}.${m}`;
}

/** Куди віднести продовження: найближча попередня планова задача з тією ж базовою назвою. */
function findParent(cont, plannedRows) {
  const base = baseTitle(cont.title);
  let best = null;
  for (const r of plannedRows) {
    const parent = r.current;
    if (baseTitle(parent.title) !== base) continue;
    if (cont.createdTime && parent.createdTime && cont.createdTime < parent.createdTime) continue;
    if (cont.start && parent.start && time(cont.start) < time(parent.start)) continue;
    if (!best || time(parent.start) > time(best.current.start)) best = r;
  }
  return best;
}

/** Статус набору частин однієї задачі та чи зараховується вона в цьому місяці. */
function partsOutcome(parts, { monthEndExclusive, today }) {
  const open = parts.find((p) => !closeDate(p));
  if (open) {
    const state = KNOWN_STATES.has(open.state) && open.state !== STATUS_DONE ? open.state : computeStatus({ ...open, done: false });
    return { status: state, isDone: false };
  }
  const dates = parts.map(closeDate).sort();
  const last = dates[dates.length - 1];
  if (last > today) return { status: STATUS_FUTURE, isDone: false };
  if (last >= monthEndExclusive) return { status: `Закрита ${compactDayMonth(last)}`, isDone: false };
  return { status: STATUS_DONE, isDone: true };
}

function plannedRowFromSnapshot(plan, overrides) {
  return {
    pageId: plan.pageId,
    taskNumber: plan.taskNumber || "",
    order: plan.order,
    title: plan.title,
    plannedTitle: null,
    objectName: plan.objectName || "—",
    taskType: plan.taskType || "",
    createdTime: plan.createdTime || null,
    start: plan.start,
    end: plan.end,
    plannedHours: plan.plannedHours || 0,
    factHours: null,
    hours: 0,
    isDone: false,
    isNew: false,
    isDeleted: false,
    isAbsence: Boolean(plan.isAbsence),
    ...overrides,
  };
}

function finishPlannedRow(row, parts, ctx) {
  const current = row.current;
  row.taskNumber = current.taskNumber || row.taskNumber;
  row.order = current.order ?? row.order;
  row.title = current.title;
  row.plannedTitle = norm(current.title) === norm(row.snapshotTitle) ? null : norm(row.snapshotTitle);
  row.objectName = current.objectName || row.objectName;
  row.taskType = current.taskType || row.taskType;
  row.createdTime = current.createdTime || row.createdTime;
  row.start = current.start || row.start;
  const ends = parts.map((p) => p.end).filter(Boolean);
  if (ends.length) row.end = ends.reduce((max, e) => (time(e) > time(max) ? e : max));

  const facts = parts.map(validFact);
  row.factHours = facts.some((f) => f !== null) ? round2(facts.reduce((s, f) => s + (f || 0), 0)) : null;

  if (row.isAbsence) {
    row.status = ABSENCE_STATUS;
    return;
  }
  const outcome = partsOutcome(parts, ctx);
  row.status = outcome.status;
  row.isDone = outcome.isDone;
  if (parts.length === 1) {
    row.hours = facts[0] ?? row.plannedHours;
  } else {
    row.hours = round2(parts.reduce((s, p, i) => s + (facts[i] ?? p.plannedHours ?? 0), 0));
  }
}

/**
 * @param {object} input
 * @param {string} input.monthStart "2026-12-01"
 * @param {string} input.monthEndExclusive "2027-01-01"
 * @param {Array}  input.planTasks задачі зафіксованої версії
 * @param {Array}  input.currentTasks усі поточні задачі цього конструктора
 * @param {Map}    input.externalStates pageId → {deleted} | {deleted:false, ownerName} для планових, яких немає серед currentTasks
 * @param {string} input.today київська дата "YYYY-MM-DD"
 */
function reconcile({ monthStart, monthEndExclusive, planTasks, currentTasks, externalStates = new Map(), today }) {
  const ctx = { monthEndExclusive, today };
  const byId = new Map(currentTasks.map((t) => [t.id, t]));
  const planIds = new Set(planTasks.map((p) => p.pageId));

  const rows = [];
  const live = [];
  for (const plan of planTasks) {
    const current = byId.get(plan.pageId);
    if (current) {
      const row = plannedRowFromSnapshot(plan, { current, snapshotTitle: plan.title, parts: [current] });
      rows.push(row);
      if (!plan.isAbsence) live.push(row);
      continue;
    }
    const ext = externalStates.get(plan.pageId);
    if (ext && !ext.deleted) {
      rows.push(plannedRowFromSnapshot(plan, { status: `Передана: ${ext.ownerName || "інший конструктор"}` }));
    } else {
      rows.push(plannedRowFromSnapshot(plan, { status: STATUS_DELETED, isDeleted: true }));
    }
  }

  const others = currentTasks.filter((t) => !planIds.has(t.id));

  // Продовження планових задач приєднуємо до них, у нові вони не йдуть.
  const attached = new Set();
  const continuations = others.filter((t) => isContinuation(t.title)).sort((a, b) => time(a.start) - time(b.start));
  for (const cont of continuations) {
    const parent = findParent(cont, live);
    if (parent) {
      parent.parts.push(cont);
      attached.add(cont.id);
    }
  }

  for (const row of rows) {
    if (row.current) finishPlannedRow(row, row.parts, ctx);
  }

  for (const t of others) {
    if (attached.has(t.id)) continue;
    const startDay = kyivDateStr(t.start);
    const closedDay = closeDate(t);
    const inMonth = (d) => d && d >= monthStart && d < monthEndExclusive;
    if (!inMonth(startDay) && !inMonth(closedDay)) continue;
    const isAbsence = ABSENCE_RE.test(t.title || "");
    const fact = validFact(t);
    const outcome = isAbsence ? { status: ABSENCE_STATUS } : partsOutcome([t], ctx);
    rows.push({
      pageId: t.id,
      taskNumber: t.taskNumber || "",
      order: t.order,
      title: t.title,
      plannedTitle: null,
      objectName: t.objectName || "—",
      taskType: t.taskType || "",
      createdTime: t.createdTime,
      start: t.start,
      end: t.end,
      plannedHours: t.plannedHours || 0,
      factHours: fact,
      hours: fact ?? (t.plannedHours || 0),
      status: outcome.status,
      isDone: false,
      isNew: !isAbsence,
      isDeleted: false,
      isAbsence,
    });
  }

  rows.sort((a, b) => {
    const da = kyivDateStr(a.start);
    const db = kyivDateStr(b.start);
    if (da !== db) return da < db ? -1 : 1;
    return (a.order ?? 0) - (b.order ?? 0);
  });

  for (const row of rows) {
    delete row.current;
    delete row.parts;
    delete row.snapshotTitle;
  }

  const planned = rows.filter((r) => !r.isNew && !r.isAbsence);
  const done = planned.filter((r) => r.isDone);
  const added = rows.filter((r) => r.isNew);
  const absence = rows.filter((r) => r.isAbsence);

  return {
    rows,
    totals: {
      planned: { count: planned.length, hours: sum(planned, (r) => r.plannedHours) },
      done: { count: done.length, hours: sum(done, (r) => r.hours) },
      added: { count: added.length, hours: sum(added, (r) => r.hours) },
      absence: { count: absence.length, hours: sum(absence, (r) => r.plannedHours) },
    },
  };
}

module.exports = { reconcile, closeDate, STATUS_DONE, STATUS_DELETED, STATUS_FUTURE };
