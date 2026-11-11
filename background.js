// 后台 service worker：可能随时被挂起，所有状态读写 storage，定时任务全部使用 chrome.alarms。
import { syncAll } from './src/sync.js';
import { estimatePending } from './src/ai.js';
import { getSettings, get, set, getTask } from './src/storage.js';
import { badgeText } from './src/timer.js';

const SYNC_ALARM = 'sync';
const TICK_ALARM = 'timerTick';

// ---------- 侧边栏：点击工具栏图标打开 ----------
function setupPanel() {
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}
setupPanel();

// ---------- 同步 ----------
async function scheduleSync() {
  const { syncIntervalMinutes } = await getSettings();
  const period = Math.max(5, Number(syncIntervalMinutes) || 120);
  const cur = await chrome.alarms.get(SYNC_ALARM);
  if (!cur || cur.periodInMinutes !== period) {
    await chrome.alarms.create(SYNC_ALARM, { delayInMinutes: period, periodInMinutes: period });
  }
}

async function runSync() {
  const res = await syncAll();
  if (res.skipped) return res;
  try {
    res.estimated = await estimatePending();
  } catch (e) {
    res.estimateError = e.message;
  }
  return res;
}

// ---------- 计时角标 ----------
async function refreshBadge() {
  const at = await get('activeTimer');
  if (!at) {
    await chrome.action.setBadgeText({ text: '' });
    await chrome.alarms.clear(TICK_ALARM);
    return;
  }
  const minutes = (Date.now() - new Date(at.start).getTime()) / 60000;
  await chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#ffffff' });
  await chrome.action.setBadgeText({ text: badgeText(minutes) });
  if (!(await chrome.alarms.get(TICK_ALARM))) {
    await chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 });
  }
  const { timerWarnMinutes } = await getSettings();
  if (!at.warned && minutes >= timerWarnMinutes) {
    const task = await getTask(at.taskId);
    // 重新读取，确认仍是同一个 session 再写 warned 标记
    const fresh = await get('activeTimer');
    if (fresh && fresh.start === at.start) {
      await set('activeTimer', { ...fresh, warned: true });
      chrome.notifications.create('timerWarn', {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: '计时已超过 ' + Math.floor(minutes) + ' 分钟',
        message: `「${task ? task.title : '任务'}」仍在计时，是否忘记停止？`,
        priority: 2,
      });
    }
  }
}

// ---------- 事件 ----------
chrome.runtime.onInstalled.addListener(async () => {
  setupPanel();
  const s = await get('settings');
  if (!s) await set('settings', await getSettings()); // 写入默认设置
  await scheduleSync();
  await refreshBadge();
  runSync().catch(() => {});
});

chrome.runtime.onStartup.addListener(async () => {
  await scheduleSync();
  await refreshBadge();
  runSync().catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) runSync().catch(() => {});
  else if (alarm.name === TICK_ALARM) refreshBadge();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.activeTimer) refreshBadge();
  if (changes.settings) {
    const o = changes.settings.oldValue || {}, n = changes.settings.newValue || {};
    if (o.syncIntervalMinutes !== n.syncIntervalMinutes) scheduleSync();
  }
});

chrome.notifications.onClicked.addListener((id) => {
  if (id === 'timerWarn') chrome.notifications.clear(id);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'sync') {
    runSync().then((r) => sendResponse({ ok: true, result: r }), (e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg?.type === 'estimate') {
    estimatePending().then((n) => sendResponse({ ok: true, count: n }), (e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  return false;
});
