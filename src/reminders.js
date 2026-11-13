// 今日计划的自动提醒：每个时间块开始/结束时各一条系统通知。
// 状态全部从 storage 读取（闹钟名与通知 id 中带上日期和时间块序号），不依赖 service worker 内存。
import { getSettings, getPlan, getTask, putTask, actualMinutes, sessionMinutes } from './storage.js';
import { getActiveTimer, startTimer, stopTimer } from './timer.js';
import { dateKey, shanghaiDate, toMin, fmtMin } from './time.js';

const PREFIX = 'plan|';           // 闹钟与通知 id：plan|start|2026-11-13|0
const ICON = 'icons/icon128.png';

const parse = (name) => {
  const [p, kind, date, idx] = String(name).split('|');
  if (p + '|' !== PREFIX || !['start', 'end'].includes(kind)) return null;
  return { kind, date, idx: Number(idx) };
};

/** 重新为某天的计划安排提醒闹钟（会清掉旧的计划闹钟） */
export async function scheduleReminders(date = dateKey()) {
  for (const a of await chrome.alarms.getAll()) {
    if (a.name.startsWith(PREFIX)) await chrome.alarms.clear(a.name);
  }
  const settings = await getSettings();
  if (settings.planReminders === false) return 0;
  const plan = await getPlan(date);
  if (!plan?.blocks?.length) return 0;
  const now = Date.now();
  let n = 0;
  for (const [i, b] of plan.blocks.entries()) {
    for (const [kind, t] of [['start', b.start], ['end', b.end]]) {
      const when = shanghaiDate(date, t).getTime();
      if (when > now + 1000) {
        await chrome.alarms.create(`${PREFIX}${kind}|${date}|${i}`, { when });
        n++;
      }
    }
  }
  return n;
}

/** 某任务在当日计划中、到 upToMin 为止已结束的时间块总时长（分钟） */
function plannedMinutes(plan, taskId, upToMin) {
  let m = 0;
  for (const b of plan.blocks) {
    if (b.taskId !== taskId) continue;
    const s = toMin(b.start), e = toMin(b.end);
    if (e <= upToMin) m += e - s;
  }
  return m;
}

async function load(info) {
  const plan = await getPlan(info.date);
  const block = plan?.blocks?.[info.idx];
  if (!block) return {};
  const task = await getTask(block.taskId);
  return { plan, block, task };
}

function notify(id, title, message, buttons) {
  return chrome.notifications.create(id, {
    type: 'basic', iconUrl: ICON, title, message,
    buttons: buttons.map((t) => ({ title: t })),
    requireInteraction: true, priority: 2,
  });
}

/** 闹钟触发。返回是否已处理（供后台判断） */
export async function handleReminderAlarm(name) {
  const info = parse(name);
  if (!info) return false;
  if (info.date !== dateKey()) return true; // 过期的闹钟
  const settings = await getSettings();
  if (settings.planReminders === false) return true;
  const { plan, block, task } = await load(info);
  if (!task || task.status !== 'todo') return true;
  const at = await getActiveTimer();
  const timingThis = at?.taskId === task.id;
  const range = `${block.start}–${block.end}`;

  if (info.kind === 'start') {
    if (timingThis) return true;
    let msg = `${range}　${task.subject}`;
    if (at) {
      const other = await getTask(at.taskId);
      msg += `\n开始后会结束正在计时的「${other ? other.title : '任务'}」`;
    }
    await notify(name, `现在做：${task.title}`, msg, ['开始计时', '稍后']);
  } else {
    if (timingThis) {
      await notify(name, `时间块结束：${task.title}`, `${range} 已结束，正在计时。`, ['完成', '暂停计时']);
    } else {
      const planned = plannedMinutes(plan, task.id, toMin(block.end));
      const hasRecord = actualMinutes(task) > 0;
      const btn = hasRecord ? '已完成' : `已完成（记 ${fmtMin(planned)}）`;
      await notify(name, `做完了吗：${task.title}`, `${range} 的时间块已结束。`, [btn, '还没']);
    }
  }
  return true;
}

async function markDone(task, fallbackMinutes) {
  if (actualMinutes(task) === 0 && fallbackMinutes > 0) task.manualMinutes = fallbackMinutes;
  task.status = 'done';
  task.doneAt = new Date().toISOString();
  await putTask(task);
}

/** 通知按钮被点击。返回是否属于本模块 */
export async function handleReminderButton(id, buttonIndex) {
  const info = parse(id);
  if (!info) return false;
  chrome.notifications.clear(id);
  const { plan, block, task } = await load(info);
  if (!task || task.status !== 'todo') return true;

  if (info.kind === 'start') {
    if (buttonIndex === 0) await startTimer(task.id);
    return true;
  }
  // 结束提醒
  const at = await getActiveTimer();
  if (at?.taskId === task.id) {
    await stopTimer();
    if (buttonIndex === 0) {
      const fresh = await getTask(task.id);
      if (fresh) await markDone(fresh, 0);
    }
    return true;
  }
  if (buttonIndex === 0) {
    const planned = plannedMinutes(plan, task.id, toMin(block.end));
    // 没有任何耗时记录时，用计划时长作为手动耗时
    await markDone(task, sessionMinutes(task.sessions) > 0 ? 0 : planned);
  }
  return true;
}

/** 点击通知正文：只关闭通知（避免误触开始计时） */
export async function handleReminderClick(id) {
  const info = parse(id);
  if (!info) return false;
  chrome.notifications.clear(id);
  return true;
}
