// 统计计算（纯函数，不涉及界面）
import { actualMinutes } from './storage.js';
import { dateKey, addDays, weekday, shanghaiDate } from './time.js';

const DAY = 86400000;

function median(arr) {
  const a = [...arr].sort((x, y) => x - y);
  const n = a.length;
  if (!n) return null;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

/** 某日所在周的周一 */
export function weekStart(date) {
  return addDays(date, -((weekday(date) + 6) % 7));
}

/** 有效样本：已完成、有 AI 估时、有实际耗时 */
function samples(tasks) {
  return tasks
    .filter((t) => t.status === 'done' && t.doneAt && t.estMinutes > 0)
    .map((t) => ({ t, actual: actualMinutes(t) }))
    .filter((x) => x.actual > 0)
    .map((x) => ({ ...x, ratio: x.actual / x.t.estMinutes }));
}

/** 1. 估时准确度：最近 weeks 周，每周"实际 ÷ AI 估算"的中位数 */
export function accuracyByWeek(tasks, weeks = 8, now = Date.now()) {
  const thisWeek = weekStart(dateKey(now));
  const out = [];
  for (let i = weeks - 1; i >= 0; i--) out.push({ week: addDays(thisWeek, -7 * i), ratios: [] });
  const idx = new Map(out.map((w, i) => [w.week, i]));
  for (const s of samples(tasks)) {
    const i = idx.get(weekStart(dateKey(s.t.doneAt)));
    if (i != null) out[i].ratios.push(s.ratio);
  }
  return out.map((w) => ({ week: w.week, median: median(w.ratios), n: w.ratios.length }));
}

/** 1. 偏差最大的任务（按 |ln(实际/估算)| 排序） */
export function biggestMisses(tasks, days = 30, n = 5, now = Date.now()) {
  const from = now - days * DAY;
  return samples(tasks)
    .filter((s) => new Date(s.t.doneAt).getTime() >= from)
    .sort((a, b) => Math.abs(Math.log(b.ratio)) - Math.abs(Math.log(a.ratio)))
    .slice(0, n)
    .map((s) => ({ task: s.t, est: s.t.estMinutes, actual: s.actual, ratio: s.ratio }));
}

/** 统计区间：从 (今天 - days + 1) 的 0 点（上海）到现在 */
export function rangeStart(days, now = Date.now()) {
  return shanghaiDate(addDays(dateKey(now), -(days - 1))).getTime();
}

/**
 * 2. 各科时间投入：区间内计时（含正在进行的部分），加上区间内完成、没有计时但手动填写了耗时的任务。
 * 返回 [{ subject, minutes, done, doneMinutes }]，按 minutes 降序。
 */
export function subjectTime(tasks, days, activeTimer = null, now = Date.now()) {
  const from = rangeStart(days, now);
  const clip = (s, e) => Math.max(0, Math.min(e, now) - Math.max(s, from)) / 60000;
  const by = {};
  const row = (s) => (by[s || '未分类'] ||= { subject: s || '未分类', minutes: 0, done: 0, doneMinutes: 0 });
  for (const t of tasks) {
    let m = 0;
    for (const s of t.sessions || []) m += clip(new Date(s.start).getTime(), new Date(s.end).getTime());
    if (activeTimer && activeTimer.taskId === t.id) m += clip(new Date(activeTimer.start).getTime(), now);
    const doneInRange = t.status === 'done' && t.doneAt && new Date(t.doneAt).getTime() >= from;
    const timed = (t.sessions || []).length > 0;
    if (doneInRange && !timed && t.manualMinutes > 0) m += t.manualMinutes;
    if (m > 0) row(t.subject).minutes += m;
    if (doneInRange) {
      const a = actualMinutes(t);
      if (a > 0) { const r = row(t.subject); r.done++; r.doneMinutes += a; }
    }
  }
  return Object.values(by).sort((a, b) => b.minutes - a.minutes);
}

/**
 * 3. 按时完成率：区间内完成、且有截止时间的任务。
 * 返回 { total, onTime, rate, avgLeadMs, bySubject: [{ subject, total, onTime, rate, avgLeadMs }] }
 * avgLeadMs 为按时完成的任务平均提前多久。
 */
export function onTimeStats(tasks, days, now = Date.now()) {
  const from = rangeStart(days, now);
  const agg = () => ({ total: 0, onTime: 0, lead: 0 });
  const all = agg();
  const by = {};
  for (const t of tasks) {
    if (t.status !== 'done' || !t.doneAt || !t.due) continue;
    const done = new Date(t.doneAt).getTime();
    if (done < from) continue;
    const lead = new Date(t.due).getTime() - done;
    const s = t.subject || '未分类';
    for (const a of [all, (by[s] ||= agg())]) {
      a.total++;
      if (lead >= 0) { a.onTime++; a.lead += lead; }
    }
  }
  const fin = (a) => ({
    total: a.total, onTime: a.onTime,
    rate: a.total ? a.onTime / a.total : null,
    avgLeadMs: a.onTime ? a.lead / a.onTime : null,
  });
  return {
    ...fin(all),
    bySubject: Object.entries(by)
      .map(([subject, a]) => ({ subject, ...fin(a) }))
      .sort((x, y) => (x.rate ?? 2) - (y.rate ?? 2) || y.total - x.total),
  };
}

/** 提前量 → "1天3小时" / "5小时" / "40分钟" */
export function fmtLead(ms) {
  if (ms == null) return '—';
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min}分钟`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}小时`;
  const d = Math.floor(hrs / 24), r = hrs % 24;
  return r ? `${d}天${r}小时` : `${d}天`;
}
