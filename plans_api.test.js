"use strict";
/** API планів і звірки: справжня перевірка підпису Telegram, права, вхідні дані. */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const http = require("http");

const BOT_TOKEN = "123:test-token";
const EDITOR = 1001;
const VIEWER = 2002;
process.env.NOTION_TOKEN = "test";
process.env.NOTION_DATA_SOURCE_ID = "ds-tasks";
process.env.NOTION_PLANS_DS_ID = "ds-plans";
process.env.NOTION_PLAN_TASKS_DS_ID = "ds-plan-tasks";
process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
process.env.ALLOWED_USER_IDS = `${EDITOR},${VIEWER}`;
process.env.PLAN_EDITOR_IDS = String(EDITOR);

const plans = require("./plans");
const { app } = require("./server");
const { USER, taskPage, fakeNotion } = require("./fake_notion");

function initData(userId) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: userId, first_name: "Тест" }),
  });
  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  params.set("hash", crypto.createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}

/** Звичайний http, щоб запит до свого сервера не пройшов через підмінений fetch. */
function call(port, method, path, { user, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: encodeURI(path),
        headers: {
          "Content-Type": "application/json",
          ...(user ? { "X-Telegram-Init-Data": initData(user) } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch {
            /* не JSON */
          }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function withServer(tasks, fn) {
  plans._resetForTests();
  const store = fakeNotion(tasks);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    await fn(server.address().port, store);
  } finally {
    store.restore();
    await new Promise((r) => server.close(r));
  }
}

const today = plans.todayKyiv();
const MONTH = today.slice(0, 7);

function currentMonthTask(id, over = {}) {
  return taskPage(id, { start: `${MONTH}-10T09:00:00+02:00`, end: `${MONTH}-10T18:00:00+02:00`, ...over });
}

test("без підпису Telegram нові маршрути закриті", async () => {
  await withServer([], async (port) => {
    for (const [method, path] of [
      ["GET", "/api/me"],
      ["GET", `/api/plans?month=${MONTH}`],
      ["GET", `/api/plans/preview?month=${MONTH}&constructorId=${USER}`],
      ["GET", `/api/plans/versions?month=${MONTH}&constructorId=${USER}`],
      ["POST", "/api/plans/fix"],
      ["POST", "/api/plans/pdf"],
      ["POST", "/api/reconcile"],
      ["POST", "/api/reconcile/export"],
    ]) {
      const r = await call(port, method, path, { body: method === "POST" ? {} : null });
      assert.equal(r.status, 403, `${method} ${path}`);
    }
  });
});

test("/api/me: право фіксації лише у фіксуючих", async () => {
  await withServer([], async (port) => {
    assert.equal((await call(port, "GET", "/api/me", { user: EDITOR })).json.canFixPlans, true);
    const viewer = await call(port, "GET", "/api/me", { user: VIEWER });
    assert.equal(viewer.json.canFixPlans, false);
    assert.equal(viewer.json.currentMonth, MONTH);
  });
});

test("без права фіксації сервер відмовляє, план не створюється", async () => {
  await withServer([currentMonthTask(1)], async (port, store) => {
    const r = await call(port, "POST", "/api/plans/fix", { user: VIEWER, body: { month: MONTH, constructorId: USER } });
    assert.equal(r.status, 403);
    assert.equal(store.plans.size, 0);
  });
});

test("фіксація: версія 1, автор із підпису, PDF у чат тому, хто натиснув", async () => {
  await withServer([currentMonthTask(1)], async (port, store) => {
    const r = await call(port, "POST", "/api/plans/fix", {
      user: EDITOR,
      body: { month: MONTH, constructorId: USER, fixedBy: "Підроблений автор", constructorName: "Підроблене ім'я" },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.status, "fixed");
    assert.equal(r.json.version, 1);
    assert.equal(r.json.pdfSent, true);
    const header = [...store.plans.values()][0];
    const by = header.properties["Зафіксував"].rich_text[0].text.content;
    assert.match(by, /Тест/);
    assert.match(by, /1001/);
    assert.doesNotMatch(by, /Підроблений/);
    assert.match(header.properties["Назва"].title[0].text.content, /· Тест ·/);
    assert.equal(store.documents.length, 1);
    assert.equal(store.documents[0].chatId, String(EDITOR));
  });
});

test("план збережено, але PDF не надіслано: відповідь це каже, план лишається", async () => {
  await withServer([currentMonthTask(1)], async (port, store) => {
    store.failTelegram = true;
    const r = await call(port, "POST", "/api/plans/fix", { user: EDITOR, body: { month: MONTH, constructorId: USER } });
    assert.equal(r.status, 200);
    assert.equal(r.json.version, 1);
    assert.equal(r.json.pdfSent, false);
    assert.equal(store.plans.size, 1);
  });
});

test("повторний PDF береться зі збереженого плану, а не з поточних задач", async () => {
  await withServer([currentMonthTask(1)], async (port, store) => {
    await call(port, "POST", "/api/plans/fix", { user: EDITOR, body: { month: MONTH, constructorId: USER } });
    store.tasks.clear();
    const r = await call(port, "POST", "/api/plans/pdf", { user: VIEWER, body: { month: MONTH, constructorId: USER } });
    assert.equal(r.status, 200);
    assert.equal(store.documents.at(-1).chatId, String(VIEWER));
  });
});

test("минулий і далекий місяць зафіксувати не можна", async () => {
  await withServer([currentMonthTask(1)], async (port, store) => {
    for (const month of ["2020-01", "2099-01"]) {
      const r = await call(port, "POST", "/api/plans/fix", { user: EDITOR, body: { month, constructorId: USER } });
      assert.equal(r.status, 400, month);
    }
    assert.equal(store.plans.size, 0);
  });
});

test("неправильні місяць і конструктор відхиляються", async () => {
  await withServer([currentMonthTask(1)], async (port) => {
    const bad = [
      { month: "abc", constructorId: USER },
      { month: "2026-13", constructorId: USER },
      { constructorId: USER },
      { month: MONTH },
      { month: MONTH, constructorId: "../pages/x" },
      { month: MONTH, constructorId: { $ne: 1 } },
    ];
    for (const body of bad) {
      for (const path of ["/api/plans/fix", "/api/reconcile", "/api/plans/pdf"]) {
        const r = await call(port, "POST", path, { user: EDITOR, body });
        assert.equal(r.status, 400, `${path} ${JSON.stringify(body)}`);
      }
    }
    const r = await call(port, "GET", "/api/plans?month=abc", { user: EDITOR });
    assert.equal(r.status, 400);
  });
});

test("конструктор, якого немає в базі, не фіксується", async () => {
  await withServer([currentMonthTask(1)], async (port, store) => {
    const r = await call(port, "POST", "/api/plans/fix", {
      user: EDITOR,
      body: { month: MONTH, constructorId: "99999999-9999-4999-8999-999999999999" },
    });
    assert.equal(r.status, 400);
    assert.equal(store.plans.size, 0);
  });
});

test("звірка без плану: 404 із зрозумілим текстом", async () => {
  await withServer([currentMonthTask(1)], async (port) => {
    const r = await call(port, "POST", "/api/reconcile", { user: VIEWER, body: { month: MONTH, constructorId: USER } });
    assert.equal(r.status, 404);
    assert.match(r.json.error, /не зафіксовано/);
  });
});

test("повний шлях: фіксація, перелік, звірка, виїмка; перегляд доступний без права фіксації", async () => {
  await withServer([currentMonthTask(1), currentMonthTask(2)], async (port, store) => {
    const preview = await call(port, "GET", `/api/plans/preview?month=${MONTH}&constructorId=${USER}`, { user: VIEWER });
    assert.equal(preview.json.taskCount, 2);
    await call(port, "POST", "/api/plans/fix", { user: EDITOR, body: { month: MONTH, constructorId: USER } });

    const list = await call(port, "GET", `/api/plans?month=${MONTH}`, { user: VIEWER });
    assert.equal(list.json.find((x) => x.constructorId === USER).plan.version, 1);

    store.tasks.set("3", currentMonthTask(3));
    const rec = await call(port, "POST", "/api/reconcile", { user: VIEWER, body: { month: MONTH, constructorId: USER } });
    assert.equal(rec.status, 200);
    assert.deepEqual(rec.json.totals.planned, { count: 2, hours: 16 });
    assert.equal(rec.json.totals.added.count, 1);

    for (const format of ["pdf", "xlsx"]) {
      const before = store.documents.length;
      const r = await call(port, "POST", "/api/reconcile/export", { user: VIEWER, body: { month: MONTH, constructorId: USER, format } });
      assert.equal(r.status, 200, format);
      assert.equal(store.documents.length, before + 1);
    }
    const badFormat = await call(port, "POST", "/api/reconcile/export", { user: VIEWER, body: { month: MONTH, constructorId: USER, format: "exe" } });
    assert.equal(badFormat.status, 400);

    const versions = await call(port, "GET", `/api/plans/versions?month=${MONTH}&constructorId=${USER}`, { user: VIEWER });
    assert.equal(versions.json.length, 1);
  });
});

test("без PLAN_EDITOR_IDS фіксувати не може ніхто", async () => {
  const saved = process.env.PLAN_EDITOR_IDS;
  process.env.PLAN_EDITOR_IDS = "";
  try {
    await withServer([currentMonthTask(1)], async (port, store) => {
      const r = await call(port, "POST", "/api/plans/fix", { user: EDITOR, body: { month: MONTH, constructorId: USER } });
      assert.equal(r.status, 403);
      assert.equal(store.plans.size, 0);
    });
  } finally {
    process.env.PLAN_EDITOR_IDS = saved;
  }
});
