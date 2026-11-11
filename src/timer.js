// 计时器：全局最多一个 activeTimer；时长一律由 storage 中的时间戳推算，不依赖后台计数。
import { get, set, getTask, putTask, sessionMinutes } from './storage.js';

export async function getActiveTimer() {
  return get('activeTimer');
}

/** 结束当前 session（若有），返回 { taskId, session, minutes } 或 null */
export async function stopTimer() {
  const at = await getActiveTimer();
  if (!at) return null;
  await set('activeTimer', null);
  const end = new Date().toISOString();
  const session = { start: at.start, end };
  const task = await getTask(at.taskId);
  if (task) {
    task.sessions = [...(task.sessions || []), session];
    await putTask(task);
  }
  return { taskId: at.taskId, session, minutes: (new Date(end) - new Date(at.start)) / 60000 };
}

/** 开始计时；若另有任务在计时，先自动结束它 */
export async function startTimer(taskId) {
  const at = await getActiveTimer();
  if (at && at.taskId === taskId) return at;
  if (at) await stopTimer();
  const next = { taskId, start: new Date().toISOString(), warned: false };
  await set('activeTimer', next);
  return next;
}

/** 当前显示时长（秒）= 已有 sessions + 正在进行的部分 */
export function elapsedSeconds(task, activeTimer, now = Date.now()) {
  let sec = sessionMinutes(task.sessions) * 60;
  if (activeTimer && activeTimer.taskId === task.id) {
    sec += Math.max(0, now - new Date(activeTimer.start).getTime()) / 1000;
  }
  return sec;
}

export function badgeText(minutes) {
  const m = Math.floor(minutes);
  if (m < 100) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 10 ? `${h}h${String(m % 60).padStart(2, '0')}`.slice(0, 4) : `${h}h`;
}
