import {
  getSettings, saveSettings, get, getAllTasks, putTasks, exportData, importData,
} from './src/storage.js';
import { normalizeUrl } from './src/sync.js';
import { dateKey, hm, fmtDue } from './src/time.js';
import { h, toast } from './src/ui.js';

const $ = (id) => document.getElementById(id);

function fmtTime(iso) {
  if (!iso) return '';
  return dateKey(iso) === dateKey() ? '今天 ' + hm(iso) : fmtDue(iso);
}

// ---------------- feeds ----------------

function statusEl(status) {
  if (!status) return h('span', { class: 'muted' }, '未同步');
  if (status.ok) return h('span', { class: 'feed-status ok' }, `✓ ${fmtTime(status.lastSync)}（${status.count} 条）`);
  return h('span', { class: 'feed-status err' },
    `✗ ${fmtTime(status.lastAttempt)} ${status.error}`,
    status.lastSync ? h('div', { class: 'muted' }, `上次成功：${fmtTime(status.lastSync)}`) : null);
}

function feedRow(feed = { subject: '', url: '' }, status = null) {
  const row = h('tr', { dataset: { orig: feed.subject } },
    h('td', {}, h('input', { class: 'subject', value: feed.subject, placeholder: '如：数学 AA', maxlength: 50 })),
    h('td', {}, h('input', {
      class: 'url', type: 'password', value: feed.url, placeholder: 'webcal://xxx.managebac.cn/...',
      spellcheck: 'false', autocomplete: 'off',
      onfocus: (e) => { e.target.type = 'text'; },
      onblur: (e) => { e.target.type = 'password'; },
    })),
    h('td', { class: 'status-cell' }, statusEl(status)),
    h('td', {}, h('button', { class: 'icon-btn', title: '删除', onclick: () => row.remove() }, '×')),
  );
  return row;
}

async function renderFeeds() {
  const settings = await getSettings();
  const status = (await get('feedStatus')) || {};
  const rows = settings.feeds.map((f) => feedRow(f, status[f.subject]));
  if (!rows.length) rows.push(feedRow());
  $('feedRows').replaceChildren(...rows);
}

function readFeeds() {
  const feeds = [];
  const renames = [];
  const names = new Set();
  for (const tr of $('feedRows').querySelectorAll('tr')) {
    const subject = tr.querySelector('.subject').value.trim();
    const url = tr.querySelector('.url').value.trim();
    if (!subject && !url) continue;
    if (!subject) throw new Error('有链接缺少科目名');
    if (!url) throw new Error(`「${subject}」缺少 iCal 链接`);
    if (names.has(subject)) throw new Error(`科目名「${subject}」重复`);
    names.add(subject);
    let u;
    try { u = new URL(normalizeUrl(url)); } catch { throw new Error(`「${subject}」的链接格式不正确`); }
    if (u.protocol !== 'https:') throw new Error(`「${subject}」的链接必须以 https:// 或 webcal:// 开头`);
    if (!/(^|\.)managebac\.cn$/i.test(u.hostname)) {
      throw new Error(`「${subject}」的链接域名是 ${u.hostname}，插件只被授权访问 *.managebac.cn`);
    }
    feeds.push({ subject, url });
    const orig = tr.dataset.orig;
    if (orig && orig !== subject) renames.push([orig, subject]);
  }
  return { feeds, renames };
}

async function saveFeeds() {
  const { feeds, renames } = readFeeds();
  await saveSettings({ feeds });
  // 改名的科目：同步更新已有任务，保持历史数据与校准连续
  if (renames.length) {
    const map = new Map(renames);
    const tasks = (await getAllTasks()).filter((t) => map.has(t.subject));
    for (const t of tasks) t.subject = map.get(t.subject);
    await putTasks(tasks);
  }
  await renderFeeds();
}

$('btnAddFeed').addEventListener('click', () => $('feedRows').append(feedRow()));

$('btnSaveFeeds').addEventListener('click', async () => {
  try {
    await saveFeeds();
    toast('订阅已保存');
  } catch (e) {
    toast(e.message, { error: true });
  }
});

$('btnSyncNow').addEventListener('click', async () => {
  const btn = $('btnSyncNow');
  try {
    await saveFeeds();
    btn.disabled = true; btn.textContent = '同步中…';
    const r = await chrome.runtime.sendMessage({ type: 'sync' });
    if (!r?.ok) throw new Error(r?.error || '同步失败');
    if (r.result.skipped) toast('已有同步在进行中');
    else {
      const x = r.result;
      toast(`同步完成：新增 ${x.added}，更新 ${x.updated}，移除 ${x.removed}` +
        (x.errors.length ? `；${x.errors.length} 个订阅失败` : ''), { error: !!x.errors.length });
    }
  } catch (e) {
    toast(e.message, { error: true });
  } finally {
    btn.disabled = false; btn.textContent = '立即同步';
    renderFeeds();
  }
});

// ---------------- DeepSeek key ----------------

$('btnShowKey').addEventListener('click', () => {
  const k = $('key');
  k.type = k.type === 'password' ? 'text' : 'password';
  $('btnShowKey').textContent = k.type === 'password' ? '显示' : '隐藏';
});

$('key').addEventListener('change', async () => {
  await saveSettings({ deepseekKey: $('key').value.trim() });
  toast('API key 已保存');
  if ($('key').value.trim()) chrome.runtime.sendMessage({ type: 'estimate' }).catch(() => {});
});

$('btnTestKey').addEventListener('click', async () => {
  const key = $('key').value.trim();
  if (!key) return toast('请先填写 API key', { error: true });
  await saveSettings({ deepseekKey: key });
  try {
    const res = await fetch('https://api.deepseek.com/models', { headers: { Authorization: `Bearer ${key}` } });
    if (res.ok) toast('连接成功，key 有效');
    else toast(res.status === 401 ? 'key 无效（401）' : `DeepSeek 返回 ${res.status}`, { error: true });
  } catch (e) {
    toast('无法连接 DeepSeek：' + e.message, { error: true });
  }
});

// ---------------- 常规 ----------------

async function renderGeneral() {
  const s = await getSettings();
  $('key').value = s.deepseekKey || '';
  $('syncInterval').value = s.syncIntervalMinutes;
  $('warnMinutes').value = s.timerWarnMinutes;
  $('trackFrom').value = s.trackFrom;
  $('ignoreKeywords').value = (s.ignoreKeywords || []).join('\n');
}

$('btnSaveGeneral').addEventListener('click', async () => {
  const si = Math.round(Number($('syncInterval').value));
  const wm = Math.round(Number($('warnMinutes').value));
  if (!(si >= 5 && si <= 1440)) return toast('同步间隔需在 5–1440 分钟之间', { error: true });
  if (!(wm >= 10 && wm <= 1440)) return toast('计时提醒阈值需在 10–1440 分钟之间', { error: true });
  const trackFrom = $('trackFrom').value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trackFrom)) return toast('请填写开始记录日期', { error: true });
  const kws = $('ignoreKeywords').value.split(/\n|,|，/).map((x) => x.trim()).filter(Boolean);
  await saveSettings({ syncIntervalMinutes: si, timerWarnMinutes: wm, ignoreKeywords: kws, trackFrom });
  toast('已保存');
});

// ---------------- 导出 / 导入 ----------------

$('btnExport').addEventListener('click', async () => {
  const data = await exportData({ includeFeeds: $('exportFeeds').checked });
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `managebac-planner-${dateKey()}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast(`已导出 ${data.tasks.length} 个任务`);
});

$('btnImport').addEventListener('click', () => $('importFile').click());

$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const n = Array.isArray(data?.tasks) ? data.tasks.length : 0;
    if (!confirm(`将导入 ${n} 个任务（同 ID 的任务会被覆盖）。继续？`)) return;
    const r = await importData(data);
    toast(`导入完成：${r.nTasks} 个任务，${r.nPlans} 个规划${r.feeds ? '，含订阅链接' : ''}`);
    await renderFeeds();
    await renderGeneral();
  } catch (x) {
    toast('导入失败：' + x.message, { error: true });
  }
});

// 后台同步后只刷新状态列，不覆盖正在编辑的输入框
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.feedStatus) return;
  const st = changes.feedStatus.newValue || {};
  for (const tr of $('feedRows').querySelectorAll('tr')) {
    const subj = tr.dataset.orig;
    if (subj) tr.querySelector('.status-cell').replaceChildren(statusEl(st[subj]));
  }
});

await renderFeeds();
await renderGeneral();
