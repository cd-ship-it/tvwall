const POLL_INTERVAL_MS = 5000;
const WEBCAM_RETRY_MS = 5000;

// Drives a video/image playlist inside one zone: videos play their natural
// length (letterboxed with black bars via object-fit: contain), images show
// for their configured `duration` with a blurred copy of themselves filling
// the letterbox gap instead of black bars, then it advances and loops.
class SequencePlayer {
  constructor(videoEl, imageEl, imageBlurEl, baseDir) {
    this.videoEl = videoEl;
    this.imageEl = imageEl;
    this.imageBlurEl = imageBlurEl || null;
    this.baseDir = baseDir || ''; // Drive zone subfolder, e.g. "main"
    this.items = [];
    this.currentIndex = -1;
    this.timeoutHandle = null;
    this.videoEl.addEventListener('ended', () => this.advance());
  }

  setItems(items) {
    items = items || [];
    const same = JSON.stringify(items) === JSON.stringify(this.items);
    this.items = items;
    if (same) return;

    if (this.items.length === 0) {
      this.currentIndex = -1;
      clearTimeout(this.timeoutHandle);
      this._hideAll();
      return;
    }

    if (this.currentIndex === -1 || this.currentIndex >= this.items.length) {
      this.currentIndex = -1;
      this.advance();
    }
  }

  jumpTo(index) {
    if (!this.items.length || index < 0 || index >= this.items.length) return;
    this.currentIndex = index - 1;
    this.advance();
  }

  advance() {
    if (!this.items.length) return;
    this.currentIndex = (this.currentIndex + 1) % this.items.length;
    this._play(this.items[this.currentIndex]);
  }

  _hideAll() {
    this.videoEl.classList.remove('visible');
    this.imageEl.classList.remove('visible');
    if (this.imageBlurEl) this.imageBlurEl.classList.remove('visible');
  }

  _play(item) {
    clearTimeout(this.timeoutHandle);
    const prefix = this.baseDir ? `${this.baseDir}/` : '';
    const src = `/media/${prefix}${encodeURIComponent(item.file)}`;

    if (item.type === 'video') {
      this.imageEl.classList.remove('visible');
      if (this.imageBlurEl) this.imageBlurEl.classList.remove('visible');
      this.videoEl.classList.add('visible');
      this.videoEl.src = src;
      this.videoEl.currentTime = 0;
      const playPromise = this.videoEl.play();
      if (playPromise && playPromise.catch) {
        playPromise.catch(() => {
          // Decode/autoplay failure - don't stall the loop.
          this.timeoutHandle = setTimeout(() => this.advance(), 2000);
        });
      }
    } else {
      this.videoEl.classList.remove('visible');
      this.videoEl.pause();
      this.imageEl.classList.add('visible');
      this.imageEl.src = src;
      if (this.imageBlurEl) {
        this.imageBlurEl.src = src;
        this.imageBlurEl.classList.add('visible');
      }
      const durationMs = (item.duration || 8) * 1000;
      this.timeoutHandle = setTimeout(() => this.advance(), durationMs);
    }
  }
}

const middlePlayer = new SequencePlayer(
  document.getElementById('middle-video'),
  document.getElementById('middle-image-fg'),
  document.getElementById('middle-image-blur'),
  'main'
);

// Deterministic PRNG (mulberry32) - same seed always produces the same
// sequence. Used instead of Math.random() so every independent page load
// (the six-panel simulator's six unsynchronized iframes, in particular)
// computes the identical pick for the identical moment, with no
// cross-instance communication. Math.random() would let each iframe pick
// independently, and since the "right box middle" zone straddles the
// simulator's row-3/row-6 tile seam, that showed up as two different
// photos rendered on either side of the seam within what should be one box.
function mulberry32(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

function seededShuffle(arr, seed) {
  const rand = mulberry32(seed);
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Drives the three "Recent Moments" right boxes together as one
// synchronized round: every `roundMs`, all three swap to a new photo at
// once, on wall-clock-aligned boundaries (Math.floor(Date.now()/roundMs))
// so independent page loads stay in lockstep without talking to each
// other.
//
// Primary source is `events` - named photo groups from events.json (see
// getRecentEvents() server-side). Each round shows one event's photos
// across the three boxes (cycling to fill if an event has fewer than 3)
// and its title above the top box. Falls back to a flat, untitled shuffle
// of `pool` (media/<campus>/recent/) when there are no named events, e.g.
// events.json hasn't been synced yet.
class RecentEventsPlayer {
  constructor(imageEls, titleEl) {
    this.imageEls = imageEls;
    this.titleEl = titleEl;
    this.events = [];
    this.pool = [];
    this.roundMs = 8000;
    this.timeoutHandle = null;
    this.lastRoundIndex = null;
  }

  setData(events, pool, roundDurationSeconds) {
    this.events = events || [];
    this.pool = pool || [];
    if (roundDurationSeconds) this.roundMs = roundDurationSeconds * 1000;

    if (this.events.length === 0 && this.pool.length === 0) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
      this.lastRoundIndex = null;
      this.imageEls.forEach((el) => el.classList.remove('visible'));
      this._setTitle('');
      return;
    }

    if (!this.timeoutHandle) {
      this._tick();
    }
  }

  _setTitle(text) {
    this.titleEl.textContent = text;
    this.titleEl.classList.toggle('visible', !!text);
  }

  // Shuffles `list` deterministically for this round and returns exactly
  // imageEls.length picks, cycling through the shuffle to fill every box
  // even when the list is shorter than that (rather than leaving a box
  // blank).
  _fillForRound(list, roundIndex, keyOf) {
    const n = this.imageEls.length;
    const seed = hashString(list.map(keyOf).join(',')) ^ roundIndex;
    const shuffled = seededShuffle(list, seed);
    const picks = [];
    let i = 0;
    while (picks.length < n) {
      picks.push(shuffled[i % shuffled.length]);
      i++;
    }
    return picks;
  }

  _render(roundIndex) {
    this.lastRoundIndex = roundIndex;

    if (this.events.length > 0) {
      const event = this.events[roundIndex % this.events.length];
      const picks = this._fillForRound(event.photos, roundIndex, (f) => f);
      this.imageEls.forEach((el, i) => {
        el.src = `/media/recent/${encodeURIComponent(picks[i])}`;
        el.classList.add('visible');
      });
      this._setTitle(event.title);
    } else {
      const picks = this._fillForRound(this.pool, roundIndex, (p) => p.file);
      this.imageEls.forEach((el, i) => {
        el.src = `/media/recent/${encodeURIComponent(picks[i].file)}`;
        el.classList.add('visible');
      });
      this._setTitle('');
    }
  }

  // Schedules the next tick for exactly the next wall-clock round boundary
  // (not "roundMs from now"), so it can't drift out of phase with other
  // independent instances over a long-running session.
  _tick() {
    const now = Date.now();
    const roundIndex = Math.floor(now / this.roundMs);
    if (roundIndex !== this.lastRoundIndex) {
      this._render(roundIndex);
    }

    const nextBoundary = (roundIndex + 1) * this.roundMs;
    clearTimeout(this.timeoutHandle);
    this.timeoutHandle = setTimeout(() => this._tick(), nextBoundary - now);
  }
}

const recentEventsPlayer = new RecentEventsPlayer(
  [
    document.getElementById('recent-top'),
    document.getElementById('recent-middle'),
    document.getElementById('recent-bottom'),
  ],
  document.getElementById('recent-event-title')
);

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function formatShortDate(iso) {
  const d = new Date(`${iso}T00:00:00`);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Events have a deliberately loose schema (single `date`, or `date_range` +
// `recurrence`, or a `dates` array, plus assorted optional extras) since
// they come straight from an upstream newsletter-scraping process this app
// doesn't control. This just renders whatever fields happen to be present.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function formatSchedule(event) {
  let dateLine = '';
  if (event.date) {
    // Plain `date` is either a real ISO date ("2026-09-11" -> "Sep 11") or
    // free text describing a recurrence ("Every 2nd and 4th Sunday") - only
    // the former should get reformatted.
    dateLine = ISO_DATE_RE.test(event.date) ? formatShortDate(event.date) : event.date;
  } else if (event.date_range) {
    const start = formatShortDate(event.date_range.start);
    const end = formatShortDate(event.date_range.end);
    dateLine = event.recurrence ? `${start} - ${end}, ${event.recurrence}` : `${start} - ${end}`;
  } else if (Array.isArray(event.dates) && event.dates.length > 0) {
    const start = formatShortDate(event.dates[0]);
    const end = formatShortDate(event.dates[event.dates.length - 1]);
    dateLine = event.recurrence
      ? `${start} - ${end}, ${event.recurrence}`
      : `${start} - ${end} (${event.dates.length} sessions)`;
  } else if (event.recurrence) {
    // No date/date_range/dates at all, just a standalone recurrence
    // description (e.g. "Every 2nd and 4th Sunday") - show it on its own
    // rather than silently dropping it.
    dateLine = event.recurrence;
  }
  return [dateLine, event.time].filter(Boolean).join(' · ');
}

function renderEventCard(event) {
  const parts = [];
  parts.push(`<div class="event-title-en">${escapeHtml(event.title_en || event.title_zh || 'Upcoming Event')}</div>`);
  if (event.title_zh && event.title_en) {
    parts.push(`<div class="event-title-zh">${escapeHtml(event.title_zh)}</div>`);
  }

  const schedule = formatSchedule(event);
  if (schedule) parts.push(`<div class="event-schedule">${escapeHtml(schedule)}</div>`);

  if (event.location) {
    const loc = event.address ? `${event.location} — ${event.address}` : event.location;
    parts.push(`<div class="event-location">${escapeHtml(loc)}</div>`);
  }

  const extras = [];
  if (event.doors_open) extras.push(`Doors open ${event.doors_open}`);
  if (event.cost) extras.push(event.cost);
  if (event.special_guest) extras.push(`Special guest: ${event.special_guest}`);
  if (Array.isArray(event.speakers) && event.speakers.length) extras.push(`Speakers: ${event.speakers.join(', ')}`);
  if (event.notes) extras.push(event.notes);
  if (extras.length) parts.push(`<div class="event-notes">${escapeHtml(extras.join(' · '))}</div>`);

  return parts.join('');
}

// Drives the left box: one event card at a time, sequential (not random -
// order in the source JSON is meaningful), wall-clock-aligned like
// RecentPlayer so independent page loads (simulator iframes) agree on
// which event is showing right now.
class EventsPlayer {
  constructor(el) {
    this.el = el;
    this.events = [];
    this.durationMs = 5000;
    this.timeoutHandle = null;
    this.lastRoundIndex = null;
  }

  setEvents(events, durationSeconds) {
    this.events = events || [];
    if (durationSeconds) this.durationMs = durationSeconds * 1000;

    if (this.events.length === 0) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
      this.lastRoundIndex = null;
      this.el.innerHTML = '';
      return;
    }

    if (!this.timeoutHandle) {
      this._tick();
    }
  }

  _tick() {
    const now = Date.now();
    const roundIndex = Math.floor(now / this.durationMs);
    if (roundIndex !== this.lastRoundIndex) {
      this.lastRoundIndex = roundIndex;
      const event = this.events[roundIndex % this.events.length];
      this.el.innerHTML = renderEventCard(event);
    }

    const nextBoundary = (roundIndex + 1) * this.durationMs;
    clearTimeout(this.timeoutHandle);
    this.timeoutHandle = setTimeout(() => this._tick(), nextBoundary - now);
  }
}

const eventsPlayer = new EventsPlayer(document.getElementById('event-card'));

// Continuous right-to-left marquee, speed in pixels/second (adjustable
// live from /control - a CSS animation would need its duration
// recalculated from scratch on every speed change; a rAF loop just reads
// the current speed each frame). Seamless looping via the standard
// duplicate-text + modulo-wrap technique: the track holds two copies of
// the text back to back, and once it has scrolled exactly one copy's
// width, that offset is added back - so the wrap is invisible regardless
// of how the text width compares to the container width.
class NewsTicker {
  constructor(viewportEl, trackEl) {
    this.viewport = viewportEl;
    this.track = trackEl;
    this.text = '';
    this.speed = 30;
    this.enabled = true;
    this.posX = 0;
    this.lastFrameTime = null;
    this.rafHandle = null;
  }

  setText(text) {
    text = text || '';
    if (text === this.text) return;
    this.text = text;
    this.track.textContent = text ? `${text}     •     ${text}` : '';
    this.posX = 0;
    this._applyTransform();
  }

  setSpeed(pixelsPerSecond) {
    this.speed = pixelsPerSecond > 0 ? pixelsPerSecond : 30;
  }

  // Fully stops the rAF loop when off, not just hidden - no point burning
  // a frame callback every tick on a box nobody sees.
  setEnabled(enabled) {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.viewport.classList.toggle('hidden', !enabled);
    if (enabled) {
      this.start();
    } else {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
  }

  start() {
    if (!this.enabled || this.rafHandle) return;
    this.lastFrameTime = null;
    this.rafHandle = requestAnimationFrame((t) => this._frame(t));
  }

  _frame(now) {
    if (this.lastFrameTime === null) this.lastFrameTime = now;
    const dt = (now - this.lastFrameTime) / 1000;
    this.lastFrameTime = now;

    if (this.text) {
      const singleWidth = this.track.scrollWidth / 2;
      this.posX -= this.speed * dt;
      if (singleWidth > 0 && this.posX <= -singleWidth) {
        this.posX += singleWidth;
      }
      this._applyTransform();
    }

    this.rafHandle = requestAnimationFrame((t) => this._frame(t));
  }

  _applyTransform() {
    this.track.style.transform = `translateX(${this.posX}px)`;
  }
}

const newsTicker = new NewsTicker(
  document.getElementById('news-ticker'),
  document.getElementById('news-ticker-track')
);
newsTicker.start();

// ---- Middle-box mode switching (webcam / playlist / feed-unavailable) ----
const modeLayers = {
  webcam: document.getElementById('mode-webcam'),
  playlist: document.getElementById('mode-playlist'),
  'feed-unavailable': document.getElementById('mode-feed-unavailable'),
};

function showMainLayer(name) {
  Object.entries(modeLayers).forEach(([key, el]) => {
    el.classList.toggle('visible', key === name);
  });
}

// ---- Webcam capture ----
const webcamVideoEl = document.getElementById('webcam-video');
let webcamStream = null;
let webcamWanted = false;
let webcamRetryHandle = null;

function reportWebcamStatus(connected) {
  fetch('/api/webcam-status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ connected }),
  }).catch(() => {});
}

async function tryStartWebcam() {
  if (!webcamWanted) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    webcamStream = stream;
    webcamVideoEl.srcObject = stream;
    showMainLayer('webcam');
    reportWebcamStatus(true);
    stream.getVideoTracks().forEach((track) => {
      track.addEventListener('ended', onWebcamLost);
    });
  } catch (err) {
    onWebcamLost();
  }
}

function onWebcamLost() {
  if (!webcamWanted) return;
  showMainLayer('feed-unavailable');
  reportWebcamStatus(false);
  if (!webcamRetryHandle) {
    webcamRetryHandle = setTimeout(() => {
      webcamRetryHandle = null;
      tryStartWebcam();
    }, WEBCAM_RETRY_MS);
  }
}

function startWebcamMode() {
  if (webcamWanted) return;
  webcamWanted = true;
  tryStartWebcam();
}

function stopWebcamMode() {
  webcamWanted = false;
  clearTimeout(webcamRetryHandle);
  webcamRetryHandle = null;
  if (webcamStream) {
    webcamStream.getTracks().forEach((t) => t.stop());
    webcamStream = null;
  }
}

// ---- Poll server state ----
let lastSkipNonce = null;

async function pollState() {
  try {
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();

    middlePlayer.setItems(data.playlist);
    recentEventsPlayer.setData(data.recentEvents, data.recent, data.recentRoundDuration);
    eventsPlayer.setEvents(data.events, data.eventsDuration);
    newsTicker.setText(data.tickerText);
    newsTicker.setSpeed(data.tickerSpeed);
    newsTicker.setEnabled(data.tickerEnabled !== false);

    if (data.mode === 'webcam') {
      startWebcamMode();
    } else {
      stopWebcamMode();
      showMainLayer('playlist');
    }

    if (lastSkipNonce !== null && data.skip.nonce !== lastSkipNonce && data.skip.index !== null) {
      middlePlayer.jumpTo(data.skip.index);
    }
    lastSkipNonce = data.skip.nonce;
  } catch (err) {
    // Network hiccup - keep showing whatever's already on screen and
    // retry on the next tick (recover from temporary network loss).
  }
}

pollState();
setInterval(pollState, POLL_INTERVAL_MS);
