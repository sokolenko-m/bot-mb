"use strict";
/** Зберігання планів: версії, захист від збою і подвійного запису. Notion підмінено пам'яттю. */
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NOTION_TOKEN = "test";
process.env.NOTION_DATA_SOURCE_ID = "ds-tasks";
process.env.NOTION_PLANS_DS_ID = "ds-plans";
process.env.NOTION_PLAN_TASKS_DS_ID = "ds-plan-tasks";

const plans = require("./plans");

const { USER, taskPage, fakeNotion } = require("./fake_notion");

const FIX = { month: "2026-12", constructorId: USER, constructorName: "Тест", fixedBy: "Керівник (1)" };

function setup(tasks) {
  plans._resetForTests();
  return fakeNotion(tasks);
}

test("імпорт із копії: задачі місяця за конструктором, номер із поточного Notion, видалені без номера", () => {
  const { groupMonthTasks, toPlanTask } = require("./scripts/import_plan_from_backup");
  const other = "22222222-2222-4222-8222-222222222222";
  const pages = [
    taskPage(1),
    taskPage(2, { owner: other, ownerName: " Іванов " }),
    taskPage(3, { start: "2027-01-08T09:00:00+02:00" }),
    taskPage(4, { title: "Відпустка" }),
    taskPage(5, { trash: true }),
  ];
  const groups = groupMonthTasks(pages, "2026-12", new Map([["1", "KV-1"]]));
  assert.equal(groups.length, 2);
  const mine = groups.find((g) => g.constructorId === USER);
  assert.deepEqual(mine.tasks.map((t) => t.id), ["1", "4"]);
  assert.equal(mine.tasks[0].taskNumber, "KV-1");
  assert.equal(mine.tasks[1].taskNumber, "");
  assert.equal(toPlanTask(mine.tasks[1]).isAbsence, true);
  assert.equal(groups.find((g) => g.constructorId === other).constructorName, "Іванов");
});

test("імпорт із копії: одна база в кількох файлах не подвоює задачі", () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { readBackupTaskPages } = require("./scripts/import_plan_from_backup");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backup-"));
  try {
    fs.mkdirSync(path.join(dir, "databases"));
    const db = { dataSources: [{ schema: { id: "ds-tasks" }, rows: [{ page: taskPage(1) }, { page: taskPage(2) }] }] };
    fs.writeFileSync(path.join(dir, "databases", "a.json"), JSON.stringify(db));
    fs.writeFileSync(path.join(dir, "databases", "b.json"), JSON.stringify(db));
    fs.writeFileSync(path.join(dir, "databases", "c.json"), JSON.stringify({ dataSources: [{ schema: { id: "other" }, rows: [{ page: taskPage(3) }] }] }));
    assert.deepEqual(readBackupTaskPages(dir, "ds-tasks").map((p) => p.id), ["1", "2"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("перша фіксація створює активну версію 1 із задачами місяця", async () => {
  const s = setup([taskPage(1), taskPage(2, { start: "2026-12-08T09:00:00+02:00" }), taskPage(3, { start: "2027-01-08T09:00:00+02:00" })]);
  try {
    const r = await plans.fixPlan(FIX);
    assert.equal(r.status, "fixed");
    assert.equal(r.version, 1);
    const active = await plans.getActivePlan("2026-12", USER);
    assert.equal(active.version, 1);
    assert.equal(active.taskCount, 2);
    assert.equal(active.hours, 16);
    assert.deepEqual(active.tasks.map((t) => t.taskNumber).sort(), ["KV-101", "KV-102"]);
    assert.equal(active.fixedBy, "Керівник (1)");
    assert.equal(active.source, "Кнопка");
  } finally {
    s.restore();
  }
});

test("знімок зберігає дані задачі, а не посилання: перейменування не змінює план", async () => {
  const s = setup([taskPage(1, { title: "Стара" })]);
  try {
    await plans.fixPlan(FIX);
    s.tasks.set("1", taskPage(1, { title: "Нова", hours: 99 }));
    const active = await plans.getActivePlan("2026-12", USER);
    assert.equal(active.tasks[0].title, "Стара");
    assert.equal(active.tasks[0].plannedHours, 8);
    assert.equal(active.tasks[0].pageId, "1");
  } finally {
    s.restore();
  }
});

test("без змін нова версія не створюється", async () => {
  const s = setup([taskPage(1)]);
  try {
    await plans.fixPlan(FIX);
    const before = s.plans.size;
    const r = await plans.fixPlan(FIX);
    assert.equal(r.status, "unchanged");
    assert.equal(s.plans.size, before);
  } finally {
    s.restore();
  }
});

test("зсув дат і порядку планувальником не робить нову версію", async () => {
  const s = setup([taskPage(1)]);
  try {
    await plans.fixPlan(FIX);
    s.tasks.set("1", taskPage(1, { start: "2026-12-09T09:00:00+02:00", end: "2026-12-09T18:00:00+02:00" }));
    assert.equal((await plans.fixPlan(FIX)).status, "unchanged");
  } finally {
    s.restore();
  }
});

test("перефіксація: версія 2 активна, версія 1 збережена як замінена", async () => {
  const s = setup([taskPage(1)]);
  try {
    await plans.fixPlan(FIX);
    s.tasks.set("2", taskPage(2));
    const r = await plans.fixPlan(FIX);
    assert.equal(r.version, 2);
    assert.equal(r.diff.added, 1);
    assert.equal(r.diff.removed, 0);
    const versions = await plans.listVersions("2026-12", USER);
    assert.deepEqual(versions.map((v) => [v.version, v.state]), [[2, "Активний"], [1, "Замінений"]]);
    const active = await plans.getActivePlan("2026-12", USER);
    assert.equal(active.version, 2);
    assert.equal(active.tasks.length, 2);
  } finally {
    s.restore();
  }
});

test("перегляд показує відмінності від активної версії", async () => {
  const s = setup([taskPage(1), taskPage(2)]);
  try {
    await plans.fixPlan(FIX);
    s.tasks.delete("1");
    s.tasks.set("3", taskPage(3));
    s.tasks.set("4", taskPage(4));
    const p = await plans.previewPlan("2026-12", USER);
    assert.deepEqual(p.diff, { added: 2, removed: 1, changed: 0 });
    assert.equal(p.unchanged, false);
    assert.equal(p.taskCount, 3);
    assert.equal(p.activeVersion, 1);
  } finally {
    s.restore();
  }
});

test("немає задач: фіксувати нічого, версія не створюється", async () => {
  const s = setup([]);
  try {
    await assert.rejects(plans.fixPlan(FIX), (e) => e instanceof plans.PlanError && /Немає задач/.test(e.message));
    assert.equal(s.plans.size, 0);
  } finally {
    s.restore();
  }
});

test("збій посередині: стара версія лишається активною, неповна прибирається", async () => {
  const s = setup([taskPage(1)]);
  try {
    await plans.fixPlan(FIX);
    s.tasks.set("2", taskPage(2));
    s.tasks.set("3", taskPage(3));
    s.failCreateAfter = s.created + 2; // шапка + один рядок
    await assert.rejects(plans.fixPlan(FIX));
    s.failCreateAfter = null;
    const active = await plans.getActivePlan("2026-12", USER);
    assert.equal(active.version, 1);
    assert.equal(active.tasks.length, 1);
    const versions = await plans.listVersions("2026-12", USER);
    assert.deepEqual(versions.map((v) => v.version), [1]);
  } finally {
    s.restore();
  }
});

test("стан «Записується» ніколи не читається як план", async () => {
  const s = setup([taskPage(1)]);
  try {
    await plans.fixPlan(FIX);
    const header = [...s.plans.values()][0];
    header.properties["Стан"] = { select: { name: "Записується" } };
    assert.equal(await plans.getActivePlan("2026-12", USER), null);
  } finally {
    s.restore();
  }
});

test("подвійне натискання: другий запит отримує відмову, версія одна", async () => {
  const s = setup([taskPage(1)]);
  try {
    const results = await Promise.allSettled([plans.fixPlan(FIX), plans.fixPlan(FIX)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const rejected = results.find((r) => r.status === "rejected");
    assert.ok(rejected.reason instanceof plans.PlanError);
    assert.equal(rejected.reason.httpStatus, 409);
    assert.equal(s.plans.size, 1);
  } finally {
    s.restore();
  }
});

test("свіжа неповна версія від іншого запиту блокує фіксацію", async () => {
  const s = setup([taskPage(1)]);
  try {
    s.plans.set("px", {
      id: "px",
      created_time: new Date().toISOString(),
      properties: {
        Місяць: { rich_text: [{ plain_text: "2026-12" }] },
        Конструктор: { people: [{ id: USER }] },
        Версія: { number: 1 },
        Стан: { select: { name: "Записується" } },
      },
    });
    await assert.rejects(plans.fixPlan(FIX), (e) => e.httpStatus === 409);
  } finally {
    s.restore();
  }
});

test("зависла стара неповна версія не заважає і не використовується", async () => {
  const s = setup([taskPage(1)]);
  try {
    s.plans.set("px", {
      id: "px",
      created_time: "2026-01-01T00:00:00.000Z",
      properties: {
        Місяць: { rich_text: [{ plain_text: "2026-12" }] },
        Конструктор: { people: [{ id: USER }] },
        Версія: { number: 1 },
        Стан: { select: { name: "Записується" } },
      },
    });
    const r = await plans.fixPlan(FIX);
    assert.equal(r.version, 2);
  } finally {
    s.restore();
  }
});

test("місяць: формат і вікно фіксації", () => {
  assert.equal(plans.parseMonth("2026-12").monthEndExclusive, "2027-01-01");
  assert.equal(plans.parseMonth("2026-02").monthStart, "2026-02-01");
  for (const bad of ["2026-13", "2026-1", "abc", "", null, "2026-12-01", "../x"]) {
    assert.throws(() => plans.parseMonth(bad), plans.PlanError, String(bad));
  }
  assert.equal(plans.canFixMonth("2026-12", "2026-12-15"), true, "поточний");
  assert.equal(plans.canFixMonth("2027-01", "2026-12-15"), true, "наступний");
  assert.equal(plans.canFixMonth("2026-11", "2026-12-15"), false, "минулий");
  assert.equal(plans.canFixMonth("2027-02", "2026-12-15"), false, "надто далекий");
});

test("звірка: без плану відмова, а не поточні задачі", async () => {
  const s = setup([taskPage(1)]);
  try {
    await assert.rejects(plans.buildReconciliation("2026-12", USER), (e) => e instanceof plans.PlanError && /не зафіксовано/.test(e.message));
  } finally {
    s.restore();
  }
});

test("звірка: видалена, передана, нова, виконана разом", async () => {
  const s = setup([taskPage(1), taskPage(2), taskPage(3), taskPage(4)]);
  try {
    await plans.fixPlan(FIX);
    s.tasks.set("1", taskPage(1, { factEnd: "2026-12-07T17:00:00+02:00", factHours: 7, percent: 100, title: "Перейменована" }));
    s.tasks.delete("2"); // немає в Notion
    s.tasks.set("3", taskPage(3, { trash: true }));
    s.tasks.set("4", taskPage(4, { owner: "22222222-2222-4222-8222-222222222222", ownerName: "Іванов" }));
    s.tasks.set("5", taskPage(5, { factHours: 2 }));
    const r = await plans.buildReconciliation("2026-12", USER, { today: "2027-01-02" });
    const by = Object.fromEntries(r.rows.map((x) => [x.pageId, x]));
    assert.equal(by["1"].status, "Виконано");
    assert.equal(by["1"].plannedTitle, "Задача 1");
    assert.equal(by["2"].status, "Видалена");
    assert.equal(by["3"].status, "Видалена");
    assert.equal(by["4"].status, "Передана: Іванов");
    assert.equal(by["5"].isNew, true);
    assert.deepEqual(r.totals.planned, { count: 4, hours: 32 });
    assert.deepEqual(r.totals.done, { count: 1, hours: 7 });
    assert.deepEqual(r.totals.added, { count: 1, hours: 2 });
    assert.equal(r.plan.version, 1);
    assert.equal(r.asOf, null, "місяць закінчився — це підсумок, а не проміжна картина");
  } finally {
    s.restore();
  }
});

test("звірка до кінця місяця позначена датою «станом на»", async () => {
  const s = setup([taskPage(1)]);
  try {
    await plans.fixPlan(FIX);
    const r = await plans.buildReconciliation("2026-12", USER, { today: "2026-12-15" });
    assert.equal(r.asOf, "2026-12-15");
  } finally {
    s.restore();
  }
});

test("помилка Notion при перевірці задачі не видається за видалення", async () => {
  const s = setup([taskPage(1), taskPage(2)]);
  const original = global.fetch;
  try {
    await plans.fixPlan(FIX);
    s.tasks.delete("2");
    const fake = global.fetch;
    global.fetch = async (url, opts) => {
      if (String(url).endsWith("/pages/2")) return { ok: false, status: 502, json: async () => ({}), text: async () => "bad gateway" };
      return fake(url, opts);
    };
    await assert.rejects(plans.buildReconciliation("2026-12", USER, { today: "2026-12-31" }), /502/);
  } finally {
    global.fetch = original;
    s.restore();
  }
});
