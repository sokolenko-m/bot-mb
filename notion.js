"use strict";
/**
 * Read-only Notion API client for the report app. Queries the same "Задачи"
 * data source used by the designer-schedule sync (notion_scheduler project).
 */

const API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2025-09-03";

const TOKEN = process.env.NOTION_TOKEN;
const DATA_SOURCE_ID = process.env.NOTION_DATA_SOURCE_ID;
// "Участники_1" — звідси береться список тих, кому відкрито звіти.
const PARTICIPANTS_DS_ID = process.env.NOTION_PARTICIPANTS_DS_ID || "37d7a095-971a-8076-8dfd-000bf72aec67";
// Сторінка, в заголовок якої планувальник раз на 30 хв пише час останнього циклу.
const HEARTBEAT_PAGE_ID = process.env.NOTION_HEARTBEAT_PAGE_ID || "3f47a095-971a-8176-bc9f-e6bc48bdc767";

const KEYS = {
  title: "название",
  constructor: "Конструктор",
  order: "Порядок",
  plannedHours: "Трудозатраты, часы",
  start: "Начало",
  end: "Конец",
  urgent: "Срочная",
  percent: "Виконання %",
  factEnd: "Факт. завершення",
  factHours: "Факт. трудозатраты, часы",
  object: "🏗️ Об`єкт",
  taskType: "Тип задачі",
  state: "Стан задачі",
};

const PARTICIPANT_KEYS = {
  telegramId: "Telegram ID",
  reportAccess: "Доступ до звітів",
};

/**
 * Поля, без яких звіт буде хибним (нулі, порожні дати). Якщо хтось у Notion
 * перейменує поле або змінить його тип — звіт не формується, а показується
 * зрозуміла помилка. Для "Порядку" допускаються і url/текст (див. getOrderNumber).
 */
const REQUIRED_TYPES = {
  [KEYS.title]: ["title"],
  [KEYS.constructor]: ["people"],
  [KEYS.order]: ["number", "url", "rich_text"],
  [KEYS.plannedHours]: ["number"],
  [KEYS.start]: ["date"],
  [KEYS.end]: ["date"],
  [KEYS.percent]: ["number"],
  [KEYS.factEnd]: ["date"],
  [KEYS.factHours]: ["number"],
  [KEYS.object]: ["relation"],
};
// Поля, без яких звіт лише бідніший (колонка порожня / статус рахується в коді).
const OPTIONAL_TYPES = {
  [KEYS.taskType]: ["multi_select"],
  [KEYS.state]: ["formula"],
};

function assertConfigured() {
  if (!TOKEN || !DATA_SOURCE_ID) {
    throw new Error("NOTION_TOKEN / NOTION_DATA_SOURCE_ID не задані в змінних оточення.");
  }
}

async function notionRequest(method, url, body) {
  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    throw new Error(`Notion API ${resp.status}: ${await resp.text()}`);
  }
  return resp.json();
}

async function queryAll(filter, sorts, dataSourceId = DATA_SOURCE_ID) {
  assertConfigured();
  const results = [];
  let startCursor;
  const url = `${API_BASE}/data_sources/${dataSourceId}/query`;
  while (true) {
    const body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (sorts) body.sorts = sorts;
    if (startCursor) body.start_cursor = startCursor;
    const data = await notionRequest("POST", url, body);
    results.push(...(data.results || []));
    if (data.has_more) startCursor = data.next_cursor;
    else break;
  }
  return results;
}

function getTitle(props) {
  const t = props[KEYS.title]?.title;
  return t && t.length ? t.map((x) => x.plain_text).join("") : "(без назви)";
}
function getNumber(props, key, def = null) {
  const v = props[key]?.number;
  return v === null || v === undefined ? def : v;
}
/**
 * "Порядок" зберігається як число, але в частині баз/через певні
 * автоматизації Notion перетворює таке поле на тип url (число як текст
 * посилання) — тому читаємо обидва варіанти, а не лише .number.
 */
function getOrderNumber(props, key, def = 0) {
  const v = props[key];
  if (!v) return def;
  if (v.type === "number") return v.number ?? def;
  if (v.type === "url" && v.url) {
    const n = parseFloat(v.url);
    return Number.isNaN(n) ? def : n;
  }
  if (v.type === "rich_text" && v.rich_text?.length) {
    const n = parseFloat(v.rich_text.map((x) => x.plain_text).join(""));
    return Number.isNaN(n) ? def : n;
  }
  return def;
}
function getDate(props, key) {
  return props[key]?.date || null;
}
function getPeople(props, key) {
  return props[key]?.people || [];
}
function getRelationIds(props, key) {
  return (props[key]?.relation || []).map((r) => r.id);
}
function getPlainText(props, key) {
  const v = props[key];
  const parts = v?.rich_text || v?.title || [];
  return parts.map((x) => x.plain_text).join("").trim();
}
/** Значення формули "Стан задачі" без емодзі на початку: "Виконано", "На паузі", ... */
function getStateText(props) {
  const f = props[KEYS.state]?.formula;
  if (!f || f.type !== "string" || !f.string) return null;
  return f.string.replace(/^[^\p{L}]+/u, "").trim() || null;
}
function getMultiSelect(props, key) {
  return (props[key]?.multi_select || []).map((o) => o.name).join(", ");
}
function isDone(props) {
  const pct = getNumber(props, KEYS.percent, 0);
  const factEnd = getDate(props, KEYS.factEnd);
  return (pct || 0) >= 100 || !!(factEnd && factEnd.start);
}

class SchemaError extends Error {}

const SCHEMA_CHECK_TTL_MS = 5 * 60 * 1000;
let schemaCheckedAt = 0;
let presentOptional = new Set(Object.keys(OPTIONAL_TYPES));

/**
 * Перевіряє, що в базі "Задачи" є потрібні поля потрібних типів (результат
 * кешується на 5 хв). Кидає SchemaError з переліком проблем.
 */
async function assertSchema() {
  assertConfigured();
  if (Date.now() - schemaCheckedAt < SCHEMA_CHECK_TTL_MS) return;
  const ds = await notionRequest("GET", `${API_BASE}/data_sources/${DATA_SOURCE_ID}`);
  const props = ds.properties || {};
  const problems = [];
  for (const [name, types] of Object.entries(REQUIRED_TYPES)) {
    const p = props[name];
    if (!p) problems.push(`немає поля «${name}»`);
    else if (!types.includes(p.type)) problems.push(`поле «${name}» має тип ${p.type}, а очікується ${types[0]}`);
  }
  if (problems.length) {
    throw new SchemaError(
      "Структура бази «Задачи» в Notion змінилась: " +
        problems.join("; ") +
        ". Звіт не сформовано, щоб не показати хибні нулі — поверніть поле як було або зверніться до адміністратора."
    );
  }
  presentOptional = new Set(
    Object.entries(OPTIONAL_TYPES)
      .filter(([name, types]) => props[name] && types.includes(props[name].type))
      .map(([name]) => name)
  );
  schemaCheckedAt = Date.now();
}

/**
 * Telegram ID людей, яким в "Участники_1" поставлено галочку "Доступ до звітів".
 * Повертає Set рядків.
 */
async function listReportAccessTelegramIds() {
  const filter = { property: PARTICIPANT_KEYS.reportAccess, checkbox: { equals: true } };
  const pages = await queryAll(filter, undefined, PARTICIPANTS_DS_ID);
  const ids = new Set();
  for (const p of pages) {
    // в одному полі може бути кілька ID через кому/пробіл
    for (const id of getPlainText(p.properties, PARTICIPANT_KEYS.telegramId).split(/[\s,;]+/)) {
      if (/^\d+$/.test(id)) ids.add(id);
    }
  }
  return ids;
}

/**
 * Час останнього успішного циклу планувальника (ISO) із заголовка сторінки
 * "⚙️ Статус планувальника — останній цикл ДД.ММ.РРРР ЧЧ:ХХ [ISO]".
 * null — якщо сторінка недоступна або планувальник ще не писав туди час.
 */
async function getSchedulerLastCycle() {
  if (!HEARTBEAT_PAGE_ID) return null;
  try {
    const page = await notionRequest("GET", `${API_BASE}/pages/${HEARTBEAT_PAGE_ID}`);
    const titleProp = Object.values(page.properties || {}).find((p) => p.type === "title");
    const title = (titleProp?.title || []).map((x) => x.plain_text).join("");
    const m = title.match(/\[([^\]]+)\]/);
    if (!m) return null;
    const d = new Date(m[1]);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  } catch {
    return null;
  }
}

const CONTINUATION_RE = /\s*\((продолжение|продовження)\)\s*$/i;
/** Назва без суфіксів "(продолжение)"/"(продовження)" (їх може бути кілька). */
function baseTitle(title) {
  let t = title || "";
  while (CONTINUATION_RE.test(t)) t = t.replace(CONTINUATION_RE, "");
  return t.trim();
}
function isContinuation(title) {
  return CONTINUATION_RE.test(title || "");
}

/**
 * Для задач-продовжень (планувальник розрізає задачу, коли її перебиває
 * термінова) шукає найранішу дату створення серед задач того ж конструктора
 * з тією ж базовою назвою — тобто дату створення вихідної задачі.
 * Повертає Map(базова назва → createdTime ISO).
 */
async function findOriginalCreatedTimes(constructorId, baseTitles) {
  const result = new Map();
  await Promise.all(
    [...new Set(baseTitles)].filter(Boolean).map(async (base) => {
      const filter = {
        and: [
          { property: KEYS.constructor, people: { contains: constructorId } },
          { property: KEYS.title, title: { starts_with: base } },
        ],
      };
      const pages = await queryAll(filter);
      let earliest = null;
      for (const p of pages) {
        if (baseTitle(getTitle(p.properties)) !== base) continue;
        if (!earliest || p.created_time < earliest) earliest = p.created_time;
      }
      if (earliest) result.set(base, earliest);
    })
  );
  return result;
}

/** Список конструкторов, встречающихся в базе — {id, name}. */
async function listConstructors() {
  await assertSchema();
  const all = await queryAll();
  const map = new Map();
  for (const page of all) {
    for (const person of getPeople(page.properties, KEYS.constructor)) {
      if (!map.has(person.id)) {
        map.set(person.id, { id: person.id, name: person.name || "Без імені" });
      }
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "uk"));
}

// Кеш назв об'єктів (сторінки з пов'язаної бази) — назви змінюються рідко,
// тримаємо в пам'яті процесу, щоб не запитувати ту саму сторінку двічі.
const objectNameCache = new Map();

async function resolvePageTitle(pageId) {
  if (objectNameCache.has(pageId)) return objectNameCache.get(pageId);
  try {
    const page = await notionRequest("GET", `${API_BASE}/pages/${pageId}`);
    const titleProp = Object.values(page.properties || {}).find((p) => p.type === "title");
    const name = titleProp?.title?.length ? titleProp.title.map((x) => x.plain_text).join("") : "(без назви)";
    objectNameCache.set(pageId, name);
    return name;
  } catch {
    objectNameCache.set(pageId, "—");
    return "—";
  }
}

/** Дозаповнює task.objectName для кожної задачі за relation-полем "Об'єкт". */
async function resolveObjectNames(tasks) {
  const uniqueIds = [...new Set(tasks.flatMap((t) => t.objectIds))];
  await Promise.all(uniqueIds.map((id) => resolvePageTitle(id)));
  for (const t of tasks) {
    t.objectName = t.objectIds.map((id) => objectNameCache.get(id)).filter(Boolean).join(", ") || "—";
  }
  return tasks;
}

/** Об'єкти, на яких коли-небудь працював цей конструктор — {id, name}. */
async function listObjectsForConstructor(constructorId) {
  const filter = { property: KEYS.constructor, people: { contains: constructorId } };
  const pages = await queryAll(filter);
  const ids = [...new Set(pages.flatMap((p) => getRelationIds(p.properties, KEYS.object)))];
  await Promise.all(ids.map((id) => resolvePageTitle(id)));
  return ids
    .map((id) => ({ id, name: objectNameCache.get(id) || "—" }))
    .sort((a, b) => a.name.localeCompare(b.name, "uk"));
}

/**
 * Задачи конструктора. Якщо задано startDateStr/endDateStr (YYYY-MM-DD) —
 * фільтрує за датою початку в межах [startDateStr, endDateStr). Якщо задано
 * objectIds (один або декілька id) — фільтрує задачі, що належать хоча б
 * одному з цих об'єктів (тоді період можна не вказувати — повертається весь
 * час роботи на цих об'єктах). Сортування за датою початку.
 */
async function getTasksForReport(constructorId, { startDateStr, endDateStr, objectIds } = {}) {
  await assertSchema();
  const and = [{ property: KEYS.constructor, people: { contains: constructorId } }];
  if (startDateStr) and.push({ property: KEYS.start, date: { on_or_after: startDateStr } });
  if (endDateStr) and.push({ property: KEYS.start, date: { before: endDateStr } });
  if (objectIds && objectIds.length === 1) {
    and.push({ property: KEYS.object, relation: { contains: objectIds[0] } });
  } else if (objectIds && objectIds.length > 1) {
    and.push({ or: objectIds.map((id) => ({ property: KEYS.object, relation: { contains: id } })) });
  }
  const filter = and.length > 1 ? { and } : and[0];

  const pages = await queryAll(filter, [{ property: KEYS.start, direction: "ascending" }]);

  const tasks = pages.map((p) => {
    const props = p.properties;
    const start = getDate(props, KEYS.start);
    const end = getDate(props, KEYS.end);
    const factEnd = getDate(props, KEYS.factEnd);
    return {
      id: p.id,
      title: getTitle(props),
      order: getOrderNumber(props, KEYS.order, 0),
      start: start ? start.start : null,
      end: end ? end.start : null,
      plannedHours: getNumber(props, KEYS.plannedHours, 0) || 0,
      factHours: getNumber(props, KEYS.factHours, null),
      done: isDone(props),
      factEnd: factEnd ? factEnd.start : null,
      objectIds: getRelationIds(props, KEYS.object),
      taskType: getMultiSelect(props, KEYS.taskType),
      state: presentOptional.has(KEYS.state) ? getStateText(props) : null,
      createdTime: p.created_time,
    };
  });

  await resolveObjectNames(tasks);
  return tasks;
}

module.exports = {
  listConstructors,
  listObjectsForConstructor,
  getTasksForReport,
  listReportAccessTelegramIds,
  getSchedulerLastCycle,
  findOriginalCreatedTimes,
  baseTitle,
  isContinuation,
  SchemaError,
  KEYS,
};
