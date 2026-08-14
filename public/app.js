const POLL_INTERVAL_MS = 5000;
const WEBCAM_RETRY_MS = 5000;

// Drives a video/image playlist inside one zone: videos play their natural
// length (letterboxed, gap filled by a blurred backdrop - see
// _captureVideoFrame), images show for their configured `duration` with a
// blurred copy of themselves filling the letterbox gap, then it advances
// and loops.
class SequencePlayer {
  constructor(videoEl, imageEl, imageBlurEl, baseDir) {
    this.videoEl = videoEl;
    this.imageEl = imageEl;
    this.imageBlurEl = imageBlurEl || null;
    this.baseDir = baseDir || ''; // Drive zone subfolder, e.g. "featured"
    this.items = [];
    this.currentIndex = -1;
    this.timeoutHandle = null;
    this._captureCanvas = null;
    this.videoEl.addEventListener('ended', () => this.advance());
    // First frame is only guaranteed decoded once loadeddata fires (after
    // currentTime=0 is applied in _play) - captures a touched-up-later
    // backdrop for videos, the same way a photo's own pixels are already
    // used as its backdrop (see .blur-backdrop in style.css).
    this.videoEl.addEventListener('loadeddata', () => this._captureVideoFrame());
  }

  // Grabs the currently-loaded video frame into a small offscreen canvas
  // (downscaled - it's going to be blurred via CSS anyway, so full
  // resolution would just waste decode/encode time) and feeds it into the
  // same img element used for photo backdrops. Same-origin video
  // (/media/featured/...) so this never hits a tainted-canvas restriction.
  _captureVideoFrame() {
    if (!this.imageBlurEl) return;
    const vw = this.videoEl.videoWidth;
    const vh = this.videoEl.videoHeight;
    if (!vw || !vh) return;
    try {
      if (!this._captureCanvas) this._captureCanvas = document.createElement('canvas');
      const canvas = this._captureCanvas;
      canvas.width = 320;
      canvas.height = Math.max(1, Math.round((vh / vw) * 320));
      canvas.getContext('2d').drawImage(this.videoEl, 0, 0, canvas.width, canvas.height);
      this.imageBlurEl.src = canvas.toDataURL('image/jpeg', 0.7);
      this.imageBlurEl.classList.add('visible');
    } catch {
      // Capture can fail (decode timing, unusual codec, etc.) - leave the
      // backdrop hidden and fall back to plain black bars for this item
      // rather than throwing.
    }
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
      // Hide the previous item's backdrop (stale frame/photo) until this
      // video's own first frame is captured on `loadeddata` - see
      // _captureVideoFrame.
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
  'featured'
);

// Drives the Recent zone (right box): every `roundMs`, on wall-clock-
// aligned boundaries (Math.floor(Date.now()/roundMs)) so independent page
// loads (e.g. the simulator's iframes) stay in lockstep without talking
// to each other, it advances to the next photo.
//
// Slide order from the server (getRecentSlides):
//   1. titled event photos from events.json (events with no photos skipped)
//   2. then orphan images in recent/ (untitled - title hidden)
//   3. if nothing at all → comingSoon ("coming soon" on white)
class RecentEventsPlayer {
  constructor(imageEl, titleEl, comingSoonEl) {
    this.imageEl = imageEl;
    this.titleEl = titleEl;
    this.comingSoonEl = comingSoonEl;
    this.items = []; // [{ title, file }], in display order
    this.roundMs = 8000;
    this.timeoutHandle = null;
    this.lastRoundIndex = null;
    this.comingSoon = false;
  }

  setData(slides, roundDurationSeconds, comingSoon) {
    slides = slides || [];
    if (roundDurationSeconds) this.roundMs = roundDurationSeconds * 1000;
    this.comingSoon = !!comingSoon || slides.length === 0;
    this.items = this.comingSoon ? [] : slides;

    if (this.comingSoon) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
      this.lastRoundIndex = null;
      this.imageEl.classList.remove('visible');
      this._setTitle('');
      this.comingSoonEl.classList.add('visible');
      return;
    }

    this.comingSoonEl.classList.remove('visible');

    if (!this.timeoutHandle) {
      this._tick();
    }
  }

  _setTitle(text) {
    const hasTitle = !!text;
    this.titleEl.textContent = text || '';
    this.titleEl.classList.toggle('visible', hasTitle);
  }

  _render(roundIndex) {
    this.lastRoundIndex = roundIndex;
    const item = this.items[roundIndex % this.items.length];
    this.imageEl.src = `/media/recent/${encodeURIComponent(item.file)}`;
    this.imageEl.classList.add('visible');
    this._setTitle(item.title || '');
  }

  // Schedules the next tick for exactly the next wall-clock round boundary
  // (not "roundMs from now"), so it can't drift out of phase with other
  // independent instances over a long-running session.
  _tick() {
    if (!this.items.length) return;
    const now = Date.now();
    const roundIndex = Math.floor(now / this.roundMs);
    if (roundIndex !== this.lastRoundIndex) {
      this._render(roundIndex);
    }

    const nextBoundary = (roundIndex + 1) * this.roundMs;
    clearTimeout(this.timeoutHandle);
    this.timeoutHandle = setTimeout(() => this._tick(), nextBoundary - now);
  }

  // DEBUG ONLY - see the click listener below. Steps to the next photo
  // immediately, for eyeballing titles/crops without waiting out the
  // rotation timer. Remove this method + the listener once done checking.
  next() {
    if (!this.items.length) return;
    this.lastRoundIndex = this.lastRoundIndex === null ? 0 : this.lastRoundIndex + 1;
    this._render(this.lastRoundIndex);
    clearTimeout(this.timeoutHandle);
    this.timeoutHandle = setTimeout(() => this._tick(), this.roundMs);
  }
}

const recentEventsPlayer = new RecentEventsPlayer(
  document.getElementById('recent-photo'),
  document.getElementById('recent-event-title'),
  document.getElementById('recent-coming-soon')
);

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

// Chinese weekly-prayer bullets come prefixed "1. ", "2. ", etc. from the
// source page. Strip that so the slide is just the sentence.
function stripLeadingBulletNumber(text) {
  return (text || '').replace(/^\d+[\.．、)\]]\s*/, '');
}

// Events have a deliberately loose schema (single `date`, or `date_range` +
// `recurrence`, or a `dates` array, plus assorted optional extras) since
// they come straight from an upstream newsletter-scraping process this app
// doesn't control. This just renders whatever fields happen to be present.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// First specific calendar day, or null when the event is recurrence-only
// ("every Tuesday") / free-text. Date ranges and `dates` arrays use the
// start / first entry.
function eventStartIso(event) {
  if (event.date && ISO_DATE_RE.test(event.date)) return event.date;
  if (event.date_range && ISO_DATE_RE.test(event.date_range.start)) return event.date_range.start;
  if (Array.isArray(event.dates)) {
    const first = event.dates.find((d) => ISO_DATE_RE.test(d));
    if (first) return first;
  }
  return null;
}

function formatMonthDay(iso) {
  const d = new Date(`${iso}T00:00:00`);
  if (isNaN(d.getTime())) return null;
  return {
    month: d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase(),
    day: String(d.getDate()),
  };
}

function formatShortDate(iso) {
  const d = new Date(`${iso}T00:00:00`);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Right column: date line only when it adds info the left box doesn't
// already show (range, "every Sunday", recurrence). Exact single dates
// stay in the square only. Then time, then location+address.
function eventDetailLines(event) {
  const dateBits = [];
  if (event.date && !ISO_DATE_RE.test(event.date)) dateBits.push(event.date);
  if (event.date_range && event.date_range.start && event.date_range.end) {
    dateBits.push(`${formatShortDate(event.date_range.start)} – ${formatShortDate(event.date_range.end)}`);
  } else if (Array.isArray(event.dates) && event.dates.length > 1) {
    dateBits.push(
      `${formatShortDate(event.dates[0])} – ${formatShortDate(event.dates[event.dates.length - 1])} (${event.dates.length} sessions)`
    );
  }
  if (event.recurrence) dateBits.push(event.recurrence);

  const place = [event.location, event.address].filter(Boolean).join(' — ');
  return [dateBits.filter(Boolean).join(' · '), event.time, place].filter(Boolean);
}

function renderEventMeta(event) {
  const iso = eventStartIso(event);
  const parts = formatMonthDay(iso);
  const left = parts
    ? `<div class="event-date-box"><div class="event-date-month">${escapeHtml(parts.month)}</div><div class="event-date-day">${escapeHtml(parts.day)}</div></div>`
    : `<div class="event-date-box event-date-box-icon"><img src="/icons/calendar.svg" alt="" /></div>`;

  const lines = eventDetailLines(event);
  const details = lines.length
    ? `<div class="event-meta-details">${lines
        .map((text, i) => `<div class="${i === 0 ? 'event-meta-time' : 'event-meta-location'}">${escapeHtml(text)}</div>`)
        .join('')}</div>`
    : '';

  return `<div class="event-meta">${left}${details}</div>`;
}

function renderEventCard(event) {
  const parts = [];
  parts.push(`<div class="event-title-en">${escapeHtml(event.title_en || event.title_zh || 'Upcoming Event')}</div>`);
  if (event.title_zh && event.title_en) {
    parts.push(`<div class="event-title-zh">${escapeHtml(event.title_zh)}</div>`);
  }

  parts.push(renderEventMeta(event));

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
      this._render(roundIndex);
    }

    const nextBoundary = (roundIndex + 1) * this.durationMs;
    clearTimeout(this.timeoutHandle);
    this.timeoutHandle = setTimeout(() => this._tick(), nextBoundary - now);
  }

  _render(roundIndex) {
    const event = this.events[roundIndex % this.events.length];
    this.el.innerHTML = renderEventCard(event);
  }

  // DEBUG ONLY - see the click listener below. Steps to the next event
  // immediately, for eyeballing typography across different title/notes
  // lengths without waiting out the normal rotation timer. Remove this
  // method + the listener once done checking.
  next() {
    if (!this.events.length) return;
    this.lastRoundIndex = this.lastRoundIndex === null ? 0 : this.lastRoundIndex + 1;
    this._render(this.lastRoundIndex);
    clearTimeout(this.timeoutHandle);
    this.timeoutHandle = setTimeout(() => this._tick(), this.durationMs);
  }
}

const eventsPlayer = new EventsPlayer(document.getElementById('event-card'));

// Drives the Prayers zone (right, below Recent): one bullet item at a time
// from crosspointchurchsv.org/weekly-prayer (server/services/prayerSync.js
// scrapes + caches it, getPrayerSlides() in playlist.js reads that cache) -
// all Chinese items first (source order), then all English (source
// order), then loops. Wall-clock-aligned + comingSoon empty state, same
// shape as RecentEventsPlayer above.
class PrayersPlayer {
  constructor(cardEl, textEl, comingSoonEl) {
    this.cardEl = cardEl;
    this.textEl = textEl;
    this.comingSoonEl = comingSoonEl;
    this.items = []; // [{ lang: 'zh'|'en', text }] - zh items then en items
    this.roundMs = 10000;
    this.timeoutHandle = null;
    this.lastRoundIndex = null;
    this.comingSoon = false;
  }

  setData(slides, durationSeconds, comingSoon) {
    slides = slides || [];
    if (durationSeconds) this.roundMs = durationSeconds * 1000;
    this.comingSoon = !!comingSoon || slides.length === 0;
    this.items = this.comingSoon ? [] : slides;

    if (this.comingSoon) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
      this.lastRoundIndex = null;
      this.cardEl.classList.remove('visible');
      this.comingSoonEl.classList.add('visible');
      return;
    }

    this.comingSoonEl.classList.remove('visible');
    this.cardEl.classList.add('visible');

    if (!this.timeoutHandle) {
      this._tick();
    }
  }

  _render(roundIndex) {
    this.lastRoundIndex = roundIndex;
    const item = this.items[roundIndex % this.items.length];
    this.textEl.textContent = item.lang === 'zh' ? stripLeadingBulletNumber(item.text) : item.text;
    this.textEl.classList.toggle('lang-zh', item.lang === 'zh');
    this.textEl.classList.toggle('lang-en', item.lang !== 'zh');
    this._fitText(item.lang);
  }

  // Prayer sentences run long (much longer than an event title), so this
  // shrinks the font until the full sentence fits the card's available
  // space without chopping characters - same idea as
  // RecentEventsPlayer._fitTitle, but measured against the card's actual
  // box (via getBoundingClientRect/getComputedStyle) rather than a CSS
  // max-height, since this element sizes itself to its flex container
  // instead of having a fixed cap of its own. Chinese starts at 30px;
  // English stays at 26px.
  _fitText(lang) {
    const el = this.textEl;
    const card = this.cardEl;
    const maxPx = lang === 'zh' ? 30 : 26;
    const minPx = 13;

    const cardStyle = getComputedStyle(card);
    const paddingY = parseFloat(cardStyle.paddingTop) + parseFloat(cardStyle.paddingBottom);
    const paddingX = parseFloat(cardStyle.paddingLeft) + parseFloat(cardStyle.paddingRight);
    const cardRect = card.getBoundingClientRect();
    const availableHeight = cardRect.height - paddingY;
    const availableWidth = cardRect.width - paddingX;

    let size = maxPx;
    el.style.fontSize = `${size}px`;
    while (size > minPx && (el.scrollHeight > availableHeight || el.scrollWidth > availableWidth)) {
      size -= 1;
      el.style.fontSize = `${size}px`;
    }
  }

  _tick() {
    if (!this.items.length) return;
    const now = Date.now();
    const roundIndex = Math.floor(now / this.roundMs);
    if (roundIndex !== this.lastRoundIndex) {
      this._render(roundIndex);
    }

    const nextBoundary = (roundIndex + 1) * this.roundMs;
    clearTimeout(this.timeoutHandle);
    this.timeoutHandle = setTimeout(() => this._tick(), nextBoundary - now);
  }

  // DEBUG ONLY - see the click listener below. Steps to the next prayer
  // immediately, for eyeballing typography across Chinese/English lengths
  // without waiting out the rotation timer. Remove this method + the
  // listener once done checking.
  next() {
    if (!this.items.length) return;
    this.lastRoundIndex = this.lastRoundIndex === null ? 0 : this.lastRoundIndex + 1;
    this._render(this.lastRoundIndex);
    clearTimeout(this.timeoutHandle);
    this.timeoutHandle = setTimeout(() => this._tick(), this.roundMs);
  }
}

const prayersPlayer = new PrayersPlayer(
  document.getElementById('prayer-card'),
  document.getElementById('prayer-text'),
  document.getElementById('prayers-coming-soon')
);

// DEBUG ONLY - click the Upcoming box to manually advance to the next
// event, for checking typography across different title/notes lengths.
// Remove this block (and EventsPlayer.next() above) when done debugging.
(() => {
  const zoneLeft = document.getElementById('zone-left');
  zoneLeft.style.cursor = 'pointer';
  zoneLeft.title = 'DEBUG: click to show next event';
  zoneLeft.addEventListener('click', () => eventsPlayer.next());
})();

// DEBUG ONLY - click the Featured box to manually advance to the next
// playlist item (photo or video), for checking playback without waiting
// out the normal slide duration / full video length. advance() is
// SequencePlayer's own normal "move to next item" method (also called on
// video `ended` and photo timeout), so this just triggers it early -
// nothing debug-specific to unwind. Remove this block when done debugging.
(() => {
  const zoneMiddle = document.getElementById('zone-middle');
  zoneMiddle.style.cursor = 'pointer';
  zoneMiddle.title = 'DEBUG: click to advance to next featured item';
  zoneMiddle.addEventListener('click', () => middlePlayer.advance());
})();

// DEBUG ONLY - click Recent / Prayers to step to the next slide, for
// checking photo titles and prayer typography without waiting out the
// rotation timer. Remove these blocks (and RecentEventsPlayer.next() /
// PrayersPlayer.next() above) when done debugging.
(() => {
  const zoneRight = document.getElementById('zone-right');
  zoneRight.style.cursor = 'pointer';
  zoneRight.title = 'DEBUG: click to show next recent photo';
  zoneRight.addEventListener('click', () => recentEventsPlayer.next());
})();

(() => {
  const zonePrayers = document.getElementById('zone-prayers');
  zonePrayers.style.cursor = 'pointer';
  zonePrayers.title = 'DEBUG: click to show next prayer';
  zonePrayers.addEventListener('click', () => prayersPlayer.next());
})();

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

// ---- Fullscreen override (covers entire wall including ticker) ----
const fullscreenOverlay = document.getElementById('fullscreen-overlay');
const fullscreenVideoEl = document.getElementById('fullscreen-video');
const fullscreenImageEl = document.getElementById('fullscreen-image');
let fullscreenActive = false;
let fullscreenSrc = null;

function showFullscreenMedia(item) {
  fullscreenOverlay.classList.add('visible');
  fullscreenOverlay.setAttribute('aria-hidden', 'false');
  fullscreenActive = true;

  if (!item || !item.file) {
    fullscreenVideoEl.classList.remove('visible');
    fullscreenVideoEl.pause();
    fullscreenVideoEl.removeAttribute('src');
    fullscreenImageEl.classList.remove('visible');
    fullscreenImageEl.removeAttribute('src');
    fullscreenSrc = null;
    return;
  }

  const src = `/media/fullscreen_img/${encodeURIComponent(item.file)}`;
  if (src === fullscreenSrc && item.type === 'video' && !fullscreenVideoEl.paused) return;
  if (src === fullscreenSrc && item.type === 'image' && fullscreenImageEl.classList.contains('visible')) return;
  fullscreenSrc = src;

  if (item.type === 'video') {
    fullscreenImageEl.classList.remove('visible');
    fullscreenImageEl.removeAttribute('src');
    fullscreenVideoEl.classList.add('visible');
    if (fullscreenVideoEl.getAttribute('src') !== src) {
      fullscreenVideoEl.src = src;
    }
    const playPromise = fullscreenVideoEl.play();
    if (playPromise && playPromise.catch) playPromise.catch(() => {});
  } else {
    fullscreenVideoEl.classList.remove('visible');
    fullscreenVideoEl.pause();
    fullscreenVideoEl.removeAttribute('src');
    fullscreenImageEl.classList.add('visible');
    if (fullscreenImageEl.getAttribute('src') !== src) {
      fullscreenImageEl.src = src;
    }
  }
}

function hideFullscreenMedia() {
  if (!fullscreenActive && !fullscreenOverlay.classList.contains('visible')) return;
  fullscreenOverlay.classList.remove('visible');
  fullscreenOverlay.setAttribute('aria-hidden', 'true');
  fullscreenActive = false;
  fullscreenSrc = null;
  fullscreenVideoEl.classList.remove('visible');
  fullscreenVideoEl.pause();
  fullscreenVideoEl.removeAttribute('src');
  fullscreenImageEl.classList.remove('visible');
  fullscreenImageEl.removeAttribute('src');
}

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
let lastReloadNonce = null;

async function pollState() {
  try {
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();

    // "Refresh Display" from /control. Checked before anything else so we
    // don't bother re-driving players we're about to discard.
    if (data.reload) {
      if (lastReloadNonce !== null && data.reload.nonce !== lastReloadNonce) {
        location.reload();
        return;
      }
      lastReloadNonce = data.reload.nonce;
    }

    if (data.mode === 'fullscreen') {
      showFullscreenMedia(data.fullscreen);
      stopWebcamMode();
      // Keep dashboard players fed so leaving fullscreen resumes cleanly,
      // but hide ticker while the overlay covers everything.
      middlePlayer.setItems(data.playlist);
      recentEventsPlayer.setData(data.recentSlides, data.recentRoundDuration, data.recentComingSoon);
      eventsPlayer.setEvents(data.events, data.eventsDuration);
      prayersPlayer.setData(data.prayersSlides, data.prayersDuration, data.prayersComingSoon);
      newsTicker.setEnabled(false);
    } else {
      hideFullscreenMedia();
      middlePlayer.setItems(data.playlist);
      recentEventsPlayer.setData(data.recentSlides, data.recentRoundDuration, data.recentComingSoon);
      eventsPlayer.setEvents(data.events, data.eventsDuration);
      prayersPlayer.setData(data.prayersSlides, data.prayersDuration, data.prayersComingSoon);
      newsTicker.setText(data.tickerText);
      newsTicker.setSpeed(data.tickerSpeed);
      newsTicker.setEnabled(data.tickerEnabled !== false);

      if (data.mode === 'webcam') {
        startWebcamMode();
      } else {
        stopWebcamMode();
        showMainLayer('playlist');
      }
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
