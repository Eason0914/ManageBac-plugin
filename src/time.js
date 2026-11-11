// 时间工具：时区固定为 Asia/Shanghai（UTC+8，无夏令时）。
export const TZ = 'Asia/Shanghai';

const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});
const hmFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/** 某时刻在上海的日期 "YYYY-MM-DD" */
export function dateKey(d = new Date()) {
  return dateFmt.format(new Date(d));
}

/** 某时刻在上海的 "HH:MM" */
export function hm(d = new Date()) {
  return hmFmt.format(new Date(d));
}

/** 上海某日某时 → Date */
export function shanghaiDate(date, time = '00:00') {
  return new Date(`${date}T${time.length === 5 ? time + ':00' : time}+08:00`);
}

/** "HH:MM" → 分钟数 */
export function toMin(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
  if (!m) return NaN;
  const h = +m[1], mi = +m[2];
  if (h > 24 || mi > 59 || (h === 24 && mi > 0)) return NaN;
  return h * 60 + mi;
}

/** 分钟数 → "HH:MM" */
export function fromMin(n) {
  const h = Math.floor(n / 60), m = n % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 日期加减天数（基于 "YYYY-MM-DD"） */
export function addDays(date, n) {
  const d = shanghaiDate(date, '12:00');
  d.setUTCDate(d.getUTCDate() + n);
  return dateKey(d);
}

/** 上海日期的星期几（0=周日） */
export function weekday(date) {
  return shanghaiDate(date, '12:00').getUTCDay();
}

/** 某 IANA 时区在某时刻相对 UTC 的偏移（毫秒） */
function tzOffsetMs(tz, utcMs) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const x of f.formatToParts(new Date(utcMs))) p[x.type] = x.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - utcMs;
}

/** 某时区的墙上时间 → Date；时区无法识别时按上海处理 */
export function wallTimeToDate(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let zone = tz || TZ;
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); } catch { zone = TZ; }
  let off = tzOffsetMs(zone, guess);
  let ms = guess - off;
  const off2 = tzOffsetMs(zone, ms); // 处理夏令时边界
  if (off2 !== off) ms = guess - off2;
  return new Date(ms);
}

/** 便于显示的截止时间，例如 "11/15 周日 08:00" */
export function fmtDue(iso) {
  if (!iso) return '无截止';
  const d = new Date(iso);
  const key = dateKey(d);
  const [, mo, da] = key.split('-');
  const wd = '日一二三四五六'[weekday(key)];
  return `${+mo}/${+da} 周${wd} ${hm(d)}`;
}

/** 分钟 → "1h05m" / "25m" */
export function fmtMin(min) {
  if (min == null || isNaN(min)) return '—';
  min = Math.round(min);
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}m`;
}

/** 秒 → "H:MM:SS" */
export function fmtClock(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
