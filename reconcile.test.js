"use strict";
/** Логіка звірки плану з фактом. Без мережі. Запуск: npm test */
const test = require("node:test");
const assert = require("node:assert/strict");
const { reconcile } = require("./reconcile");

const MONTH = { month: "2026-12", monthStart: "2026-12-01", monthEndExclusive: "2027-01-01" };

function planTask(id, over = {}) {
  return {
    pageId: id,
    taskNumber: `KV-${id}`,
    title: `Задача ${id}`,
    objectName: "Об'єкт",
    taskType: "КМД",
    order: 1,
    plannedHours: 8,
    start: "2026-12-07T09:00:00+02:00",
    end: "2026-12-07T18:00:00+02:00",
    isAbsence: false,
    ...over,
  };
}

function current(id, over = {}) {
  return {
    id,
    taskNumber: `KV-${id}`,
    title: `Задача ${id}`,
    objectName: "Об'єкт",
    taskType: "КМД",
    order: 1,
    plannedHours: 8,
    factHours: null,
    done: false,
    factEnd: null,
    start: "2026-12-07T09:00:00+02:00",
    end: "2026-12-07T18:00:00+02:00",
    state: "В роботі",
    createdTime: "2026-11-20T08:00:00.000Z",
    ...over,
  };
}

function closed(id, factEnd, over = {}) {
  return current(id, { done: true, factEnd, state: "Виконано", factHours: 8, ...over });
}

function run({ plan = [], tasks = [], external = {}, today = "2026-12-31" }) {
  return reconcile({
    ...MONTH,
    planTasks: plan,
    currentTasks: tasks,
    externalStates: new Map(Object.entries(external)),
    today,
  });
}

const row = (result, number) => result.rows.find((r) => r.taskNumber === number);

test("задача, закрита в місяці, виконана; години беруться з факту", () => {
  const r = run({ plan: [planTask("1")], tasks: [closed("1", "2026-12-07T17:00:00+02:00", { factHours: 12 })] });
  assert.equal(row(r, "KV-1").status, "Виконано");
  assert.equal(row(r, "KV-1").factHours, 12);
  assert.deepEqual(r.totals.planned, { count: 1, hours: 8 });
  assert.deepEqual(r.totals.done, { count: 1, hours: 12 });
  assert.deepEqual(r.totals.added, { count: 0, hours: 0 });
});

test("виконана без факту зараховує планові години зі знімка", () => {
  const r = run({ plan: [planTask("1", { plannedHours: 10 })], tasks: [closed("1", "2026-12-07", { factHours: null, plannedHours: 5 })] });
  assert.deepEqual(r.totals.done, { count: 1, hours: 10 });
});

test("100 % без дати закриття: датою вважається плановий кінець", () => {
  const r = run({ plan: [planTask("1")], tasks: [current("1", { done: true, state: "Виконано" })] });
  assert.equal(row(r, "KV-1").status, "Виконано");
  assert.equal(r.totals.done.count, 1);
});

test("перейменована задача: поточна назва і назва в плані", () => {
  const r = run({ plan: [planTask("1", { title: "Стара назва" })], tasks: [current("1", { title: "Нова назва" })] });
  assert.equal(row(r, "KV-1").title, "Нова назва");
  assert.equal(row(r, "KV-1").plannedTitle, "Стара назва");
});

test("без перейменування назву в плані не показуємо", () => {
  const r = run({ plan: [planTask("1", { title: " Назва " })], tasks: [current("1", { title: "Назва" })] });
  assert.equal(row(r, "KV-1").plannedTitle, null);
});

test("перенос у черзі і зміна дат не гублять задачу", () => {
  const r = run({
    plan: [planTask("1", { order: 5 })],
    tasks: [closed("1", "2026-12-20T12:00:00+02:00", { order: 99, start: "2026-12-20T09:00:00+02:00" })],
  });
  assert.equal(r.rows.length, 1);
  assert.equal(row(r, "KV-1").order, 99);
  assert.equal(r.totals.done.count, 1);
  assert.equal(r.totals.added.count, 0);
});

test("планові години беруться зі знімка, навіть якщо в задачі змінились", () => {
  const r = run({ plan: [planTask("1", { plannedHours: 8 })], tasks: [current("1", { plannedHours: 80 })] });
  assert.equal(row(r, "KV-1").plannedHours, 8);
  assert.equal(r.totals.planned.hours, 8);
});

test("незакрита задача зі своїм статусом, не виконана", () => {
  const r = run({ plan: [planTask("1")], tasks: [current("1", { state: "На паузі" })] });
  assert.equal(row(r, "KV-1").status, "На паузі");
  assert.equal(r.totals.done.count, 0);
});

test("закрита в наступному місяці не зараховується", () => {
  const r = run({ plan: [planTask("1")], tasks: [closed("1", "2027-01-02T10:00:00+02:00")], today: "2027-01-10" });
  assert.equal(row(r, "KV-1").status, "Закрита 02.01");
  assert.equal(r.totals.done.count, 0);
});

test("межа місяця за Києвом: 31.12 о 23:30 ще грудень, 01.01 вже ні", () => {
  const inside = run({ plan: [planTask("1")], tasks: [closed("1", "2026-12-31T23:30:00+02:00")], today: "2027-01-05" });
  assert.equal(inside.totals.done.count, 1);
  const outside = run({ plan: [planTask("1")], tasks: [closed("1", "2027-01-01")], today: "2027-01-05" });
  assert.equal(outside.totals.done.count, 0);
});

test("дата закриття в майбутньому не зараховується і позначається", () => {
  const r = run({ plan: [planTask("1")], tasks: [closed("1", "2026-12-25T10:00:00+02:00")], today: "2026-12-15" });
  assert.equal(row(r, "KV-1").status, "Дата закриття в майбутньому");
  assert.equal(r.totals.done.count, 0);
});

test("видалена задача лишається сірою в плані", () => {
  const r = run({ plan: [planTask("1")], external: { 1: { deleted: true } } });
  const x = row(r, "KV-1");
  assert.equal(x.status, "Видалена");
  assert.equal(x.isDeleted, true);
  assert.equal(x.title, "Задача 1");
  assert.deepEqual(r.totals.planned, { count: 1, hours: 8 });
  assert.equal(r.totals.done.count, 0);
});

test("передана іншому: лишається в плані, статус з прізвищем, не зараховується", () => {
  const r = run({
    plan: [planTask("1")],
    external: { 1: { deleted: false, ownerName: "Іванов", task: closed("1", "2026-12-07") } },
  });
  assert.equal(row(r, "KV-1").status, "Передана: Іванов");
  assert.equal(r.totals.done.count, 0);
});

test("нова задача поза планом, почата в місяці", () => {
  const r = run({ tasks: [current("9", { factHours: 3, plannedHours: 5 })] });
  assert.equal(row(r, "KV-9").isNew, true);
  assert.deepEqual(r.totals.added, { count: 1, hours: 3 });
});

test("нова задача без факту рахується за планом", () => {
  const r = run({ tasks: [current("9", { plannedHours: 5 })] });
  assert.deepEqual(r.totals.added, { count: 1, hours: 5 });
});

test("стара задача, перенесена в місяць, теж нова", () => {
  const r = run({ tasks: [current("9", { createdTime: "2026-01-01T08:00:00.000Z" })] });
  assert.equal(row(r, "KV-9").isNew, true);
});

test("почата раніше, закрита в місяці, поза планом: нова", () => {
  const r = run({ tasks: [closed("9", "2026-12-02", { start: "2026-11-20T09:00:00+02:00" })] });
  assert.equal(row(r, "KV-9").isNew, true);
});

test("задача інших місяців у звірку не потрапляє", () => {
  const r = run({
    tasks: [
      closed("8", "2026-11-20", { start: "2026-11-10T09:00:00+02:00" }),
      current("9", { start: "2027-01-10T09:00:00+02:00" }),
    ],
  });
  assert.equal(r.rows.length, 0);
});

test("продовження планової задачі не нове; виконана, лише коли закриті всі частини", () => {
  const plan = [planTask("1", { title: "Вузли", plannedHours: 20 })];
  const parent = closed("1", "2026-12-08T18:00:00+02:00", { title: "Вузли", factHours: 12, plannedHours: 12 });
  const contOpen = current("2", {
    title: "Вузли (продовження)",
    plannedHours: 8,
    start: "2026-12-10T09:00:00+02:00",
    end: "2026-12-11T09:00:00+02:00",
    createdTime: "2026-12-08T10:00:00.000Z",
    state: "В роботі",
  });
  const open = run({ plan, tasks: [parent, contOpen] });
  assert.equal(open.rows.length, 1);
  assert.equal(row(open, "KV-1").status, "В роботі");
  assert.equal(open.totals.done.count, 0);
  assert.equal(open.totals.added.count, 0);

  const contClosed = closed("2", "2026-12-11T09:00:00+02:00", {
    title: "Вузли (продовження)",
    factHours: 9,
    plannedHours: 8,
    start: "2026-12-10T09:00:00+02:00",
    end: "2026-12-11T09:00:00+02:00",
    createdTime: "2026-12-08T10:00:00.000Z",
  });
  const done = run({ plan, tasks: [parent, contClosed] });
  assert.equal(row(done, "KV-1").status, "Виконано");
  assert.equal(row(done, "KV-1").factHours, 21);
  assert.equal(row(done, "KV-1").end.slice(0, 10), "2026-12-11");
  assert.deepEqual(done.totals.done, { count: 1, hours: 21 });
});

test("частина задачі закрита в наступному місяці: задача не виконана", () => {
  const r = run({
    plan: [planTask("1", { title: "Вузли" })],
    tasks: [
      closed("1", "2026-12-30", { title: "Вузли" }),
      closed("2", "2027-01-03", {
        title: "Вузли (продовження)",
        start: "2026-12-31T09:00:00+02:00",
        createdTime: "2026-12-30T10:00:00.000Z",
      }),
    ],
    today: "2027-01-10",
  });
  assert.equal(r.totals.done.count, 0);
  assert.equal(row(r, "KV-1").status, "Закрита 03.01");
});

test("старе продовження з такою ж назвою не чіпляється до планової", () => {
  const r = run({
    plan: [planTask("1", { title: "Інші питання" })],
    tasks: [
      closed("1", "2026-12-07", { title: "Інші питання", createdTime: "2026-11-20T08:00:00.000Z" }),
      closed("2", "2026-03-05", {
        title: "Інші питання (продовження)",
        start: "2026-03-04T09:00:00+02:00",
        createdTime: "2026-03-01T08:00:00.000Z",
      }),
    ],
  });
  assert.equal(r.totals.done.count, 1);
  assert.equal(row(r, "KV-1").factHours, 8);
});

test("дублікати назви: продовження йде до найближчої попередньої планової", () => {
  const r = run({
    plan: [
      planTask("1", { title: "Вузли", start: "2026-12-02T09:00:00+02:00" }),
      planTask("3", { title: "Вузли", start: "2026-12-14T09:00:00+02:00" }),
    ],
    tasks: [
      closed("1", "2026-12-03", { title: "Вузли", start: "2026-12-02T09:00:00+02:00" }),
      closed("3", "2026-12-15", { title: "Вузли", start: "2026-12-14T09:00:00+02:00" }),
      current("2", { title: "Вузли (продовження)", start: "2026-12-16T09:00:00+02:00", createdTime: "2026-12-15T08:00:00.000Z" }),
    ],
  });
  assert.equal(row(r, "KV-1").status, "Виконано");
  assert.equal(row(r, "KV-3").status, "В роботі");
});

test("продовження, що вже є в плані, — окремий плановий рядок", () => {
  const r = run({
    plan: [planTask("1", { title: "Вузли" }), planTask("2", { title: "Вузли (продовження)" })],
    tasks: [closed("1", "2026-12-07", { title: "Вузли" }), current("2", { title: "Вузли (продовження)" })],
  });
  assert.equal(r.rows.length, 2);
  assert.equal(r.totals.planned.count, 2);
  assert.equal(r.totals.done.count, 1);
});

test("відсутність: сіра, не входить у підсумки ні в плані, ні поза ним", () => {
  const r = run({
    plan: [planTask("1", { title: "Відпустка", isAbsence: true, plannedHours: 16 })],
    tasks: [current("1", { title: "Відпустка" }), current("5", { title: "Відпустка 2", plannedHours: 8 })],
  });
  assert.equal(row(r, "KV-1").isAbsence, true);
  assert.equal(row(r, "KV-5").isAbsence, true);
  assert.equal(row(r, "KV-5").isNew, false);
  assert.deepEqual(r.totals.planned, { count: 0, hours: 0 });
  assert.deepEqual(r.totals.added, { count: 0, hours: 0 });
  assert.deepEqual(r.totals.absence, { count: 2, hours: 24 });
});

test("фантомний факт (закрита раніше початку) не враховується", () => {
  const r = run({
    plan: [planTask("1", { plannedHours: 6 })],
    tasks: [closed("1", "2026-12-04T10:00:00+02:00", { factHours: 14, start: "2026-12-07T09:00:00+02:00" })],
  });
  assert.equal(row(r, "KV-1").factHours, null);
  assert.deepEqual(r.totals.done, { count: 1, hours: 6 });
});

test("план без номера (імпорт з копії) працює за id сторінки", () => {
  const r = run({ plan: [planTask("1", { taskNumber: "" })], tasks: [closed("1", "2026-12-07")] });
  assert.equal(r.rows[0].taskNumber, "KV-1", "номер підставляється з поточної задачі");
  assert.equal(r.totals.done.count, 1);
});

test("рядки впорядковані за початком, нові вперемішку з плановими", () => {
  const r = run({
    plan: [planTask("2", { start: "2026-12-10T09:00:00+02:00" })],
    tasks: [
      current("2", { start: "2026-12-10T09:00:00+02:00" }),
      current("9", { start: "2026-12-03T09:00:00+02:00" }),
    ],
  });
  assert.deepEqual(r.rows.map((x) => x.taskNumber), ["KV-9", "KV-2"]);
});

test("підсумки дорівнюють підрахунку за рядками", () => {
  const r = run({
    plan: [planTask("1", { plannedHours: 8 }), planTask("2", { plannedHours: 4.5 }), planTask("3", { plannedHours: 2 })],
    tasks: [closed("1", "2026-12-07", { factHours: 7.25 }), current("2"), current("9", { factHours: 3 })],
    external: { 3: { deleted: true } },
  });
  const plan = r.rows.filter((x) => !x.isNew && !x.isAbsence);
  assert.equal(r.totals.planned.count, plan.length);
  assert.equal(r.totals.planned.hours, plan.reduce((s, x) => s + x.plannedHours, 0));
  const done = plan.filter((x) => x.isDone);
  assert.equal(r.totals.done.count, done.length);
  assert.equal(r.totals.done.hours, done.reduce((s, x) => s + x.hours, 0));
  assert.equal(r.totals.added.count, r.rows.filter((x) => x.isNew).length);
});
