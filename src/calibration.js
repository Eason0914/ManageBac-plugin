// 按科目计算校准系数：actual / est 的中位数。
import { sessionMinutes } from './storage.js';

const MIN_SAMPLES = 3;
const LO = 0.5, HI = 3;

function median(arr) {
  const a = [...arr].sort((x, y) => x - y);
  const n = a.length;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

/**
 * 返回 { [subject]: { factor, samples, timed, manual } }
 * 规则：已完成、actual > 0、有 estMinutes 的任务。
 * 手动补填的样本权重减半 —— 简化实现：计时样本 ≥3 条时只用计时样本，否则才纳入手动样本。
 */
export function computeCalibration(tasks) {
  const bySubject = {};
  for (const t of tasks) {
    if (t.status !== 'done' || !(t.estMinutes > 0)) continue;
    const subj = t.subject || '未分类';
    const b = (bySubject[subj] ||= { timed: [], manual: [] });
    const timed = sessionMinutes(t.sessions);
    if (timed > 0) b.timed.push(timed / t.estMinutes);
    else if (t.manualMinutes > 0) b.manual.push(t.manualMinutes / t.estMinutes);
  }
  const out = {};
  for (const [subj, b] of Object.entries(bySubject)) {
    const used = b.timed.length >= MIN_SAMPLES ? b.timed : [...b.timed, ...b.manual];
    let factor = 1;
    if (used.length >= MIN_SAMPLES) factor = Math.min(HI, Math.max(LO, median(used)));
    out[subj] = { factor, samples: used.length, timed: b.timed.length, manual: b.manual.length };
  }
  return out;
}

export function factorFor(calib, subject) {
  return calib[subject || '未分类']?.factor ?? 1;
}

/** 显示用的校准后估时 */
export function adjustedEst(task, calib) {
  if (!(task.estMinutes > 0)) return null;
  return Math.round(task.estMinutes * factorFor(calib, task.subject));
}
