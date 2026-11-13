// iCal 拉取、解析、合并。
import ICAL from '../lib/ical.js';
import { getSettings, getAllTasks, putTasks, get, set } from './storage.js';
import { wallTimeToDate } from './time.js';

const LOCK_TTL_MS = 3 * 60 * 1000;

export function normalizeUrl(url) {
  url = String(url || '').trim();
  if (/^webcals?:\/\//i.test(url)) url = url.replace(/^webcals?:\/\//i, 'https://');
  return url;
}

/** DTSTART → ISO。全天事件视为当天 23:59（上海）；无时区/未知时区按上海时间处理。 */
function dtToIso(t, prop) {
  if (!t) return null;
  if (t.isDate) return wallTimeToDate(t.year, t.month, t.day, 23, 59, 0, 'Asia/Shanghai').toISOString();
  if (t.zone && t.zone.tzid === 'UTC') return t.toJSDate().toISOString();
  const tzid = prop?.getParameter('tzid') || t.timezone || 'Asia/Shanghai';
  return wallTimeToDate(t.year, t.month, t.day, t.hour, t.minute, t.second, tzid).toISOString();
}

export function parseIcs(text) {
  const comp = new ICAL.Component(ICAL.parse(text));
  const events = [];
  for (const v of comp.getAllSubcomponents('vevent')) {
    const uid = v.getFirstPropertyValue('uid');
    if (!uid) continue;
    const dtProp = v.getFirstProperty('dtstart');
    const dt = dtProp ? dtProp.getFirstValue() : null;
    events.push({
      uid: String(uid),
      title: String(v.getFirstPropertyValue('summary') || '(无标题)').trim(),
      description: String(v.getFirstPropertyValue('description') || ''),
      due: dtToIso(dt, dtProp),
    });
  }
  return events;
}

async function fetchFeed(url) {
  const res = await fetch(normalizeUrl(url), { cache: 'no-store', credentials: 'omit' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('返回内容不是 iCal 日历（链接可能已失效）');
  return parseIcs(text);
}

function matchesIgnore(title, keywords) {
  return (keywords || []).some((k) => k && title.includes(k));
}

/**
 * 同步全部 feed。返回 { added, updated, removed, errors }。
 * 同一时间只运行一次（storage 锁，带超时）。
 */
export async function syncAll() {
  const state = (await get('syncState')) || {};
  if (state.running && Date.now() - state.startedAt < LOCK_TTL_MS) {
    return { skipped: true };
  }
  await set('syncState', { ...state, running: true, startedAt: Date.now() });

  const result = { added: 0, updated: 0, removed: 0, restored: 0, resubjected: 0, errors: [] };
  try {
    const settings = await getSettings();
    const feedStatus = (await get('feedStatus')) || {};
    // uid → { ev, subject, size }：同一作业出现在多个订阅里（例如一个"全部科目"的总订阅）时，
    // 归到事件数最少、也就是最具体的那个订阅的科目
    const seen = new Map();
    const okSubjects = new Set();

    for (const feed of settings.feeds) {
      if (!feed.url) continue;
      const now = new Date().toISOString();
      try {
        const events = await fetchFeed(feed.url);
        for (const ev of events) {
          const prev = seen.get(ev.uid);
          if (!prev || events.length < prev.size) seen.set(ev.uid, { ev, subject: feed.subject, size: events.length });
        }
        okSubjects.add(feed.subject);
        feedStatus[feed.subject] = { lastSync: now, ok: true, error: null, count: events.length };
      } catch (e) {
        const msg = e?.message || String(e);
        result.errors.push(`${feed.subject}：${msg}`);
        feedStatus[feed.subject] = { ...(feedStatus[feed.subject] || {}), lastAttempt: now, ok: false, error: msg };
      }
    }
    // 清理已删除科目的状态
    for (const k of Object.keys(feedStatus)) {
      if (!settings.feeds.some((f) => f.subject === k)) delete feedStatus[k];
    }
    await set('feedStatus', feedStatus);

    const tasks = await getAllTasks();
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const changed = [];
    const nowIso = new Date().toISOString();

    for (const [uid, { ev, subject }] of seen) {
      const t = byId.get(uid);
      if (!t) {
        changed.push({
          id: uid,
          source: 'ical',
          subject,
          title: ev.title,
          description: ev.description,
          due: ev.due,
          estMinutes: null,
          status: matchesIgnore(ev.title, settings.ignoreKeywords) ? 'ignored' : 'todo',
          doneAt: null,
          sessions: [],
          manualMinutes: null,
          createdAt: nowIso,
          updatedAt: nowIso,
        });
        result.added++;
        continue;
      }
      let dirty = false;
      if (t.title !== ev.title) { t.title = ev.title; dirty = true; }
      if (t.description !== ev.description) { t.description = ev.description; dirty = true; }
      if (t.due !== ev.due) { t.due = ev.due; dirty = true; }
      if (t.subject !== subject) { t.subject = subject; dirty = true; result.resubjected++; }
      if (t.status === 'removed') { t.status = 'todo'; dirty = true; result.restored++; }
      if (dirty) { changed.push(t); result.updated++; }
    }

    // 不再出现、且截止在未来的 iCal 任务 → removed（只针对本次成功拉取的科目，避免网络失败误判）
    const now = Date.now();
    for (const t of tasks) {
      if (t.source !== 'ical' || seen.has(t.id)) continue;
      if (!okSubjects.has(t.subject)) continue;
      if (t.status === 'removed' || t.status === 'done') continue;
      if (t.due && new Date(t.due).getTime() > now) {
        t.status = 'removed';
        changed.push(t);
        result.removed++;
      }
    }

    await putTasks(changed);
    await set('syncState', {
      running: false, startedAt: 0, lastSync: nowIso,
      lastError: result.errors.length ? result.errors.join('；') : null,
      lastResult: { added: result.added, updated: result.updated, removed: result.removed },
    });
  } catch (e) {
    await set('syncState', { ...state, running: false, startedAt: 0, lastError: e?.message || String(e) });
    throw e;
  }
  return result;
}
