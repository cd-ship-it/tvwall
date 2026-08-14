// Scrapes the church's public Weekly Prayer page for the Prayers zone
// (right column, below Recent) - same "external source -> local cache ->
// zone reads the cache" shape as driveSync.js, just over HTTP instead of
// the Drive API. No HTML-parsing dependency: the page's markup is a
// simple, predictable `.prose` block (see comments below), so a few
// targeted regexes are enough and keep this dependency-free.
const fs = require('fs');
const path = require('path');
const { getPrayersCachePath } = require('./playlist');
const { setPrayersStatus } = require('../state');

const PRAYERS_URL = 'https://crosspointchurchsv.org/weekly-prayer';
const FETCH_TIMEOUT_MS = 10000;

function stripTagsAndDecode(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

function decodeEntities(str) {
  return str
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#8216;|&lsquo;/gi, '\u2018')
    .replace(/&#8217;|&rsquo;/gi, '\u2019')
    .replace(/&#8220;|&ldquo;/gi, '\u201c')
    .replace(/&#8221;|&rdquo;/gi, '\u201d')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)));
}

// Page markup looks like (verified against the live page):
//   <div class="prose ..."><h3><strong>2026-08-09</strong></h3>
//   <h2>代禱事項</h2><ul><li>1. ...</li>...</ul>
//   <hr />
//   <h2>Prayer Requests</h2><ul><li>...</li>...</ul></div>
// Deliberately tolerant of attribute/whitespace differences, but throws a
// clear error (rather than guessing) if the overall shape - a date
// heading, two <h2>+<ul> sections split by <hr> - isn't there anymore.
function parsePrayerHtml(html) {
  const proseMatch = html.match(/<div[^>]*class="[^"]*\bprose\b[^"]*"[^>]*>([\s\S]*?)<\/article>/i);
  if (!proseMatch) {
    throw new Error('Could not find the .prose content block - page structure may have changed');
  }
  const prose = proseMatch[1];

  const hrIndex = prose.search(/<hr\s*\/?>/i);
  if (hrIndex === -1) {
    throw new Error('Could not find the <hr> separator between the Chinese and English sections');
  }
  const beforeHr = prose.slice(0, hrIndex);
  const afterHr = prose.slice(hrIndex);

  const dateMatch = beforeHr.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
  const dateText = dateMatch ? stripTagsAndDecode(dateMatch[1]) : '';
  const isoDateMatch = dateText.match(/\d{4}-\d{2}-\d{2}/);
  const date = isoDateMatch ? isoDateMatch[0] : dateText || null;

  const zh = extractSection(beforeHr);
  const en = extractSection(afterHr);

  if (zh.items.length === 0 && en.items.length === 0) {
    throw new Error('Found 0 prayer items in either section - page structure may have changed');
  }

  return { date, zh, en };
}

function extractSection(sectionHtml) {
  const headingMatch = sectionHtml.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  const heading = headingMatch ? stripTagsAndDecode(headingMatch[1]) : '';

  const ulMatch = sectionHtml.match(/<ul[^>]*>([\s\S]*?)<\/ul>/i);
  const items = [];
  if (ulMatch) {
    const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let liMatch;
    while ((liMatch = liRegex.exec(ulMatch[1])) !== null) {
      const text = stripTagsAndDecode(liMatch[1]);
      if (text) items.push(text);
    }
  }
  return { heading, items };
}

async function fetchPrayerHtml() {
  const res = await fetch(PRAYERS_URL, {
    headers: { 'User-Agent': 'TVWallDisplayBot/1.0 (+https://crosspointchurchsv.org)' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${PRAYERS_URL}`);
  }
  return res.text();
}

// Guards against overlapping runs the same way syncDriveFolder() does - a
// scheduled tick landing while a manual "Check Now" is still in flight
// just joins that run instead of starting a second one.
let fetchPromise = null;

function fetchPrayers() {
  if (fetchPromise) {
    console.log('[prayer-sync] fetch already in progress - joining that run instead of starting a new one');
    return fetchPromise;
  }
  fetchPromise = runFetch().finally(() => {
    fetchPromise = null;
  });
  return fetchPromise;
}

// Never throws - a failure (network error, or the page's structure
// changing in a way parsePrayerHtml can't handle) is logged and the
// previous cache file is left in place untouched, so the Prayers zone
// keeps showing the last successfully fetched content instead of going
// blank over a transient error.
async function runFetch() {
  const cachePath = getPrayersCachePath();
  try {
    const html = await fetchPrayerHtml();
    const { date, zh, en } = parsePrayerHtml(html);

    const cache = {
      fetchedAt: new Date().toISOString(),
      date,
      zh,
      en,
    };
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));

    console.log(`[prayer-sync] OK - date ${date || '(none)'}, ${zh.items.length} zh item(s), ${en.items.length} en item(s)`);
    setPrayersStatus({
      lastFetchAt: cache.fetchedAt,
      lastFetchOk: true,
      lastFetchError: null,
      counts: { zh: zh.items.length, en: en.items.length },
    });
    return { ok: true, cache };
  } catch (err) {
    console.error(`[prayer-sync] FAILED: ${err.message}`);
    if (fs.existsSync(cachePath)) {
      console.error('[prayer-sync] Keeping previous prayers-cache.json (last known good) - Prayers zone keeps showing it.');
    } else {
      console.error('[prayer-sync] No previous prayers-cache.json exists - Prayers zone will show "coming soon".');
    }
    setPrayersStatus({ lastFetchAt: new Date().toISOString(), lastFetchOk: false, lastFetchError: err.message });
    return { ok: false, error: err.message };
  }
}

module.exports = { fetchPrayers, parsePrayerHtml, PRAYERS_URL };
