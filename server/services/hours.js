// Wall hours: every minute maps to exactly one mode.
// Priority: fullscreen one-shot → Manual URL → Regular Hours dashboard → black.
// All times are the wall machine's local clock (the box that runs the dashboard).

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HH_MM_RE = /^\d{2}:\d{2}$/;
const LOCAL_DT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

const DEFAULT_REGULAR_HOURS = [{ days: ['Sun'], start: '09:00', end: '15:00' }];
const DEFAULT_MANUAL = { enabled: false, url: '' };
const DEFAULT_FULLSCREEN = { file: null, startAt: null, endAt: null };
const DEFAULT_SYNC_SCHEDULE = {
  defaultIntervalMinutes: 180,
  windows: [{ days: ['Sun'], start: '08:10', end: '14:00', intervalMinutes: 15 }],
};

const MODE_LABELS = {
  fullscreen: 'Fullscreen image',
  manual: 'Manual URL',
  playlist: 'Dashboard',
  off: 'Black screen',
};

function cloneWindow(w) {
  return { days: [...w.days], start: w.start, end: w.end };
}

function cloneSyncWindow(w) {
  return {
    days: [...w.days],
    start: w.start,
    end: w.end,
    intervalMinutes: w.intervalMinutes,
  };
}

function positiveInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.round(n);
}

function normalizeClock(value) {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function parseTimeToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function parseLocalDateTime(value) {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(LOCAL_DT_RE);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const s = Number(m[6] || 0);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const dt = new Date(y, mo - 1, d, h, mi, s, 0);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt;
}

function formatLocalDateTime(date) {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${mo}-${d}T${h}:${mi}`;
}

function formatClock12(hhmm) {
  const [hRaw, mRaw] = hhmm.split(':').map(Number);
  const ampm = hRaw >= 12 ? 'pm' : 'am';
  const h12 = hRaw % 12 || 12;
  return mRaw ? `${h12}:${String(mRaw).padStart(2, '0')}${ampm}` : `${h12}${ampm}`;
}

function formatMinutes12(min) {
  const wrapped = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return formatClock12(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
}

function normalizeRegularHours(raw) {
  if (!Array.isArray(raw)) return DEFAULT_REGULAR_HOURS.map(cloneWindow);
  return raw
    .map((w) => ({
      days: Array.isArray(w.days) ? w.days.filter((d) => DAY_NAMES.includes(d)) : [],
      start: normalizeClock(w && w.start),
      end: normalizeClock(w && w.end),
    }))
    .filter((w) => w.start && w.end);
}

function normalizeManual(raw) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_MANUAL };
  const url = typeof raw.url === 'string' ? raw.url.trim() : '';
  return {
    enabled: raw.enabled === true && url.length > 0,
    url,
  };
}

function normalizeFullscreen(raw) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_FULLSCREEN };
  const file = typeof raw.file === 'string' && raw.file.trim() ? raw.file.trim() : null;
  const start = parseLocalDateTime(raw.startAt);
  const end = parseLocalDateTime(raw.endAt);
  return {
    file,
    startAt: start ? formatLocalDateTime(start) : null,
    endAt: end ? formatLocalDateTime(end) : null,
  };
}

function isWithinWindow(window, now = new Date()) {
  if (!window || !window.start || !window.end) return false;
  if (!Array.isArray(window.days) || window.days.length === 0) return false;
  const today = DAY_NAMES[now.getDay()];
  if (!window.days.includes(today)) return false;
  if (!HH_MM_RE.test(window.start) || !HH_MM_RE.test(window.end)) return false;
  const startMinutes = parseTimeToMinutes(window.start);
  const endMinutes = parseTimeToMinutes(window.end);
  if (endMinutes <= startMinutes) return false;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  return nowMinutes >= startMinutes && nowMinutes < endMinutes;
}

function isRegularHours(windows, now = new Date()) {
  return Array.isArray(windows) && windows.some((w) => isWithinWindow(w, now));
}

function isFullscreenActive(fullscreen, now = new Date()) {
  if (!fullscreen || !fullscreen.startAt || !fullscreen.endAt) return false;
  const start = parseLocalDateTime(fullscreen.startAt);
  const end = parseLocalDateTime(fullscreen.endAt);
  if (!start || !end || end <= start) return false;
  return now >= start && now < end;
}

function computeMode(config, now = new Date()) {
  if (isFullscreenActive(config && config.fullscreen, now)) return 'fullscreen';
  if (config && config.manual && config.manual.enabled) return 'manual';
  if (isRegularHours(config && config.regularHours, now)) return 'playlist';
  return 'off';
}

function windowsOverlap(a, b) {
  const daysA = new Set(a.days || []);
  if (!(b.days || []).some((d) => daysA.has(d))) return false;
  const a0 = parseTimeToMinutes(a.start);
  const a1 = parseTimeToMinutes(a.end);
  const b0 = parseTimeToMinutes(b.start);
  const b1 = parseTimeToMinutes(b.end);
  return a0 < b1 && b0 < a1;
}

function validateRegularHours(windows) {
  if (!Array.isArray(windows)) return { error: 'regular hours must be an array' };
  const normalized = [];
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i] || {};
    const start = normalizeClock(w.start);
    const end = normalizeClock(w.end);
    if (!start || !end) return { error: `window ${i + 1}: start and end must be HH:MM` };
    if (parseTimeToMinutes(end) <= parseTimeToMinutes(start)) {
      return { error: `window ${i + 1}: end must be after start (no overnight)` };
    }
    if (!Array.isArray(w.days) || w.days.length === 0) {
      return { error: `window ${i + 1}: pick at least one day` };
    }
    if (w.days.some((d) => !DAY_NAMES.includes(d))) {
      return { error: `window ${i + 1}: days must be ${DAY_NAMES.join(', ')}` };
    }
    normalized.push({ days: [...new Set(w.days)], start, end });
  }
  for (let i = 0; i < normalized.length; i++) {
    for (let j = i + 1; j < normalized.length; j++) {
      if (windowsOverlap(normalized[i], normalized[j])) {
        return { error: `windows ${i + 1} and ${j + 1} overlap` };
      }
    }
  }
  return { ok: true, windows: normalized };
}

function isHttpUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function validateManual({ enabled, url }) {
  if (typeof enabled !== 'boolean') return { error: 'enabled must be true or false' };
  const trimmed = typeof url === 'string' ? url.trim() : '';
  if (enabled && !trimmed) return { error: 'URL is required when Manual is on' };
  if (trimmed && !isHttpUrl(trimmed)) return { error: 'URL must start with http:// or https://' };
  return { ok: true, manual: { enabled, url: trimmed } };
}

function normalizeSyncSchedule(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      defaultIntervalMinutes: DEFAULT_SYNC_SCHEDULE.defaultIntervalMinutes,
      windows: DEFAULT_SYNC_SCHEDULE.windows.map(cloneSyncWindow),
    };
  }
  const defaultIntervalMinutes = positiveInt(raw.defaultIntervalMinutes)
    || DEFAULT_SYNC_SCHEDULE.defaultIntervalMinutes;
  if (!Array.isArray(raw.windows)) {
    return {
      defaultIntervalMinutes,
      windows: DEFAULT_SYNC_SCHEDULE.windows.map(cloneSyncWindow),
    };
  }
  const windows = raw.windows
    .map((w) => ({
      days: Array.isArray(w.days) ? w.days.filter((d) => DAY_NAMES.includes(d)) : [],
      start: normalizeClock(w && w.start),
      end: normalizeClock(w && w.end),
      intervalMinutes: positiveInt(w && w.intervalMinutes),
    }))
    .filter((w) => w.start && w.end && w.intervalMinutes);
  return { defaultIntervalMinutes, windows };
}

function validateSyncSchedule({ defaultIntervalMinutes, windows }) {
  const def = positiveInt(defaultIntervalMinutes);
  if (!def) return { error: 'default interval must be a positive number of minutes' };
  if (!Array.isArray(windows)) return { error: 'windows must be an array' };
  const normalized = [];
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i] || {};
    const start = normalizeClock(w.start);
    const end = normalizeClock(w.end);
    const interval = positiveInt(w.intervalMinutes);
    if (!start || !end) return { error: `window ${i + 1}: start and end must be HH:MM` };
    if (parseTimeToMinutes(end) <= parseTimeToMinutes(start)) {
      return { error: `window ${i + 1}: end must be after start (no overnight)` };
    }
    if (!Array.isArray(w.days) || w.days.length === 0) {
      return { error: `window ${i + 1}: pick at least one day` };
    }
    if (w.days.some((d) => !DAY_NAMES.includes(d))) {
      return { error: `window ${i + 1}: days must be ${DAY_NAMES.join(', ')}` };
    }
    if (!interval) return { error: `window ${i + 1}: interval must be a positive number of minutes` };
    normalized.push({ days: [...new Set(w.days)], start, end, intervalMinutes: interval });
  }
  for (let i = 0; i < normalized.length; i++) {
    for (let j = i + 1; j < normalized.length; j++) {
      if (windowsOverlap(normalized[i], normalized[j])) {
        return { error: `windows ${i + 1} and ${j + 1} overlap` };
      }
    }
  }
  return { ok: true, syncSchedule: { defaultIntervalMinutes: def, windows: normalized } };
}

function syncIntervalAt(schedule, now = new Date()) {
  const sched = schedule && typeof schedule === 'object' ? schedule : DEFAULT_SYNC_SCHEDULE;
  for (const w of sched.windows || []) {
    if (isWithinWindow(w, now)) return w.intervalMinutes;
  }
  return sched.defaultIntervalMinutes || DEFAULT_SYNC_SCHEDULE.defaultIntervalMinutes;
}

function shouldSyncAt(schedule, now = new Date()) {
  const interval = syncIntervalAt(schedule, now);
  if (!interval || interval < 1) return false;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  return nowMinutes % interval === 0;
}

function formatIntervalLabel(minutes) {
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? 'every 1 hour' : `every ${hours} hours`;
  }
  return minutes === 1 ? 'every 1 minute' : `every ${minutes} minutes`;
}

function endOfCurrentSyncWindow(schedule, now) {
  for (const w of (schedule && schedule.windows) || []) {
    if (!isWithinWindow(w, now)) continue;
    const [h, m] = w.end.split(':').map(Number);
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
  }
  return null;
}

function nextSyncWindowStart(schedule, now) {
  let best = null;
  for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset);
    const dayName = DAY_NAMES[day.getDay()];
    for (const w of (schedule && schedule.windows) || []) {
      if (!w.days || !w.days.includes(dayName)) continue;
      const [h, m] = w.start.split(':').map(Number);
      const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0);
      if (start > now && (!best || start < best)) best = start;
    }
  }
  return best;
}

function describeSyncCadence(schedule, now = new Date()) {
  const interval = syncIntervalAt(schedule, now);
  const inWindow = endOfCurrentSyncWindow(schedule, now);
  const nextWindow = nextSyncWindowStart(schedule, now);
  let until;
  let untilLabel;
  if (inWindow) {
    until = inWindow;
    untilLabel = `until ${formatUntil(inWindow)}`;
  } else if (nextWindow) {
    until = nextWindow;
    untilLabel = `until ${formatUntil(nextWindow)}`;
  } else {
    untilLabel = 'all week';
  }
  return {
    intervalMinutes: interval,
    label: formatIntervalLabel(interval),
    until: until ? until.toISOString() : null,
    untilLabel,
    line: `Drive & Prayer refresh ${formatIntervalLabel(interval)} ${untilLabel}`,
  };
}

function validateFullscreen({ file, startAt, endAt }, availableNames) {
  if (typeof file !== 'string' || !file.trim()) return { error: 'Select a fullscreen image' };
  if (!availableNames.has(file)) return { error: 'file must exist in fullscreen_img' };
  const start = parseLocalDateTime(startAt);
  const end = parseLocalDateTime(endAt);
  if (!start) return { error: 'start date/time is required' };
  if (!end) return { error: 'end date/time is required' };
  if (end <= start) return { error: 'end must be after start' };
  return {
    ok: true,
    fullscreen: {
      file: file.trim(),
      startAt: formatLocalDateTime(start),
      endAt: formatLocalDateTime(end),
    },
  };
}

function upcomingFullscreenRange(fullscreen, now) {
  if (!fullscreen || !fullscreen.startAt || !fullscreen.endAt) return null;
  const start = parseLocalDateTime(fullscreen.startAt);
  const end = parseLocalDateTime(fullscreen.endAt);
  if (!start || !end || end <= start) return null;
  if (now >= end) return null;
  return { start, end };
}

function endOfCurrentRegularWindow(windows, now) {
  for (const w of windows || []) {
    if (!isWithinWindow(w, now)) continue;
    const [h, m] = w.end.split(':').map(Number);
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
  }
  return null;
}

function nextRegularHoursStart(windows, now) {
  let best = null;
  for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset);
    const dayName = DAY_NAMES[day.getDay()];
    for (const w of windows || []) {
      if (!w.days || !w.days.includes(dayName)) continue;
      const [h, m] = w.start.split(':').map(Number);
      const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0);
      if (start > now && (!best || start < best)) best = start;
    }
  }
  return best;
}

function nextTransitionAt(config, now = new Date()) {
  const mode = computeMode(config, now);
  const fs = upcomingFullscreenRange(config.fullscreen, now);
  const candidates = [];

  if (mode === 'fullscreen' && fs) {
    candidates.push(fs.end);
  } else {
    if (fs && fs.start > now) candidates.push(fs.start);
    if (mode === 'playlist') {
      const end = endOfCurrentRegularWindow(config.regularHours, now);
      if (end) candidates.push(end);
    } else if (mode === 'off') {
      const next = nextRegularHoursStart(config.regularHours, now);
      if (next) candidates.push(next);
    }
  }

  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (a < b ? a : b));
}

function formatUntil(date) {
  return date.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function describeNow(config, now = new Date()) {
  const mode = computeMode(config, now);
  const until = nextTransitionAt(config, now);
  let untilLabel;
  if (mode === 'manual' && !until) {
    untilLabel = 'until you turn Manual off';
  } else if (until) {
    untilLabel = `until ${formatUntil(until)}`;
  } else {
    untilLabel = 'until the next scheduled change';
  }

  return {
    mode,
    label: MODE_LABELS[mode] || mode,
    until: until ? until.toISOString() : null,
    untilLabel,
    showingLine: `Wall is showing ${MODE_LABELS[mode] || mode} ${untilLabel}`,
    manualOn: !!(config.manual && config.manual.enabled),
    manualBanner: config.manual && config.manual.enabled
      ? 'Manual URL is on — Regular Hours are ignored until you turn it off. Fullscreen still wins if its window is active.'
      : null,
  };
}

function wallClock(now = new Date()) {
  return {
    iso: now.toISOString(),
    local: now.toLocaleString(undefined, {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short',
    }),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    minutes: now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60,
  };
}

function segmentsForDay(dayStart, config) {
  const modes = new Array(1440);
  for (let min = 0; min < 1440; min++) {
    const t = new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate(), 0, min, 0, 0);
    modes[min] = computeMode(config, t);
  }

  const segments = [];
  let i = 0;
  while (i < 1440) {
    const mode = modes[i];
    let j = i + 1;
    while (j < 1440 && modes[j] === mode) j += 1;
    segments.push({
      startMin: i,
      endMin: j,
      mode,
      label: MODE_LABELS[mode] || mode,
    });
    i = j;
  }
  return segments;
}

function daySummary(segments) {
  if (segments.length === 1 && segments[0].startMin === 0 && segments[0].endMin === 1440) {
    return `${segments[0].label} all day`;
  }
  return segments
    .map((s) => `${s.label} ${formatMinutes12(s.startMin)}–${formatMinutes12(s.endMin)}`)
    .join(' · ');
}

function weekPreview(config, now = new Date()) {
  const days = [];
  for (let d = 0; d < 7; d++) {
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d);
    const segments = segmentsForDay(dayStart, config);
    days.push({
      date: formatLocalDateTime(dayStart).slice(0, 10),
      dayName: DAY_NAMES[dayStart.getDay()],
      isToday: d === 0,
      segments,
      summary: daySummary(segments),
    });
  }
  return days;
}

module.exports = {
  DAY_NAMES,
  HH_MM_RE,
  MODE_LABELS,
  DEFAULT_REGULAR_HOURS,
  DEFAULT_MANUAL,
  DEFAULT_FULLSCREEN,
  DEFAULT_SYNC_SCHEDULE,
  normalizeClock,
  parseTimeToMinutes,
  parseLocalDateTime,
  formatLocalDateTime,
  normalizeRegularHours,
  normalizeManual,
  normalizeFullscreen,
  normalizeSyncSchedule,
  isWithinWindow,
  isRegularHours,
  isFullscreenActive,
  computeMode,
  windowsOverlap,
  validateRegularHours,
  validateManual,
  validateFullscreen,
  validateSyncSchedule,
  shouldSyncAt,
  syncIntervalAt,
  describeSyncCadence,
  describeNow,
  wallClock,
  weekPreview,
};
