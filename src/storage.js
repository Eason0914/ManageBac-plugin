// chrome.storage.local 读写封装。
// 存储布局：
//   settings            设置
//   task:<id>           每个任务单独一个 key，避免后台同步和面板同时写时互相覆盖
//   activeTimer         { taskId, start, warned? } | null
//   plan:<YYYY-MM-DD>   当日规划
//   lastSlots           上次填写的可用时段
//   feedStatus          { [subject]: { lastSync, ok, error, count } }
//   syncState           { running, startedAt, lastSync, lastError }

import { dateKey, shanghaiDate } from './time.js';

const area = chrome.storage.local;
const TASK_PREFIX = 'task:';
const PLAN_PREFIX = 'plan:';

export const DEFAULT_SETTINGS = {
  feeds: [],
  deepseekKey: '',
  syncIntervalMinutes: 120,
  timerWarnMinutes: 180,
  planReminders: true,         // 今日计划时间块开始/结束时提醒
  ignoreKeywords: ['课堂纪律', '课堂表现', '出勤', '小组活动', '耐力与体能', '技术', '理论'],
};

export async function get(key, fallback = null) {
  const r = await area.get(key);
  return r[key] === undefined ? fallback : r[key];
}

export async function set(key, value) {
  await area.set({ [key]: value });
}

export async function remove(key) {
  await area.remove(key);
}

// ---------- settings ----------
export async function getSettings() {
  const s = await get('settings', {});
  const merged = { ...DEFAULT_SETTINGS, ...s };
  // 开始记录日期：首次读取时固定为当天，此前截止的 iCal 作业视为"记录前"的历史任务
  if (!merged.trackFrom) {
    merged.trackFrom = dateKey();
    await set('settings', merged);
  }
  return merged;
}

/** iCal 任务的截止时间早于"开始记录日期"且仍为 todo → 不算逾期、不参与规划/估时/统计 */
export function isBeforeTracking(task, settings) {
  if (task.source !== 'ical' || task.status !== 'todo' || !task.due || !settings?.trackFrom) return false;
  return new Date(task.due) < shanghaiDate(settings.trackFrom);
}

export async function saveSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await set('settings', next);
  return next;
}

// ---------- tasks ----------
export const taskKey = (id) => TASK_PREFIX + id;
export const isTaskKey = (k) => k.startsWith(TASK_PREFIX);

export async function getAllTasks() {
  const all = await area.get(null);
  return Object.keys(all).filter(isTaskKey).map((k) => all[k]);
}

export async function getTask(id) {
  return get(taskKey(id));
}

export async function putTask(task) {
  task.updatedAt = new Date().toISOString();
  await set(taskKey(task.id), task);
  return task;
}

export async function putTasks(tasks) {
  if (!tasks.length) return;
  const now = new Date().toISOString();
  const obj = {};
  for (const t of tasks) { t.updatedAt = now; obj[taskKey(t.id)] = t; }
  await area.set(obj);
}

/** 读取—修改—写回单个任务。fn 返回 false 表示不写入。 */
export async function updateTask(id, fn) {
  const t = await getTask(id);
  if (!t) return null;
  if (fn(t) === false) return t;
  return putTask(t);
}

export async function deleteTask(id) {
  await remove(taskKey(id));
}

export function newTask(fields) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    source: 'manual',
    subject: '',
    title: '',
    description: '',
    due: null,
    estMinutes: null,
    status: 'todo',
    doneAt: null,
    sessions: [],
    manualMinutes: null,
    createdAt: now,
    updatedAt: now,
    ...fields,
  };
}

// ---------- 派生值 ----------
export function sessionMinutes(sessions) {
  let ms = 0;
  for (const s of sessions || []) ms += Math.max(0, new Date(s.end) - new Date(s.start));
  return ms / 60000;
}

/** 实际耗时（分钟）：计时之和；若为 0 且有手动补填则取手动值 */
export function actualMinutes(task) {
  const m = sessionMinutes(task.sessions);
  if (m > 0) return m;
  return task.manualMinutes != null ? task.manualMinutes : 0;
}

// ---------- plans ----------
export const planKey = (date) => PLAN_PREFIX + date;

export async function getPlan(date) {
  return get(planKey(date));
}

export async function savePlan(plan) {
  await set(planKey(plan.date), plan);
}

export async function getAllPlans() {
  const all = await area.get(null);
  return Object.keys(all).filter((k) => k.startsWith(PLAN_PREFIX)).map((k) => all[k]);
}

// ---------- 导出 / 导入 ----------
export async function exportData({ includeFeeds = false } = {}) {
  const settings = await getSettings();
  const { deepseekKey, feeds, ...rest } = settings; // key 永不导出
  const out = {
    app: 'managebac-planner',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: includeFeeds ? { ...rest, feeds } : rest,
    tasks: await getAllTasks(),
    plans: await getAllPlans(),
    lastSlots: await get('lastSlots'),
  };
  return out;
}

/** 合并导入：同 id 任务/同日期规划被覆盖；不会清空现有数据；不会改动 API key。 */
export async function importData(data) {
  if (!data || data.app !== 'managebac-planner' || !Array.isArray(data.tasks)) {
    throw new Error('不是有效的 ManageBac Planner 导出文件');
  }
  const obj = {};
  let nTasks = 0, nPlans = 0;
  for (const t of data.tasks) {
    if (!t || !t.id || !t.title) continue;
    obj[taskKey(t.id)] = { sessions: [], manualMinutes: null, ...t };
    nTasks++;
  }
  for (const p of data.plans || []) {
    if (!p || !p.date) continue;
    obj[planKey(p.date)] = p;
    nPlans++;
  }
  if (Array.isArray(data.lastSlots)) obj.lastSlots = data.lastSlots;
  const cur = await getSettings();
  const inc = { ...(data.settings || {}) };
  delete inc.deepseekKey;
  if (!Array.isArray(inc.feeds)) delete inc.feeds;
  obj.settings = { ...cur, ...inc, deepseekKey: cur.deepseekKey };
  await area.set(obj);
  return { nTasks, nPlans, feeds: Array.isArray(data.settings?.feeds) };
}
