"use strict";
/** Notion і Telegram у пам'яті для тестів планів і API. Звичайні тести його не запускають напряму. */
const USER = "11111111-1111-4111-8111-111111111111";

function taskPage(id, over = {}) {
  const f = {
    title: `Задача ${id}`,
    hours: 8,
    start: "2026-12-07T09:00:00+02:00",
    end: "2026-12-07T18:00:00+02:00",
    factEnd: null,
    factHours: null,
    percent: 0,
    number: 100 + Number(id),
    owner: USER,
    ownerName: "Тест",
    ...over,
  };
  return {
    id: String(id),
    object: "page",
    created_time: "2026-11-20T08:00:00.000Z",
    in_trash: Boolean(f.trash),
    properties: {
      название: { type: "title", title: [{ plain_text: f.title }] },
      "№ задачі": { type: "unique_id", unique_id: { prefix: "KV", number: f.number } },
      Конструктор: { type: "people", people: [{ id: f.owner, name: f.ownerName }] },
      Порядок: { type: "number", number: Number(id) },
      "Трудозатраты, часы": { type: "number", number: f.hours },
      Начало: { type: "date", date: { start: f.start } },
      Конец: { type: "date", date: { start: f.end } },
      "Виконання %": { type: "number", number: f.percent },
      "Факт. завершення": { type: "date", date: f.factEnd ? { start: f.factEnd } : null },
      "Факт. трудозатраты, часы": { type: "number", number: f.factHours },
      "🏗️ Об`єкт": { type: "relation", relation: [] },
    },
  };
}

const TASK_SCHEMA = Object.fromEntries(Object.entries(taskPage(1).properties).map(([k, v]) => [k, { type: v.type }]));

/** Мінімальний Notion у пам'яті для потрібних цьому модулю запитів. */
function fakeNotion(tasks) {
  const store = { tasks: new Map(tasks.map((t) => [t.id, t])), plans: new Map(), rows: new Map(), failCreateAfter: null, created: 0, calls: [], nextId: 1000 };
  const text = (v) => (v?.rich_text || v?.title || []).map((x) => x.plain_text ?? x.text?.content ?? "").join("");

  function toStored(properties) {
    const out = {};
    for (const [k, v] of Object.entries(properties)) out[k] = v;
    return out;
  }
  function matches(page, filter) {
    if (!filter) return true;
    if (filter.and) return filter.and.every((f) => matches(page, f));
    const p = page.properties[filter.property];
    if (filter.rich_text) return text(p) === filter.rich_text.equals;
    if (filter.people) return (p?.people || []).some((x) => x.id === filter.people.contains);
    if (filter.relation) return (p?.relation || []).some((x) => x.id === filter.relation.contains);
    if (filter.date) {
      const s = p?.date?.start;
      if (!s) return false;
      if (filter.date.on_or_after && s.slice(0, 10) < filter.date.on_or_after) return false;
      if (filter.date.before && s.slice(0, 10) >= filter.date.before) return false;
      return true;
    }
    return true;
  }
  store.documents = [];
  store.failTelegram = false;
  const original = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = opts.method || "GET";
    if (u.includes("api.telegram.org")) {
      if (store.failTelegram) return { ok: false, status: 500, json: async () => ({ ok: false, description: "збій" }) };
      store.documents.push({ chatId: opts.body.get("chat_id"), caption: opts.body.get("caption") });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    const body = opts.body ? JSON.parse(opts.body) : null;
    store.calls.push(`${method} ${u.replace("https://api.notion.com/v1", "")}`);
    const ok = (json) => ({ ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) });
    const notFound = () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "not found" });

    if (method === "GET" && u.includes("/data_sources/")) return ok({ properties: TASK_SCHEMA });

    if (method === "POST" && u.endsWith("/pages")) {
      store.created++;
      if (store.failCreateAfter !== null && store.created > store.failCreateAfter) {
        return { ok: false, status: 500, json: async () => ({}), text: async () => "boom" };
      }
      const id = `p${store.nextId++}`;
      const page = { id, object: "page", created_time: new Date().toISOString(), in_trash: false, properties: toStored(body.properties) };
      (body.parent.data_source_id === "ds-plans" ? store.plans : store.rows).set(id, page);
      return ok(page);
    }

    if (method === "PATCH" && u.includes("/pages/")) {
      const id = u.split("/pages/")[1];
      const page = store.plans.get(id) || store.rows.get(id);
      if (body.in_trash) {
        store.plans.delete(id);
        store.rows.delete(id);
      } else {
        Object.assign(page.properties, toStored(body.properties));
      }
      return ok(page || {});
    }

    if (method === "GET" && u.includes("/pages/")) {
      const page = store.tasks.get(u.split("/pages/")[1]);
      return page ? ok(page) : notFound();
    }

    if (method === "POST" && u.endsWith("/query")) {
      const ds = u.split("/data_sources/")[1].split("/")[0];
      const source = ds === "ds-plans" ? store.plans : ds === "ds-plan-tasks" ? store.rows : store.tasks;
      const results = [...source.values()].filter((p) => !p.in_trash && matches(p, body.filter));
      return ok({ results, has_more: false });
    }
    throw new Error(`Неочікуваний запит ${method} ${u}`);
  };
  store.restore = () => {
    global.fetch = original;
  };
  return store;
}

module.exports = { USER, taskPage, fakeNotion };
