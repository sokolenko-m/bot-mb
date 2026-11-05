"use strict";
/**
 * Разово відновлює план місяця з резервної копії Notion, якщо місяць уже почався.
 * Запуск з ноутбука, потрібні NOTION_TOKEN, NOTION_DATA_SOURCE_ID, NOTION_PLANS_DS_ID, NOTION_PLAN_TASKS_DS_ID.
 *
 *   node scripts/import_plan_from_backup.js --backup=<папка копії> --month=2026-11 --note="Відновлено з резервної копії 30.10"
 *
 * Без --write лише показує, що буде записано. Повторний запуск версій не множить.
 */
const fs = require("fs");
const path = require("path");
const { parseTaskPage, resolveObjectNames, queryAll } = require("../notion");
const { parseMonth } = require("../month");
const { kyivDateStr } = require("../dates");
const { ABSENCE_RE } = require("../report");

/** Сторінки задач із файлів копії. Одна база може лежати в кількох файлах, тому без повторів. */
function readBackupTaskPages(backupDir, dataSourceId) {
  const dir = path.join(backupDir, "databases");
  const pages = new Map();
  for (const file of fs.readdirSync(dir)) {
    const db = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    for (const ds of db.dataSources || []) {
      if (ds.schema?.id !== dataSourceId) continue;
      for (const row of ds.rows) pages.set(row.page.id, row.page);
    }
  }
  return [...pages.values()];
}

/** Групує задачі місяця за конструктором, правило те саме, що у звіті: «Начало» в межах місяця. */
function groupMonthTasks(pages, month, numberById = new Map()) {
  const { monthStart, monthEndExclusive } = parseMonth(month);
  const groups = new Map();
  for (const page of pages) {
    if (page.in_trash || page.archived) continue;
    const task = parseTaskPage(page);
    const day = kyivDateStr(task.start);
    if (!day || day < monthStart || day >= monthEndExclusive) continue;
    for (const person of page.properties["Конструктор"]?.people || []) {
      if (!groups.has(person.id)) groups.set(person.id, { constructorId: person.id, constructorName: (person.name || "").trim(), tasks: [] });
      groups.get(person.id).tasks.push({ ...task, taskNumber: numberById.get(task.id) || "" });
    }
  }
  return [...groups.values()];
}

function toPlanTask(t) {
  return {
    pageId: t.id,
    taskNumber: t.taskNumber,
    title: t.title,
    objectName: t.objectName || "—",
    taskType: t.taskType || "",
    order: t.order ?? null,
    plannedHours: t.plannedHours || 0,
    start: t.start,
    end: t.end,
    createdTime: t.createdTime || null,
    isAbsence: ABSENCE_RE.test(t.title || ""),
  };
}

function arg(name) {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : null;
}

async function main() {
  const backup = arg("backup");
  const month = arg("month");
  const note = arg("note") || "Відновлено з резервної копії";
  const write = process.argv.includes("--write");
  if (!backup || !month) throw new Error("Потрібні --backup і --month");

  const live = await queryAll();
  const numberById = new Map(
    live.map((p) => {
      const id = p.properties["№ задачі"]?.unique_id;
      return [p.id, id ? `${id.prefix ? `${id.prefix}-` : ""}${id.number}` : ""];
    })
  );
  const pages = readBackupTaskPages(backup, process.env.NOTION_DATA_SOURCE_ID);
  console.log(`Задач у копії: ${pages.length}. Режим: ${write ? "ЗАПИС" : "перегляд, без запису"}`);

  const groups = groupMonthTasks(pages, month, numberById);
  const { fixPlan } = require("../plans");
  for (const group of groups) {
    await resolveObjectNames(group.tasks);
    const tasks = group.tasks.map(toPlanTask);
    const work = tasks.filter((t) => !t.isAbsence);
    const hours = Math.round(work.reduce((s, t) => s + t.plannedHours, 0) * 100) / 100;
    const noNumber = tasks.filter((t) => !t.taskNumber).length;
    let result = "";
    if (write) {
      const r = await fixPlan({
        month,
        constructorId: group.constructorId,
        constructorName: group.constructorName,
        fixedBy: "Імпорт із резервної копії",
        tasks,
        source: "Резервна копія",
        note,
      });
      result = ` → ${r.status}, версія ${r.version}`;
    }
    console.log(`${group.constructorName}: задач ${work.length}, годин ${hours}, відсутностей ${tasks.length - work.length}, без номера ${noNumber}${result}`);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}

module.exports = { readBackupTaskPages, groupMonthTasks, toPlanTask };
