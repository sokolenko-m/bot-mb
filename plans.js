"use strict";
/**
 * Зафіксовані плани місяця: запис і читання версій у Notion, дані для звірки.
 * Схема і порядок запису описані в SPEC.md. Чиста логіка звірки — у reconcile.js.
 *
 * Версія стає видимою лише після запису всіх рядків (Стан = Активний), тому
 * збій посередині ніколи не підмінює робочий план.
 */
const {
  getTasksForReport,
  getTaskState,
  listConstructors,
  notionRequest,
  queryAll,
  API_BASE,
} = require("./notion");
const { ABSENCE_RE, schedulerFreshness } = require("./report");
const { reconcile } = require("./reconcile");
const { formatDate } = require("./dates");
const { PlanError, parseMonth, canFixMonth, todayKyiv, lastDay } = require("./month");

// Робочі бази «Плани місяця» і «Задачі плану». Змінні оточення потрібні лише для тестових копій.
const PLANS_DS_ID = process.env.NOTION_PLANS_DS_ID || "6482a44b-ca40-4f56-aa3f-10a9648b48c4";
const PLAN_TASKS_DS_ID = process.env.NOTION_PLAN_TASKS_DS_ID || "a1d68d27-4adc-46c7-bfb2-7da41bf78687";

const STATE_WRITING = "Записується";
const STATE_ACTIVE = "Активний";
const STATE_REPLACED = "Замінений";
const SOURCE_BUTTON = "Кнопка";
const WRITING_BLOCK_MS = 5 * 60 * 1000;
const MAX_TEXT = 2000;

const P = {
  name: "Назва",
  month: "Місяць",
  constructor: "Конструктор",
  version: "Версія",
  state: "Стан",
  fixedBy: "Зафіксував",
  source: "Джерело",
  note: "Примітка",
  taskCount: "Задач",
  hours: "Годин",
};
const T = {
  title: "Назва на момент фіксації",
  plan: "План",
  number: "№ задачі",
  pageId: "ID сторінки",
  object: "Об'єкт",
  type: "Тип задачі",
  order: "Порядок",
  planned: "План год",
  start: "Початок",
  end: "Кінець",
  created: "Додано",
  absence: "Відсутність",
};

const locks = new Set();

function assertStorageConfigured() {
  if (!PLANS_DS_ID || !PLAN_TASKS_DS_ID) {
    throw new PlanError("Сховище планів не налаштовано (NOTION_PLANS_DS_ID / NOTION_PLAN_TASKS_DS_ID).", 500);
  }
}

// --- перетворення значень Notion ---

function clip(text) {
  return String(text ?? "").slice(0, MAX_TEXT);
}
function richText(text) {
  const s = clip(text);
  return { rich_text: s ? [{ type: "text", text: { content: s } }] : [] };
}
function dateValue(iso) {
  return { date: iso ? { start: iso } : null };
}
function readText(prop) {
  return (prop?.rich_text || prop?.title || []).map((x) => x.plain_text ?? x.text?.content ?? "").join("");
}

function headerFromPage(page) {
  const p = page.properties;
  return {
    id: page.id,
    month: readText(p[P.month]),
    constructorIds: (p[P.constructor]?.people || []).map((x) => x.id),
    version: p[P.version]?.number ?? 0,
    state: p[P.state]?.select?.name || "",
    fixedBy: readText(p[P.fixedBy]),
    source: p[P.source]?.select?.name || "",
    note: readText(p[P.note]),
    taskCount: p[P.taskCount]?.number ?? 0,
    hours: p[P.hours]?.number ?? 0,
    fixedAt: page.created_time,
  };
}

function rowFromPage(page) {
  const p = page.properties;
  return {
    pageId: readText(p[T.pageId]),
    taskNumber: readText(p[T.number]),
    title: readText(p[T.title]),
    objectName: readText(p[T.object]),
    taskType: readText(p[T.type]),
    order: p[T.order]?.number ?? null,
    plannedHours: p[T.planned]?.number ?? 0,
    start: p[T.start]?.date?.start || null,
    end: p[T.end]?.date?.start || null,
    createdTime: p[T.created]?.date?.start || null,
    isAbsence: Boolean(p[T.absence]?.checkbox),
  };
}

function rowProperties(task, headerId) {
  return {
    [T.title]: { title: [{ type: "text", text: { content: clip(task.title) || "(без назви)" } }] },
    [T.plan]: { relation: [{ id: headerId }] },
    [T.number]: richText(task.taskNumber),
    [T.pageId]: richText(task.pageId),
    [T.object]: richText(task.objectName),
    [T.type]: richText(task.taskType),
    [T.order]: { number: task.order ?? null },
    [T.planned]: { number: task.plannedHours ?? 0 },
    [T.start]: dateValue(task.start),
    [T.end]: dateValue(task.end),
    [T.created]: dateValue(task.createdTime),
    [T.absence]: { checkbox: Boolean(task.isAbsence) },
  };
}

// --- читання ---

async function readHeaders(month, constructorId) {
  assertStorageConfigured();
  const and = [{ property: P.month, rich_text: { equals: month } }];
  if (constructorId) and.push({ property: P.constructor, people: { contains: constructorId } });
  const pages = await queryAll({ and }, undefined, PLANS_DS_ID);
  return pages.map(headerFromPage);
}

/** Активна версія з найбільшим номером, навіть якщо стару не встигли позначити заміненою. */
function pickActive(headers) {
  return headers.filter((h) => h.state === STATE_ACTIVE).sort((a, b) => b.version - a.version)[0] || null;
}

async function readRows(headerId) {
  const pages = await queryAll({ property: T.plan, relation: { contains: headerId } }, undefined, PLAN_TASKS_DS_ID);
  return pages.map(rowFromPage).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

async function getActivePlan(month, constructorId) {
  parseMonth(month);
  const active = pickActive(await readHeaders(month, constructorId));
  if (!active) return null;
  return { ...active, tasks: await readRows(active.id) };
}

async function listVersions(month, constructorId) {
  parseMonth(month);
  const headers = await readHeaders(month, constructorId);
  return headers.filter((h) => h.state !== STATE_WRITING).sort((a, b) => b.version - a.version);
}

/** Усі конструктори з відміткою, чи зафіксовано план на місяць. */
async function listPlanStatuses(month) {
  parseMonth(month);
  const [constructors, headers] = await Promise.all([listConstructors(), readHeaders(month)]);
  return constructors.map((c) => {
    const active = pickActive(headers.filter((h) => h.constructorIds.includes(c.id)));
    return {
      constructorId: c.id,
      name: c.name,
      plan: active
        ? {
            version: active.version,
            fixedAt: active.fixedAt,
            fixedBy: active.fixedBy,
            source: active.source,
            taskCount: active.taskCount,
            hours: active.hours,
          }
        : null,
    };
  });
}

// --- знімок і порівняння ---

function round2(n) {
  return Math.round(n * 100) / 100;
}

function toSnapshot(task) {
  return {
    pageId: task.id,
    taskNumber: task.taskNumber || "",
    title: task.title,
    objectName: task.objectName || "—",
    taskType: task.taskType || "",
    order: task.order ?? null,
    plannedHours: task.plannedHours || 0,
    start: task.start,
    end: task.end,
    createdTime: task.createdTime || null,
    isAbsence: ABSENCE_RE.test(task.title || ""),
  };
}

async function currentSnapshot(month, constructorId) {
  const { monthStart, monthEndExclusive } = parseMonth(month);
  const tasks = await getTasksForReport(constructorId, { startDateStr: monthStart, endDateStr: monthEndExclusive });
  return tasks.map(toSnapshot);
}

/**
 * Відмінності нового знімка від попереднього. Дати й порядок щодня зсуває
 * планувальник, тому вони планом не вважаються: важливі склад, години й назва.
 */
function diffSnapshots(previous, next) {
  const prev = new Map(previous.map((t) => [t.pageId, t]));
  const nextIds = new Set(next.map((t) => t.pageId));
  let added = 0;
  let changed = 0;
  for (const t of next) {
    const old = prev.get(t.pageId);
    if (!old) added++;
    else if (old.plannedHours !== t.plannedHours || old.title.trim() !== t.title.trim()) changed++;
  }
  const removed = previous.filter((t) => !nextIds.has(t.pageId)).length;
  return { added, removed, changed };
}

function isSameDiff(diff) {
  return diff.added === 0 && diff.removed === 0 && diff.changed === 0;
}

function workload(tasks) {
  const work = tasks.filter((t) => !t.isAbsence);
  return { taskCount: work.length, hours: round2(work.reduce((s, t) => s + (t.plannedHours || 0), 0)) };
}

/** Що буде зафіксовано зараз і чим це відрізняється від активної версії. */
async function previewPlan(month, constructorId) {
  const [tasks, active] = await Promise.all([currentSnapshot(month, constructorId), getActivePlan(month, constructorId)]);
  const diff = diffSnapshots(active ? active.tasks : [], tasks);
  return {
    month,
    tasks: tasks.sort((a, b) => String(a.start).localeCompare(String(b.start))),
    ...workload(tasks),
    diff,
    unchanged: Boolean(active) && isSameDiff(diff),
    activeVersion: active ? active.version : null,
  };
}

// --- запис ---

async function trashQuietly(ids) {
  for (const id of ids) {
    try {
      await notionRequest("PATCH", `${API_BASE}/pages/${id}`, { in_trash: true });
    } catch (e) {
      console.error("Не вдалося прибрати неповну версію плану:", e.message);
    }
  }
}

/**
 * Фіксує план. Вікно місяців і право фіксації перевіряє server.js, а разовий
 * імпорт із резервної копії передає готові задачі через tasks.
 */
async function fixPlan({ month, constructorId, constructorName, fixedBy, tasks, source = SOURCE_BUTTON, note = "" }) {
  parseMonth(month);
  assertStorageConfigured();
  const key = `${month}|${constructorId}`;
  if (locks.has(key)) throw new PlanError("Цей план уже зберігається, зачекайте.", 409);
  locks.add(key);
  try {
    const headers = await readHeaders(month, constructorId);
    const recentlyWriting = headers.some(
      (h) => h.state === STATE_WRITING && Date.now() - new Date(h.fixedAt).getTime() < WRITING_BLOCK_MS
    );
    if (recentlyWriting) throw new PlanError("Цей план уже зберігається, зачекайте кілька хвилин.", 409);

    const snapshot = tasks || (await currentSnapshot(month, constructorId));
    const { taskCount, hours } = workload(snapshot);
    if (taskCount === 0) throw new PlanError("Немає задач на цей місяць.");

    const active = pickActive(headers);
    const activeRows = active ? await readRows(active.id) : [];
    const diff = diffSnapshots(activeRows, snapshot);
    if (active && isSameDiff(diff)) {
      return { status: "unchanged", version: active.version, taskCount, hours, diff };
    }

    const version = headers.reduce((max, h) => Math.max(max, h.version), 0) + 1;
    const header = await notionRequest("POST", `${API_BASE}/pages`, {
      parent: { type: "data_source_id", data_source_id: PLANS_DS_ID },
      properties: {
        [P.name]: { title: [{ type: "text", text: { content: `${month} · ${constructorName} · v${version}` } }] },
        [P.month]: richText(month),
        [P.constructor]: { people: [{ id: constructorId }] },
        [P.version]: { number: version },
        [P.state]: { select: { name: STATE_WRITING } },
        [P.fixedBy]: richText(fixedBy),
        [P.source]: { select: { name: source } },
        [P.note]: richText(note),
        [P.taskCount]: { number: taskCount },
        [P.hours]: { number: hours },
      },
    });

    const written = [];
    try {
      for (const task of snapshot) {
        const row = await notionRequest("POST", `${API_BASE}/pages`, {
          parent: { type: "data_source_id", data_source_id: PLAN_TASKS_DS_ID },
          properties: rowProperties(task, header.id),
        });
        written.push(row.id);
      }
      await setState(header.id, STATE_ACTIVE);
    } catch (e) {
      await trashQuietly([...written, header.id]);
      throw e;
    }

    // Нова вже активна: якщо наступний крок зірветься, читання все одно візьме найбільшу версію.
    for (const h of headers) {
      if (h.state === STATE_ACTIVE) await setState(h.id, STATE_REPLACED);
    }
    return { status: "fixed", version, taskCount, hours, diff };
  } finally {
    locks.delete(key);
  }
}

function setState(pageId, state) {
  return notionRequest("PATCH", `${API_BASE}/pages/${pageId}`, { properties: { [P.state]: { select: { name: state } } } });
}

// --- звірка ---

async function buildReconciliation(month, constructorId, { today = todayKyiv() } = {}) {
  const { monthStart, monthEndExclusive } = parseMonth(month);
  const plan = await getActivePlan(month, constructorId);
  if (!plan) throw new PlanError("План на цей місяць не зафіксовано.", 404);

  const [currentTasks, scheduler] = await Promise.all([getTasksForReport(constructorId, {}), schedulerFreshness()]);
  const known = new Set(currentTasks.map((t) => t.id));
  const missing = plan.tasks.filter((t) => t.pageId && !known.has(t.pageId));

  const externalStates = new Map();
  await Promise.all(
    missing.map(async (t) => {
      const state = await getTaskState(t.pageId);
      if (!state.deleted && state.ownerIds.includes(constructorId)) currentTasks.push(state.task);
      else externalStates.set(t.pageId, state);
    })
  );

  const result = reconcile({ monthStart, monthEndExclusive, planTasks: plan.tasks, currentTasks, externalStates, today });
  const { tasks: _omit, ...planMeta } = plan;
  return {
    month,
    ...result,
    plan: planMeta,
    asOf: today < monthEndExclusive ? today : null,
    monthLabel: `${formatDate(monthStart)}–${formatDate(lastDay(monthEndExclusive))}`,
    scheduler,
  };
}

function _resetForTests() {
  locks.clear();
}

module.exports = {
  PlanError,
  parseMonth,
  canFixMonth,
  todayKyiv,
  fixPlan,
  previewPlan,
  getActivePlan,
  listVersions,
  listPlanStatuses,
  buildReconciliation,
  lastDay,
  _resetForTests,
};
