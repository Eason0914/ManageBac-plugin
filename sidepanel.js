import {
  getSettings, getAllTasks, getTask, putTask, deleteTask, newTask, get, set,
  getPlan, savePlan, actualMinutes, sessionMinutes, isTaskKey, isBeforeTracking,
} from './src/storage.js';
import { computeCalibration, adjustedEst, factorFor } from './src/calibration.js';
import { startTimer, stopTimer, elapsedSeconds, getActiveTimer } from './src/timer.js';
import { planDay } from './src/ai.js';
import {
  dateKey, hm, toMin, fmtDue, fmtMin, fmtClock, addDays, weekday, shanghaiDate,
} from './src/time.js';
import { h, toast, subjectColor, stripHtml } from './src/ui.js';
import {
  accuracyByWeek, biggestMisses, subjectTime, onTimeStats, fmtLead,
} from './src/stats.js';

const $ = (id) => document.getElementById(id);

const state = {
  tasks: [],
  settings: null,
  activeTimer: null,
  plan: null,
  calib: {},
  syncState: null,
  tab: 'tasks',
  showHidden: false,
  expanded: new Set(), // 展开描述的任务
  menus: new Set(),    // 展开操作菜单的任务
  syncing: false,
  statsRange: 7,   // 统计区间：7 或 30 天
};

const taskById = (id) => state.tasks.find((t) => t.id === id);

// ================= 加载 & 渲染 =================

async function load() {
  const [tasks, settings, activeTimer, plan, syncState] = await Promise.all([
    getAllTasks(), getSettings(), getActiveTimer(), getPlan(dateKey()), get('syncState'),
  ]);
  Object.assign(state, { tasks, settings, activeTimer, plan, syncState });
  state.calib = computeCalibration(tasks);
}

function render() {
  renderTop();
  renderTimerBar();
  if (state.tab === 'tasks') {
    renderPlan();
    renderList();
  } else {
    renderStats();
  }
  tick();
}

let renderQueued = false;
function scheduleRefresh() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(async () => {
    renderQueued = false;
    await load();
    render();
  }, 80);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const keys = Object.keys(changes);
  if (keys.some((k) => isTaskKey(k) || k.startsWith('plan:') ||
      ['activeTimer', 'settings', 'syncState'].includes(k))) {
    scheduleRefresh();
  }
});

// ---------- 顶部 ----------

function todayStats() {
  const today = dateKey();
  const planIds = new Set((state.plan?.blocks || []).map((b) => b.taskId));
  const ids = new Set();
  for (const t of state.tasks) {
    if (t.status === 'ignored' || t.status === 'removed' || isBeforeTracking(t, state.settings)) continue;
    const dueToday = t.due && dateKey(t.due) === today;
    const doneToday = t.status === 'done' && t.doneAt && dateKey(t.doneAt) === today;
    if (dueToday || doneToday || planIds.has(t.id)) ids.add(t.id);
  }
  let done = 0;
  for (const id of ids) if (taskById(id)?.status === 'done') done++;
  return { done, total: ids.size };
}

function renderTop() {
  const { done, total } = todayStats();
  $('todayRate').textContent = `${done}/${total}`;
  const s = state.syncState || {};
  const parts = [];
  if (state.syncing || s.running) parts.push('同步中…');
  else if (s.lastSync) parts.push(`上次同步 ${dateKey(s.lastSync) === dateKey() ? hm(s.lastSync) : fmtDue(s.lastSync)}`);
  else parts.push('尚未同步');
  if (!state.settings.feeds.length) parts.push('未配置 iCal 链接');
  if (!state.settings.deepseekKey) parts.push('未填写 DeepSeek key');
  const info = $('syncInfo');
  info.replaceChildren(parts.join(' · '));
  if (s.lastError && !s.running) {
    info.append(h('div', { class: 'error' }, '同步错误：' + s.lastError));
  }
  $('btnSync').disabled = state.syncing;
}

// ---------- 计时条 ----------

function renderTimerBar() {
  const at = state.activeTimer;
  const bar = $('timerBar');
  const task = at && taskById(at.taskId);
  if (!task) { bar.hidden = true; return; }
  bar.hidden = false;
  $('timerTitle').textContent = `${task.subject} · ${task.title}`;
}

function tick() {
  const at = state.activeTimer;
  const now = Date.now();
  if (at) {
    const task = taskById(at.taskId);
    if (task) $('timerClock').textContent = fmtClock(elapsedSeconds(task, at, now));
  }
  for (const el of document.querySelectorAll('[data-elapsed]')) {
    const task = taskById(el.dataset.elapsed);
    if (!task) continue;
    const sec = elapsedSeconds(task, at, now);
    el.textContent = sec > 0 ? '已用 ' + fmtClock(sec) : '';
  }
  for (const el of document.querySelectorAll('[data-today-total]')) {
    el.textContent = fmtMin(todayTimedMinutes(now));
  }
}

setInterval(tick, 1000);
// 每分钟重新渲染一次，让分组（逾期/今天）随时间变化
setInterval(() => { if (!document.querySelector('dialog[open]')) render(); }, 60000);

// ---------- 今日计划 ----------

function renderPlan() {
  const sec = $('planSection');
  const plan = state.plan;
  if (!plan || !plan.blocks) { sec.hidden = true; return; }
  sec.hidden = false;
  const nowMin = toMin(hm());
  const rows = plan.blocks.map((b) => {
    const t = taskById(b.taskId);
    const done = t?.status === 'done';
    const current = nowMin >= toMin(b.start) && nowMin < toMin(b.end);
    const timing = state.activeTimer?.taskId === b.taskId;
    return h('button', {
      class: `block${done ? ' done' : ''}${current ? ' current' : ''}${timing ? ' timing' : ''}`,
      style: { '--c': t ? colorOf(t.subject) : '#98a2b3' },
      title: t && t.status === 'todo' ? '点击开始计时' : '',
      onclick: () => { if (t && t.status === 'todo') onStart(t.id); },
    },
      h('span', { class: 'block-time' }, `${b.start}–${b.end}`),
      h('span', { class: 'block-title' }, t ? t.title : '(任务已删除)'),
      timing ? h('span', { class: 'dot' }, '●') : null,
    );
  });
  const unsched = (plan.unscheduled || []).map(taskById).filter(Boolean);
  sec.replaceChildren(...[
    h('div', { class: 'plan-head' },
      h('strong', {}, '今日计划'),
      h('span', { class: 'muted small' }, plan.availableSlots.map((s) => `${s.start}–${s.end}`).join('，')),
      h('button', { class: 'link', onclick: openPlanDialog }, '重新规划'),
    ),
    plan.note ? h('div', { class: 'plan-note small' }, plan.note) : null,
    rows.length ? h('div', { class: 'blocks' }, rows) : h('div', { class: 'muted small' }, '没有安排任何时间块。'),
    unsched.length
      ? h('div', { class: 'small unsched' }, '未排入：', unsched.map((t) => t.title).join('；'))
      : null,
  ].filter(Boolean));
}

// ---------- 任务列表 ----------

function groupTasks() {
  const now = Date.now();
  const today = dateKey();
  const weekEnd = addDays(today, (7 - weekday(today)) % 7); // 本周日
  const weekAgo = Date.now() - 7 * 86400000;
  const g = { overdue: [], today: [], week: [], later: [], done: [], hidden: [] };
  for (const t of state.tasks) {
    if (t.status === 'ignored' || t.status === 'removed' || isBeforeTracking(t, state.settings)) {
      if (state.showHidden) g.hidden.push(t);
      continue;
    }
    if (t.status === 'done') {
      if (t.doneAt && new Date(t.doneAt).getTime() >= weekAgo) g.done.push(t);
      continue;
    }
    if (!t.due) { g.later.push(t); continue; }
    const due = new Date(t.due).getTime();
    const dk = dateKey(t.due);
    if (due < now) g.overdue.push(t);
    else if (dk === today) g.today.push(t);
    else if (dk <= weekEnd) g.week.push(t);
    else g.later.push(t);
  }
  const byDue = (a, b) => (a.due || '9999').localeCompare(b.due || '9999');
  for (const k of ['overdue', 'today', 'week', 'later', 'hidden']) g[k].sort(byDue);
  g.done.sort((a, b) => String(b.doneAt).localeCompare(String(a.doneAt)));
  return g;
}

const colorOf = (subject) => subjectColor(subject, state.settings.feeds);

function subjectTag(subject) {
  return h('span', { class: 'subj', style: { '--c': colorOf(subject) } }, subject || '未分类');
}

function estLabel(t) {
  const adj = adjustedEst(t, state.calib);
  if (adj == null) {
    if (t.status !== 'todo') return null;
    return h('span', { class: 'est muted' }, state.settings.deepseekKey ? '估时中…' : '未估时');
  }
  const f = factorFor(state.calib, t.subject);
  return h('span', {
    class: 'est',
    title: f !== 1 ? `AI 估算 ${t.estMinutes}m × 校准系数 ${f.toFixed(2)}` : `AI 估算 ${t.estMinutes}m`,
  }, '预计 ' + fmtMin(adj));
}

function taskRow(t) {
  const timing = state.activeTimer?.taskId === t.id;
  const done = t.status === 'done';
  const pre = isBeforeTracking(t, state.settings);
  const hidden = t.status === 'ignored' || t.status === 'removed' || pre;
  const overdue = t.status === 'todo' && !pre && t.due && new Date(t.due) < new Date();

  const menuOpen = state.menus.has(t.id);
  const expanded = state.expanded.has(t.id);
  const desc = stripHtml(t.description);

  const actions = [];
  if (t.status === 'ignored') actions.push(h('button', { class: 'link', onclick: () => setStatus(t.id, 'todo') }, '取消忽略'));
  else if (t.status === 'removed') actions.push(h('button', { class: 'link', onclick: () => setStatus(t.id, 'todo') }, '恢复'));
  else if (!done) actions.push(h('button', { class: 'link', onclick: () => setStatus(t.id, 'ignored') }, '忽略'));
  if (t.source === 'manual') actions.push(h('button', { class: 'link', onclick: () => openTaskDialog(t) }, '编辑'));
  actions.push(h('button', { class: 'link', onclick: () => editActual(t) }, '修改耗时'));

  return h('div', {
    class: `task${done ? ' done' : ''}${timing ? ' timing' : ''}${hidden ? ' hidden-task' : ''}`,
    style: { '--c': colorOf(t.subject) },
  },
    h('input', {
      type: 'checkbox', class: 'check', checked: done, title: done ? '标记为未完成' : '标记为完成',
      onchange: (e) => onCheck(t.id, e.target.checked),
    }),
    h('div', { class: 'task-body' },
      h('div', { class: 'task-top' },
        h('span', { class: `due${overdue ? ' overdue' : ''}` }, fmtDue(t.due)),
        t.status === 'ignored' ? h('span', { class: 'badge' }, '已忽略') : null,
        t.status === 'removed' ? h('span', { class: 'badge' }, '已移除') : null,
        pre ? h('span', { class: 'badge' }, '记录前') : null,
        t.source === 'manual' ? h('span', { class: 'badge' }, '手动') : null,
      ),
      h('div', {
        class: 'title' + (desc ? ' has-desc' : ''),
        title: desc ? '点击展开/收起描述' : '',
        onclick: () => { if (!desc) return; toggleSet(state.expanded, t.id); render(); },
      }, t.title),
      expanded && desc ? h('div', { class: 'desc' }, desc) : null,
      h('div', { class: 'task-sub' },
        subjectTag(t.subject),
        estLabel(t),
        h('span', { class: 'elapsed', dataset: { elapsed: t.id } }),
        done && t.manualMinutes != null && sessionMinutes(t.sessions) === 0
          ? h('span', { class: 'muted' }, `手动填写 ${fmtMin(t.manualMinutes)}`) : null,
      ),
      menuOpen ? h('div', { class: 'menu' }, actions) : null,
    ),
    h('div', { class: 'task-actions' },
      !done && !hidden
        ? h('button', {
          class: `timer-btn${timing ? ' on' : ''}`,
          title: timing ? '暂停计时' : '开始计时',
          onclick: () => (timing ? onPause() : onStart(t.id)),
        }, timing ? '❚❚' : '▶')
        : null,
      h('button', {
        class: 'more-btn', title: '更多操作',
        onclick: () => { toggleSet(state.menus, t.id); render(); },
      }, '⋯'),
    ),
  );
}

function toggleSet(set, v) { set.has(v) ? set.delete(v) : set.add(v); }

function renderList() {
  const g = groupTasks();
  const list = $('taskList');
  const sections = [
    ['overdue', '逾期'], ['today', '今天'], ['week', '本周'], ['later', '以后'],
    ['done', '近 7 天已完成'], ['hidden', '已忽略 / 已移除 / 记录前'],
  ];
  const out = [];
  for (const [k, label] of sections) {
    if (!g[k].length) continue;
    out.push(h('section', { class: `group group-${k}` },
      h('h2', {}, label, h('span', { class: 'count' }, g[k].length)),
      g[k].map(taskRow),
    ));
  }
  if (!out.length) {
    out.push(h('div', { class: 'empty' },
      state.settings.feeds.length
        ? '暂无待办任务。'
        : h('span', {}, '还没有配置 ManageBac 日历链接。', h('button', { class: 'link', onclick: () => chrome.runtime.openOptionsPage() }, '去设置')),
    ));
  }
  list.replaceChildren(...out);
}

// ================= 操作 =================

async function onStart(taskId) {
  await startTimer(taskId);
  scheduleRefresh();
}

async function onPause() {
  await stopTimer();
  scheduleRefresh();
}

async function setStatus(id, status) {
  await updateAndRefresh(id, (t) => {
    t.status = status;
    if (status !== 'done') t.doneAt = null;
  });
}

async function updateAndRefresh(id, fn) {
  const t = await getTask(id);
  if (!t) return;
  fn(t);
  await putTask(t);
  scheduleRefresh();
}

/** 勾选完成 / 取消完成 */
async function onCheck(id, checked) {
  if (!checked) {
    await setStatus(id, 'todo');
    return;
  }
  let lastMin = 0;
  const at = await getActiveTimer();
  if (at && at.taskId === id) {
    const r = await stopTimer();
    lastMin = r ? r.minutes : 0;
  }
  const t = await getTask(id);
  if (!t) return;
  const warn = state.settings.timerWarnMinutes;
  const actual = actualMinutes(t);
  if (lastMin > warn || actual === 0) {
    const msg = actual === 0
      ? '做了大约多久？点一个快捷选项，或填写分钟数。'
      : `本次计时 ${fmtMin(lastMin)}，超过了 ${fmtMin(warn)}，是否忘记停止？可修改总耗时。`;
    const value = await askMinutes(msg, actual > 0 ? Math.round(actual) : '', adjustedEst(t, state.calib));
    if (value != null) applyActual(t, value);
  }
  t.status = 'done';
  t.doneAt = new Date().toISOString();
  await putTask(t);
  scheduleRefresh();
}

/** 把任务的实际耗时改为 value 分钟 */
function applyActual(t, value) {
  const sessions = t.sessions || [];
  if (!sessions.length || sessionMinutes(sessions) === 0) {
    t.manualMinutes = value;
    return;
  }
  // 有计时记录：通过截短/延长最后一个 session 来修正
  const prev = sessionMinutes(sessions.slice(0, -1));
  const last = sessions[sessions.length - 1];
  const lastLen = value - prev;
  if (lastLen > 0) {
    last.end = new Date(new Date(last.start).getTime() + lastLen * 60000).toISOString();
  } else {
    // 填写值比之前的计时还少：清掉计时，改用手动值
    t.sessions = [];
    t.manualMinutes = value;
  }
}

async function editActual(t) {
  const cur = actualMinutes(t);
  const value = await askMinutes(`当前记录 ${fmtMin(cur)}。修改为：`, cur > 0 ? Math.round(cur) : '');
  if (value == null) return;
  if ((await getActiveTimer())?.taskId === t.id) await stopTimer();
  const fresh = await getTask(t.id);
  if (!fresh) return;
  applyActual(fresh, value);
  await putTask(fresh);
  scheduleRefresh();
}

const QUICK_MINUTES = [15, 30, 45, 60, 90, 120];

function askMinutes(msg, prefill, est = null) {
  return new Promise((resolve) => {
    const dlg = $('dlgDone');
    const form = $('formDone');
    $('doneMsg').textContent = msg;
    form.minutes.value = prefill;
    // 快捷选项：点一下即确认
    const pick = (m) => { form.minutes.value = m; dlg.close('ok'); };
    const chips = [];
    if (est > 0) chips.push(h('button', { type: 'button', class: 'chip est-chip', onclick: () => pick(est) }, `≈ 预计 ${fmtMin(est)}`));
    for (const m of QUICK_MINUTES) chips.push(h('button', { type: 'button', class: 'chip', onclick: () => pick(m) }, fmtMin(m)));
    $('quickPicks').replaceChildren(...chips);
    dlg.returnValue = '';
    dlg.onclose = () => {
      const v = Math.round(Number(form.minutes.value));
      resolve(dlg.returnValue === 'ok' && v > 0 ? v : null);
    };
    dlg.showModal();
    form.minutes.focus();
  });
}

// ---------- 添加 / 编辑任务 ----------

let editingId = null;

function toLocalInput(iso) {
  if (!iso) return '';
  return `${dateKey(iso)}T${hm(iso)}`;
}

function openTaskDialog(task = null) {
  editingId = task ? task.id : null;
  const f = $('formTask');
  $('dlgTaskTitle').textContent = task ? '编辑任务' : '添加任务';
  f.title.value = task?.title || '';
  f.subject.value = task?.subject || '';
  f.due.value = task ? toLocalInput(task.due) : `${dateKey()}T23:59`;
  f.est.value = task?.estMinutes ?? '';
  f.description.value = task?.description || '';
  $('btnDeleteTask').hidden = !task;
  const subjects = new Set([
    ...state.settings.feeds.map((x) => x.subject),
    ...state.tasks.map((t) => t.subject),
  ].filter(Boolean));
  $('subjectList').replaceChildren(...[...subjects].map((s) => h('option', { value: s })));
  $('dlgTask').returnValue = '';
  $('dlgTask').showModal();
}

$('formTask').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  const f = e.target;
  const est = f.est.value === '' ? null : Math.round(Number(f.est.value));
  const fields = {
    title: f.title.value.trim(),
    subject: f.subject.value.trim(),
    due: f.due.value ? new Date(f.due.value + ':00+08:00').toISOString() : null,
    description: f.description.value,
  };
  if (editingId) {
    const t = await getTask(editingId);
    if (t) {
      Object.assign(t, fields);
      if (est !== t.estMinutes) t.estMinutes = est;
      await putTask(t);
    }
  } else {
    await putTask(newTask({ ...fields, estMinutes: est }));
  }
  if (est == null) chrome.runtime.sendMessage({ type: 'estimate' }).catch(() => {});
  scheduleRefresh();
});

$('btnDeleteTask').addEventListener('click', async () => {
  if (!editingId) return;
  if (!confirm('确定删除这个手动任务？')) return;
  if (state.activeTimer?.taskId === editingId) await set('activeTimer', null);
  await deleteTask(editingId);
  $('dlgTask').close();
  scheduleRefresh();
});

// ---------- 规划今天 ----------

function slotRow(slot = { start: '19:00', end: '22:30' }) {
  const row = h('div', { class: 'slot-row' },
    h('input', { type: 'time', class: 's', value: slot.start, required: true }),
    h('span', {}, '至'),
    h('input', { type: 'time', class: 'e', value: slot.end, required: true }),
    h('button', { type: 'button', class: 'icon-btn', title: '删除', onclick: () => row.remove() }, '×'),
  );
  return row;
}

async function openPlanDialog() {
  const last = (state.plan?.availableSlots) || (await get('lastSlots')) || [{ start: '19:00', end: '22:30' }];
  $('slotRows').replaceChildren(...last.map(slotRow));
  $('planError').hidden = true;
  $('btnPlanGo').textContent = '生成规划';
  $('btnPlanGo').disabled = false;
  $('dlgPlan').showModal();
}

function readSlots() {
  const slots = [...document.querySelectorAll('#slotRows .slot-row')].map((r) => ({
    start: r.querySelector('.s').value, end: r.querySelector('.e').value,
  }));
  if (!slots.length) throw new Error('请至少填写一个时段');
  for (const s of slots) {
    if (isNaN(toMin(s.start)) || isNaN(toMin(s.end)) || toMin(s.end) <= toMin(s.start)) {
      throw new Error(`时段 ${s.start || '?'}–${s.end || '?'} 不合法（结束必须晚于开始）`);
    }
  }
  slots.sort((a, b) => toMin(a.start) - toMin(b.start));
  for (let i = 1; i < slots.length; i++) {
    if (toMin(slots[i].start) < toMin(slots[i - 1].end)) throw new Error('时段之间有重叠');
  }
  return slots;
}

$('btnAddSlot').addEventListener('click', () => {
  const rows = document.querySelectorAll('#slotRows .slot-row');
  const lastEnd = rows.length ? rows[rows.length - 1].querySelector('.e').value : '19:00';
  const s = toMin(lastEnd) || 19 * 60;
  const pad = (n) => `${String(Math.floor(Math.min(n, 1439) / 60)).padStart(2, '0')}:${String(Math.min(n, 1439) % 60).padStart(2, '0')}`;
  $('slotRows').append(slotRow({ start: pad(s + 30), end: pad(s + 90) }));
});

$('formPlan').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault(); // 生成期间保持对话框打开
  const err = $('planError');
  err.hidden = true;
  let slots;
  try {
    slots = readSlots();
  } catch (x) {
    err.textContent = x.message; err.hidden = false; return;
  }
  await set('lastSlots', slots);
  const todo = state.tasks
    .filter((t) => t.status === 'todo' && !isBeforeTracking(t, state.settings))
    .sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'))
    .slice(0, 60)
    .map((t) => ({
      id: t.id, subject: t.subject, title: t.title,
      due: t.due ? `${dateKey(t.due)} ${hm(t.due)}` : null,
      adjustedEst: adjustedEst(t, state.calib) ?? 30,
    }));
  if (!todo.length) { err.textContent = '没有待办任务可以规划。'; err.hidden = false; return; }
  const btn = $('btnPlanGo');
  btn.disabled = true; btn.textContent = '规划中…';
  try {
    const res = await planDay(slots, todo);
    await savePlan({
      date: dateKey(), availableSlots: slots,
      blocks: res.blocks, unscheduled: res.unscheduled, note: res.note,
      createdAt: new Date().toISOString(),
    });
    $('dlgPlan').close();
    toast(`已生成 ${res.blocks.length} 个时间块`);
    scheduleRefresh();
  } catch (x) {
    err.textContent = (x.message || String(x)) + '。请重试。';
    err.hidden = false;
    btn.textContent = '重试';
  } finally {
    btn.disabled = false;
  }
});

// ================= 统计 =================

function todayTimedMinutes(now = Date.now()) {
  const start = shanghaiDate(dateKey(now)).getTime();
  const end = start + 86400000;
  let ms = 0;
  const clip = (s, e) => Math.max(0, Math.min(e, end) - Math.max(s, start));
  for (const t of state.tasks) {
    for (const s of t.sessions || []) ms += clip(new Date(s.start).getTime(), new Date(s.end).getTime());
  }
  if (state.activeTimer) ms += clip(new Date(state.activeTimer.start).getTime(), now);
  return ms / 60000;
}

async function renderStats() {
  const root = $('tabStats');
  const today = dateKey();
  const planIds = [...new Set((state.plan?.blocks || []).map((b) => b.taskId))];
  const planDone = planIds.filter((id) => taskById(id)?.status === 'done').length;
  const doneToday = state.tasks.filter((t) => t.status === 'done' && t.doneAt && dateKey(t.doneAt) === today).length;

  // 近 7 天每日完成数
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = addDays(today, -i);
    days.push({ d, n: state.tasks.filter((t) => t.status === 'done' && t.doneAt && dateKey(t.doneAt) === d).length });
  }
  const max = Math.max(1, ...days.map((x) => x.n));
  const chart = h('div', { class: 'bars' }, days.map(({ d, n }) =>
    h('div', { class: 'bar-col', title: `${d}：完成 ${n} 项` },
      h('div', { class: 'bar-n' }, n || ''),
      h('div', { class: 'bar-track' }, h('div', { class: 'bar' + (d === today ? ' today' : ''), style: { height: `${(n / max) * 100}%` } })),
      h('div', { class: 'bar-label' }, d === today ? '今天' : `周${'日一二三四五六'[weekday(d)]}`),
    )));

  // 按科目
  const subjects = new Set([
    ...state.settings.feeds.map((f) => f.subject),
    ...Object.keys(state.calib),
  ]);
  const rows = [...subjects].sort().map((s) => {
    const c = state.calib[s];
    return h('tr', {},
      h('td', {}, subjectTag(s)),
      h('td', { class: 'num' }, c ? c.factor.toFixed(2) : '1.00'),
      h('td', { class: 'num' }, c ? `${c.samples}` : '0'),
      h('td', { class: 'num muted' }, c ? `${c.timed} / ${c.manual}` : '0 / 0'),
    );
  });

  root.replaceChildren(
    h('section', { class: 'card' },
      h('h2', {}, '今日'),
      h('div', { class: 'kpis' },
        h('div', { class: 'kpi' }, h('div', { class: 'kpi-v' }, planIds.length ? `${planDone}/${planIds.length}` : '—'), h('div', { class: 'kpi-l' }, '计划完成')),
        h('div', { class: 'kpi' }, h('div', { class: 'kpi-v' }, doneToday), h('div', { class: 'kpi-l' }, '今日完成')),
        h('div', { class: 'kpi' }, h('div', { class: 'kpi-v', dataset: { todayTotal: '1' } }, fmtMin(todayTimedMinutes())), h('div', { class: 'kpi-l' }, '总计时')),
      ),
    ),
    h('section', { class: 'card' }, h('h2', {}, '近 7 天完成数'), chart),
    accuracyCard(),
    rangeSwitch(),
    subjectTimeCard(),
    onTimeCard(),
    h('section', { class: 'card' },
      h('h2', {}, '按科目校准'),
      h('table', { class: 'calib' },
        h('thead', {}, h('tr', {}, h('th', {}, '科目'), h('th', { class: 'num' }, '系数'), h('th', { class: 'num' }, '样本'), h('th', { class: 'num' }, '计时/手动'))),
        h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colspan: 4, class: 'muted' }, '暂无数据'))),
      ),
      h('p', { class: 'muted small' }, '系数 = 实际耗时 ÷ AI 估算 的中位数；样本少于 3 条时为 1，范围 0.5–3。'),
    ),
  );
}

// ---------- 统计 1：估时准确度 ----------

function accuracyCard() {
  const weeks = accuracyByWeek(state.tasks, 8);
  const maxY = Math.max(2, Math.min(3, ...weeks.map((w) => w.median || 0)));
  const pct = (v) => `${(Math.min(v, maxY) / maxY) * 100}%`;
  const hasData = weeks.some((w) => w.n);
  const chart = h('div', { class: 'bars acc-chart' },
    weeks.map((w) => {
      const good = w.median != null && w.median >= 0.8 && w.median <= 1.25;
      const [, mo, da] = w.week.split('-');
      return h('div', { class: 'bar-col', title: w.n ? `${w.week} 起一周：中位数 ×${w.median.toFixed(2)}（${w.n} 项）` : `${w.week} 起一周：无数据` },
        h('div', { class: 'bar-n' }, w.median != null ? `×${w.median.toFixed(1)}` : ''),
        h('div', { class: 'bar-track' },
          h('div', { class: 'ref', style: { bottom: pct(1) } }),
          w.median != null ? h('div', { class: `bar ${good ? 'good' : 'off'}`, style: { height: pct(w.median) } }) : null),
        h('div', { class: 'bar-label' }, `${+mo}/${+da}`),
      );
    }),
  );
  const misses = biggestMisses(state.tasks, 30, 5);
  return h('section', { class: 'card' },
    h('h2', {}, '估时准确度'),
    h('p', { class: 'muted small card-sub' }, '每周"实际耗时 ÷ AI 估算"的中位数。虚线为 ×1.0（估得刚好），蓝色表示 0.8–1.25 之间，橙色表示偏差较大；大于 1 是低估。'),
    hasData ? chart : h('div', { class: 'muted small' }, '还没有足够数据：完成任务并记录耗时后会出现。'),
    misses.length ? h('div', { class: 'misses' },
      h('div', { class: 'mini-title' }, '近 30 天偏差最大'),
      misses.map((m) => h('div', { class: 'miss' },
        subjectTag(m.task.subject),
        h('span', { class: 'miss-title' }, m.task.title),
        h('span', { class: 'miss-v' }, `${fmtMin(m.est)} → ${fmtMin(m.actual)}`),
        h('span', { class: `miss-r ${m.ratio > 1 ? 'under' : 'over'}` }, `×${m.ratio.toFixed(1)}`),
      ))) : null,
  );
}

function rangeSwitch() {
  return h('div', { class: 'range-row' },
    h('span', { class: 'muted small' }, '以下统计区间'),
    h('div', { class: 'tabs' }, [7, 30].map((d) => h('button', {
      class: 'tab' + (state.statsRange === d ? ' active' : ''),
      onclick: () => { state.statsRange = d; render(); },
    }, `近 ${d} 天`))),
  );
}

// ---------- 统计 2：各科时间投入 ----------

function subjectTimeCard() {
  const rows = subjectTime(state.tasks, state.statsRange, state.activeTimer);
  const total = rows.reduce((a, r) => a + r.minutes, 0);
  const max = Math.max(1, ...rows.map((r) => r.minutes));
  return h('section', { class: 'card' },
    h('h2', {}, '各科时间投入', h('span', { class: 'h2-aside' }, `共 ${fmtMin(total)}`)),
    rows.length ? h('div', { class: 'st-rows' }, rows.map((r) => h('div', { class: 'st-row' },
      h('div', { class: 'st-head' },
        subjectTag(r.subject),
        h('span', { class: 'st-v' }, `${fmtMin(r.minutes)}`, h('span', { class: 'muted' }, ` · ${Math.round((r.minutes / total) * 100)}%`)),
      ),
      h('div', { class: 'st-track' }, h('div', { class: 'st-bar', style: { width: `${(r.minutes / max) * 100}%`, '--c': colorOf(r.subject) } })),
      h('div', { class: 'muted small' }, r.done ? `完成 ${r.done} 项 · 平均每项 ${fmtMin(r.doneMinutes / r.done)}` : '本区间没有完成的任务'),
    ))) : h('div', { class: 'muted small' }, '本区间还没有耗时记录。'),
  );
}

// ---------- 统计 3：按时完成率 ----------

function onTimeCard() {
  const s = onTimeStats(state.tasks, state.statsRange);
  const pct = (r) => (r == null ? '—' : `${Math.round(r * 100)}%`);
  return h('section', { class: 'card' },
    h('h2', {}, '按时完成率'),
    s.total ? h('div', {},
      h('div', { class: 'kpis two' },
        h('div', { class: 'kpi' }, h('div', { class: 'kpi-v' }, pct(s.rate)), h('div', { class: 'kpi-l' }, `${s.onTime}/${s.total} 项在截止前完成`)),
        h('div', { class: 'kpi' }, h('div', { class: 'kpi-v' }, fmtLead(s.avgLeadMs)), h('div', { class: 'kpi-l' }, '平均提前')),
      ),
      h('table', { class: 'calib' },
        h('thead', {}, h('tr', {}, h('th', {}, '科目'), h('th', { class: 'num' }, '按时率'), h('th', { class: 'num' }, '项数'), h('th', { class: 'num' }, '平均提前'))),
        h('tbody', {}, s.bySubject.map((r) => h('tr', {},
          h('td', {}, subjectTag(r.subject)),
          h('td', { class: 'num' + (r.rate != null && r.rate < 0.8 ? ' warn' : '') }, pct(r.rate)),
          h('td', { class: 'num' }, r.total),
          h('td', { class: 'num muted' }, fmtLead(r.avgLeadMs)),
        ))),
      ),
    ) : h('div', { class: 'muted small' }, '本区间还没有带截止时间的已完成任务。'),
  );
}

// ================= 事件绑定 =================

$('btnSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('btnAdd').addEventListener('click', () => openTaskDialog());
$('btnPlan').addEventListener('click', openPlanDialog);
$('timerPause').addEventListener('click', onPause);
$('timerDone').addEventListener('click', () => { if (state.activeTimer) onCheck(state.activeTimer.taskId, true); });
$('showHidden').addEventListener('change', (e) => { state.showHidden = e.target.checked; render(); });

$('btnSync').addEventListener('click', async () => {
  if (!state.settings.feeds.length) {
    toast('请先在设置页添加 iCal 链接', { error: true });
    return;
  }
  state.syncing = true;
  renderTop();
  try {
    const r = await chrome.runtime.sendMessage({ type: 'sync' });
    if (!r?.ok) throw new Error(r?.error || '同步失败');
    const x = r.result;
    if (x.skipped) toast('已有同步在进行中');
    else {
      let msg = `同步完成：新增 ${x.added}，更新 ${x.updated}，移除 ${x.removed}`;
      if (x.resubjected) msg += `，${x.resubjected} 项改归正确科目`;
      if (x.estimated) msg += `，估时 ${x.estimated} 项`;
      toast(msg, { error: !!x.errors.length });
      if (x.estimateError) setTimeout(() => toast('AI 估时失败：' + x.estimateError, { error: true }), 3600);
    }
  } catch (e) {
    toast(e.message, { error: true });
  } finally {
    state.syncing = false;
    scheduleRefresh();
  }
});

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    state.tab = tab.dataset.tab;
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
    $('tabTasks').hidden = state.tab !== 'tasks';
    $('tabStats').hidden = state.tab !== 'stats';
    render();
  });
}

await load();
render();
