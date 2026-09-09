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
};

function assertConfigured() {
  if (!TOKEN || !DATA_SOURCE_ID) {
    throw new Error("NOTION_TOKEN / NOTION_DATA_SOURCE_ID не заданы в переменных окружения.");
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
  return t && t.length ? t.map((x) => x.plain_text).join("") : "(без названия)";
}
function getNumber(props, key, def = null) {
  const v = props[key]?.number;
  return v === null || v === undefined ? def : v;
}
function getDate(props, key) {
  return props[key]?.date || null;
}
function getPeople(props, key) {
  return props[key]?.people || [];
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
        map.set(person.id, { id: person.id, name: person.name || "Без имени" });
      }
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "ru"));
}

/**
 * Задачи конструктора, начало которых попадает в период [startISO, endISO)
 * (обе даты в формате YYYY-MM-DD). Возвращает отсортированный по дате начала список.
 */
async function getTasksForReport(constructorId, startDateStr, endDateStr) {
  const filter = {
    and: [
      { property: KEYS.constructor, people: { contains: constructorId } },
      { property: KEYS.start, date: { on_or_after: startDateStr } },
      { property: KEYS.start, date: { before: endDateStr } },
    ],
  };
  const pages = await queryAll(filter, [{ property: KEYS.start, direction: "ascending" }]);

  return pages.map((p) => {
    const props = p.properties;
    const start = getDate(props, KEYS.start);
    const end = getDate(props, KEYS.end);
    const factEnd = getDate(props, KEYS.factEnd);
    return {
      id: p.id,
      title: getTitle(props),
      order: getNumber(props, KEYS.order, 0),
      start: start ? start.start : null,
      end: end ? end.start : null,
      plannedHours: getNumber(props, KEYS.plannedHours, 0) || 0,
      factHours: getNumber(props, KEYS.factHours, null),
      done: isDone(props),
      factEnd: factEnd ? factEnd.start : null,
    };
  });
}

module.exports = { listConstructors, getTasksForReport, KEYS };
