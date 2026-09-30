"use strict";
/**
 * Read-only Notion API client for the report app. Queries the same "Задачи"
 * data source used by the designer-schedule sync (notion_scheduler project).
 */

const API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2025-09-03";

const TOKEN = process.env.NOTION_TOKEN;
const DATA_SOURCE_ID = process.env.NOTION_DATA_SOURCE_ID;

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

async function queryAll(filter, sorts) {
  assertConfigured();
  const results = [];
  let startCursor;
  const url = `${API_BASE}/data_sources/${DATA_SOURCE_ID}/query`;
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
function getMultiSelect(props, key) {
  return (props[key]?.multi_select || []).map((o) => o.name).join(", ");
}
function isDone(props) {
  const pct = getNumber(props, KEYS.percent, 0);
  const factEnd = getDate(props, KEYS.factEnd);
  return (pct || 0) >= 100 || !!(factEnd && factEnd.start);
}

/** Список конструкторов, встречающихся в базе — {id, name}. */
async function listConstructors() {
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
      createdTime: p.created_time,
    };
  });

  await resolveObjectNames(tasks);
  return tasks;
}

module.exports = { listConstructors, listObjectsForConstructor, getTasksForReport, KEYS };
