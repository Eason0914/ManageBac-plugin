// DeepSeek 调用：估时、规划。
import { getSettings, getAllTasks, putTasks, actualMinutes, isBeforeTracking } from './storage.js';
import { toMin, hm, dateKey } from './time.js';

const ENDPOINT = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-chat';

export class AIError extends Error {}

async function chatJSON(messages, { temperature = 0.2 } = {}) {
  const { deepseekKey } = await getSettings();
  if (!deepseekKey) throw new AIError('尚未在设置页填写 DeepSeek API key');
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${deepseekKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature,
        response_format: { type: 'json_object' },
      }),
    });
  } catch (e) {
    throw new AIError('无法连接 DeepSeek：' + e.message);
  }
  if (!res.ok) {
    if (res.status === 401) throw new AIError('DeepSeek API key 无效（401）');
    if (res.status === 402) throw new AIError('DeepSeek 账户余额不足（402）');
    if (res.status === 429) throw new AIError('DeepSeek 请求过于频繁（429），稍后再试');
    throw new AIError(`DeepSeek 返回错误 ${res.status}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new AIError('DeepSeek 返回内容为空');
  try {
    return JSON.parse(content);
  } catch {
    const m = /\{[\s\S]*\}|\[[\s\S]*\]/.exec(content);
    if (m) return JSON.parse(m[0]);
    throw new AIError('DeepSeek 返回的不是合法 JSON');
  }
}

// ---------------- 估时 ----------------

function stripHtml(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function validEst(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 5 && n <= 300 ? n : 30;
}

/**
 * 给 estMinutes 为空的 todo 任务估时（已估过的不重复调用）。
 * 按科目分批，每批附上同科目最近 10 条已完成任务的"标题 → 实际耗时"。
 * 返回估时的任务数；没有 key 时直接返回 0。
 */
export async function estimatePending() {
  const settings = await getSettings();
  if (!settings.deepseekKey) return 0;
  const all = await getAllTasks();
  const pending = all.filter((t) => t.status === 'todo' && t.estMinutes == null && !isBeforeTracking(t, settings));
  if (!pending.length) return 0;

  const bySubject = {};
  for (const t of pending) (bySubject[t.subject || '未分类'] ||= []).push(t);

  let count = 0;
  for (const [subject, list] of Object.entries(bySubject)) {
    const examples = all
      .filter((t) => (t.subject || '未分类') === subject && t.status === 'done' && actualMinutes(t) > 0)
      .sort((a, b) => String(b.doneAt).localeCompare(String(a.doneAt)))
      .slice(0, 10)
      .map((t) => ({ title: t.title, actualMinutes: Math.round(actualMinutes(t)) }));

    for (let i = 0; i < list.length; i += 20) {
      const batch = list.slice(i, i + 20);
      const input = batch.map((t) => ({
        id: t.id,
        subject: t.subject,
        title: t.title,
        description: stripHtml(t.description).slice(0, 300),
      }));
      const messages = [
        {
          role: 'system',
          content:
            '你是一名帮助高中生（IB 课程）估算作业耗时的助手。根据作业标题和描述，估计一名普通学生专注完成所需的分钟数。' +
            '只输出 JSON，格式为 {"estimates":[{"id":"...","estMinutes":整数}]}，estMinutes 为 5 到 300 之间的整数。' +
            '如果某项看起来不是需要课后完成的作业（例如课堂活动、考试当天），给出较小的值。',
        },
        {
          role: 'user',
          content: JSON.stringify({
            reference_completed_tasks_same_subject: examples,
            tasks_to_estimate: input,
          }),
        },
      ];
      const out = await chatJSON(messages);
      const arr = Array.isArray(out) ? out : out.estimates || out.tasks || [];
      const map = new Map();
      for (const r of arr) if (r && r.id != null) map.set(String(r.id), r.estMinutes);

      // 重新读取最新任务再写入，避免覆盖期间的其他修改
      const fresh = await chrome.storage.local.get(batch.map((t) => 'task:' + t.id));
      const updated = [];
      for (const t of batch) {
        const cur = fresh['task:' + t.id];
        if (!cur || cur.estMinutes != null) continue;
        cur.estMinutes = validEst(map.get(String(t.id)));
        updated.push(cur);
      }
      await putTasks(updated);
      count += updated.length;
    }
  }
  return count;
}

// ---------------- 规划今天 ----------------

/**
 * slots: [{start:"19:00", end:"22:30"}]
 * tasks: [{ id, subject, title, due, adjustedEst }]
 * 返回 { blocks, unscheduled, note }，校验不通过时抛出 AIError。
 */
export async function planDay(slots, tasks) {
  const now = new Date();
  const messages = [
    {
      role: 'system',
      content:
        '你是一名学习规划助手，为高中生安排今天的作业时间。规则：\n' +
        '1. 截止时间越近越优先；已逾期的任务最优先。\n' +
        '2. 所有时间块必须完全位于给定的可用时段内，且不能早于当前时间。\n' +
        '3. 单个时间块不超过 90 分钟；大任务可以拆成多个块（同一 taskId 出现多次）。\n' +
        '4. 相邻时间块之间至少留 10 分钟休息；时间块不能重叠。\n' +
        '5. 每个任务总安排时长约等于其 adjustedEst（分钟）；排不下的任务放入 unscheduled。\n' +
        '6. taskId 必须原样使用给出的 id。时间用 24 小时制 "HH:MM"。\n' +
        '只输出 JSON：{"blocks":[{"taskId":"...","start":"HH:MM","end":"HH:MM"}],"unscheduled":["taskId"],"note":"一两句中文说明"}',
    },
    {
      role: 'user',
      content: JSON.stringify({
        today: dateKey(now),
        now: hm(now),
        timezone: 'Asia/Shanghai',
        availableSlots: slots,
        tasks,
      }),
    },
  ];
  const out = await chatJSON(messages, { temperature: 0.3 });
  return validatePlan(out, slots, tasks);
}

export function validatePlan(out, slots, tasks) {
  if (!out || !Array.isArray(out.blocks)) throw new AIError('返回结果缺少 blocks');
  const ids = new Set(tasks.map((t) => String(t.id)));
  const slotRanges = slots.map((s) => [toMin(s.start), toMin(s.end)]);
  const blocks = [];
  for (const b of out.blocks) {
    const id = String(b?.taskId ?? '');
    if (!ids.has(id)) throw new AIError(`时间块引用了不存在的任务：${id || '(空)'}`);
    const s = toMin(b.start), e = toMin(b.end);
    if (isNaN(s) || isNaN(e) || e <= s) throw new AIError(`时间块时间不合法：${b.start}–${b.end}`);
    if (!slotRanges.some(([a, z]) => s >= a && e <= z)) {
      throw new AIError(`时间块 ${b.start}–${b.end} 不在可用时段内`);
    }
    blocks.push({ taskId: id, start: b.start.padStart(5, '0'), end: b.end.padStart(5, '0'), _s: s, _e: e });
  }
  blocks.sort((x, y) => x._s - y._s);
  for (let i = 1; i < blocks.length; i++) {
    if (blocks[i]._s < blocks[i - 1]._e) {
      throw new AIError(`时间块重叠：${blocks[i - 1].start}–${blocks[i - 1].end} 与 ${blocks[i].start}–${blocks[i].end}`);
    }
  }
  const unscheduled = (Array.isArray(out.unscheduled) ? out.unscheduled : [])
    .map(String).filter((id) => ids.has(id));
  return {
    blocks: blocks.map(({ taskId, start, end }) => ({ taskId, start, end })),
    unscheduled,
    note: typeof out.note === 'string' ? out.note : '',
  };
}
