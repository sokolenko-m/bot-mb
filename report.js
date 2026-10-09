"use strict";
const {
  getTasksForReport,
  findOriginalCreatedTimes,
  getSchedulerLastCycle,
  baseTitle,
  isContinuation,
} = require("./notion");
const { kyivDateStr, formatDate } = require("./dates");

// Те саме правило, що й у боті конструкторів (notion_scheduler/bot_daily.js).
const ABSENCE_RE = /^\s*(відпустка|відсутність|отпуск)/i;
const ABSENCE_STATUS = "Відсутність";

// Планувальник пише "живий" раз на 30 хв і сам попереджає адміна після 2 год
// без успішного циклу — тут той самий поріг.
const SCHEDULER_STALE_MINUTES = 120;

const KNOWN_STATES = new Set(["Виконано", "На паузі", "Заплановано", "В роботі"]);

/** Статус, якщо формули "Стан задачі" немає (запасний варіант). */
function computeStatus(task, now = new Date()) {
  if (task.done) return "Виконано";
  const start = task.start ? new Date(task.start) : null;
  if (start && start.getTime() > now.getTime()) return "Заплановано";
  return "В роботі";
}

/** Період за фактичними датами задач: від найранішого початку до найпізнішого кінця. */
function actualRangeLabel(tasks) {
  const starts = tasks.map((t) => t.start).filter(Boolean).sort();
  const ends = tasks.map((t) => t.end || t.start).filter(Boolean).sort();
  if (!starts.length) return "немає задач";
  return `${formatDate(starts[0])}–${formatDate(ends[ends.length - 1])}`;
}

/** Фактичні години, якщо є, інакше планові — для підсумків "скільки реально пішло". */
function effectiveHours(task) {
  return task.factHours ?? task.plannedHours ?? 0;
}

/** {lastCycle, minutesAgo, stale} або null, якщо планувальник ще не передавав статус. */
async function schedulerFreshness(now = new Date()) {
  const lastCycle = await getSchedulerLastCycle();
  if (!lastCycle) return null;
  const minutesAgo = Math.max(0, Math.round((now.getTime() - new Date(lastCycle).getTime()) / 60000));
  return { lastCycle, minutesAgo, stale: minutesAgo > SCHEDULER_STALE_MINUTES };
}

/**
 * Формує дані звіту (задачі + підсумки + підпис періоду) по одному конструктору.
 * options:
 *  - { startDateStr, endDateStr } — звіт за заданий період; у цьому режимі
 *    задачі, створені в Notion вже ПІСЛЯ початку періоду (за київською датою),
 *    позначаються як "нові" (isNew=true) — додані протягом місяця, а не
 *    заплановані заздалегідь. Продовження розрізаної задачі "(продолжение)"
 *    успадковує дату створення вихідної задачі;
 *  - { objectIds: [...], objectNames } — звіт за весь час роботи на об'єкті(ах)
 *    (період ігнорується, обчислюється фактично за датами знайдених задач;
 *    поняття "нова задача" тут не застосовується).
 * Відпустка/відсутність показується сірим і не входить у підсумки годин —
 * для неї окремий рядок totals.absence.
 */
async function buildReport(constructorId, options = {}) {
  const isObjectMode = Array.isArray(options.objectIds) && options.objectIds.length > 0;
  const [rawTasks, scheduler] = await Promise.all([
    getTasksForReport(constructorId, isObjectMode ? { objectIds: options.objectIds } : options),
    schedulerFreshness(),
  ]);
  const now = new Date();
  const trackNew = !isObjectMode && Boolean(options.startDateStr);

  let originalCreated = new Map();
  if (trackNew) {
    const bases = rawTasks.filter((t) => isContinuation(t.title)).map((t) => baseTitle(t.title));
    if (bases.length) originalCreated = await findOriginalCreatedTimes(constructorId, bases);
  }

  const tasks = rawTasks.map((t) => {
    const isAbsence = ABSENCE_RE.test(t.title || "");
    let status;
    if (isAbsence) status = ABSENCE_STATUS;
    else status = KNOWN_STATES.has(t.state) ? t.state : computeStatus(t, now);

    let originCreatedTime = t.createdTime;
    if (trackNew && isContinuation(t.title)) {
      const orig = originalCreated.get(baseTitle(t.title));
      if (orig && orig < originCreatedTime) originCreatedTime = orig;
    }
    const isNew =
      trackNew && !isAbsence && originCreatedTime ? kyivDateStr(originCreatedTime) >= options.startDateStr : false;

    return { ...t, status, isAbsence, isNew, originCreatedTime };
  });

  const work = tasks.filter((t) => !t.isAbsence);
  const absence = tasks.filter((t) => t.isAbsence);

  const totals = {
    plannedHours: round2(work.reduce((s, t) => s + (t.plannedHours || 0), 0)),
    factHours: round2(work.reduce((s, t) => s + (t.factHours || 0), 0)),
    count: work.length,
  };

  if (absence.length) {
    totals.absence = {
      count: absence.length,
      hours: round2(absence.reduce((s, t) => s + (t.plannedHours || 0), 0)),
    };
  }

  if (trackNew) {
    const plannedGroup = work.filter((t) => !t.isNew);
    const addedGroup = work.filter((t) => t.isNew);
    totals.byOrigin = {
      planned: {
        count: plannedGroup.length,
        hours: round2(plannedGroup.reduce((s, t) => s + effectiveHours(t), 0)),
      },
      added: {
        count: addedGroup.length,
        hours: round2(addedGroup.reduce((s, t) => s + effectiveHours(t), 0)),
      },
      totalHours: round2(work.reduce((s, t) => s + effectiveHours(t), 0)),
    };
  }

  let periodLabel;
  if (isObjectMode) {
    const objectPart = options.objectNames ? `Об'єкт: ${options.objectNames} — ` : "";
    periodLabel = objectPart + actualRangeLabel(tasks);
  } else {
    // endDateStr — виключна межа (перший день після періоду), показуємо останній день періоду
    periodLabel = `${formatDate(options.startDateStr)}–${formatDate(dayBefore(options.endDateStr))}`;
  }

  return { tasks, totals, periodLabel, scheduler };
}

function dayBefore(dateStr) {
  if (!dateStr) return "";
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { buildReport, ABSENCE_STATUS };
