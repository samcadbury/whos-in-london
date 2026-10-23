// Builds events.json for Who's In.
// Pulls London events from the Ticketmaster Discovery API, adds your own picks
// from data/manual-events.json, and writes the result to the output folder.
//
// Run locally:  TICKETMASTER_API_KEY=yourkey node scripts/fetch-events.mjs
// Options (environment variables):
//   OUT_DIR        folder to write events.json into (default: _site)
//   DAYS_AHEAD     how many days of events to fetch (default: 42)
//   FALLBACK_URL   events.json to reuse if Ticketmaster can't be reached

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const KEY = process.env.TICKETMASTER_API_KEY || '';
const OUT_DIR = process.env.OUT_DIR || '_site';
const DAYS_AHEAD = Number(process.env.DAYS_AHEAD || 42);
const FALLBACK_URL = process.env.FALLBACK_URL || '';
const MOCK_FILE = process.env.TM_MOCK_FILE || ''; // for testing without a key

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- London dates ----------
function londonDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function addDays(ymd, n) {
  const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const TODAY = londonDate();
const END = addDays(TODAY, DAYS_AHEAD);

// ---------- Areas from postcodes ----------
const DISTRICTS = {
  EC1: 'Clerkenwell', EC2: 'City', EC3: 'City', EC4: 'City',
  WC1: 'Bloomsbury', WC2: 'Covent Garden', W1: 'West End', SW1: 'Westminster',
  E1: 'Whitechapel', E2: 'Bethnal Green', E3: 'Bow', E5: 'Clapton', E8: 'Hackney', E9: 'Hackney Wick',
  E10: 'Leyton', E14: 'Canary Wharf', E15: 'Stratford', E16: 'Royal Docks', E17: 'Walthamstow', E20: 'Olympic Park',
  N1: 'Islington', N4: 'Finsbury Park', N5: 'Highbury', N7: 'Holloway', N16: 'Stoke Newington', N19: 'Archway', N22: 'Wood Green',
  NW1: 'Camden', NW3: 'Hampstead', NW5: 'Kentish Town', NW6: 'Kilburn', NW8: "St John's Wood", NW10: 'Willesden',
  SE1: 'South Bank', SE5: 'Camberwell', SE8: 'Deptford', SE10: 'Greenwich', SE11: 'Kennington', SE14: 'New Cross',
  SE15: 'Peckham', SE16: 'Bermondsey', SE22: 'East Dulwich',
  SW2: 'Brixton', SW3: 'Chelsea', SW4: 'Clapham', SW6: 'Fulham', SW8: 'Vauxhall', SW9: 'Brixton', SW11: 'Battersea',
  SW15: 'Putney', SW17: 'Tooting', SW18: 'Wandsworth', SW19: 'Wimbledon',
  W2: 'Paddington', W4: 'Chiswick', W6: 'Hammersmith', W8: 'Kensington', W10: 'North Kensington', W11: 'Notting Hill',
  W12: "Shepherd's Bush", W14: 'West Kensington', HA9: 'Wembley', TW1: 'Twickenham', TW2: 'Twickenham'
};
const CENTRAL = new Set(['EC1', 'EC2', 'EC3', 'EC4', 'WC1', 'WC2', 'W1', 'SW1', 'SE1']);
const OUTER = { HA: 'West', UB: 'West', TW: 'West', KT: 'South', CR: 'South', SM: 'South', BR: 'South', DA: 'South', RM: 'East', IG: 'East', EN: 'North' };

function placeFromPostcode(postcode, fallbackName) {
  const out = String(postcode || '').trim().toUpperCase().split(/\s+/)[0];
  const m = /^([A-Z]{1,2})(\d{1,2})[A-Z]?$/.exec(out);
  if (!m) return { region: 'Central', area: fallbackName || 'London' };
  const base = m[1] + m[2], letters = m[1];
  let region;
  if (CENTRAL.has(base)) region = 'Central';
  else if (letters === 'E') region = 'East';
  else if (letters === 'N' || letters === 'NW') region = 'North';
  else if (letters === 'SE' || letters === 'SW') region = 'South';
  else if (letters === 'W') region = 'West';
  else region = OUTER[letters] || 'Central';
  return { region, area: DISTRICTS[base] || fallbackName || base };
}

// ---------- Categories ----------
function categorise(ev, hour) {
  const c = (ev.classifications || [])[0] || {};
  const seg = c.segment?.name || '', genre = c.genre?.name || '', sub = c.subGenre?.name || '';
  const text = `${ev.name} ${genre} ${sub}`.toLowerCase();
  if (seg === 'Music') {
    if ((/dance|electronic|house|techno|club/.test(text)) && hour !== null && hour >= 21) return 'clubs';
    return 'gigs';
  }
  if (seg === 'Sports') return 'sport';
  if (seg === 'Arts & Theatre') return /comedy|stand-up|stand up/.test(text) ? 'comedy' : 'theatre';
  if (/comedy|stand-up/.test(text)) return 'comedy';
  if (/food|drink|wine|beer|gin|brunch|tasting|street food/.test(text)) return 'food';
  if (/market|fair/.test(text)) return 'markets';
  return null; // skip film, parking, add-ons and unclassified items
}

function fmtTime(h) {
  const hr = Math.floor(h), m = Math.round((h - hr) * 60), ap = hr >= 12 ? 'pm' : 'am', h12 = ((hr + 11) % 12) + 1;
  return h12 + (m ? ':' + String(m).padStart(2, '0') : '') + ap;
}
function pickImage(images = []) {
  const wide = images.filter(i => i.ratio === '16_9' && i.width >= 500 && i.width <= 1200).sort((a, b) => a.width - b.width);
  return (wide[0] || images.filter(i => i.ratio === '16_9').sort((a, b) => b.width - a.width)[0] || images[0] || {}).url || '';
}

function mapTicketmaster(ev) {
  const status = ev.dates?.status?.code || 'onsale';
  if (['cancelled', 'postponed'].includes(status)) return null;
  const date = ev.dates?.start?.localDate;
  if (!date || date < TODAY || date > END) return null;
  const lt = ev.dates?.start?.localTime || '';
  const hour = lt ? Number(lt.slice(0, 2)) + Number(lt.slice(3, 5)) / 60 : null;
  const cat = categorise(ev, hour);
  if (!cat) return null;
  const venue = ev._embedded?.venues?.[0] || {};
  const place = placeFromPostcode(venue.postalCode, venue.city?.name !== 'London' ? venue.city?.name : '');
  const pr = (ev.priceRanges || []).filter(p => typeof p.min === 'number').sort((a, b) => a.min - b.min)[0];
  const pmin = pr ? Math.round(pr.min) : null;
  return {
    id: 'tm-' + ev.id,
    title: ev.name,
    cat,
    date,
    time: hour === null ? 'Time TBC' : fmtTime(hour),
    h: hour,
    venue: venue.name || '',
    area: place.area,
    region: place.region,
    pmin,
    price: pmin === null ? 'See tickets' : pmin === 0 ? 'Free' : (pr.max > pr.min ? 'From £' : '£') + pmin,
    img: pickImage(ev.images),
    url: ev.url || '',
    desc: (ev.info || ev.pleaseNote || '').slice(0, 280),
    status: status === 'offsale' ? 'Sold out or off sale' : status === 'rescheduled' ? 'Rescheduled' : '',
    source: 'Ticketmaster'
  };
}

// ---------- Ticketmaster fetch ----------
async function fetchTicketmaster() {
  if (MOCK_FILE) {
    const pages = JSON.parse(await readFile(MOCK_FILE, 'utf8'));
    return pages.flatMap(p => p._embedded?.events || []);
  }
  if (!KEY) { console.warn('No TICKETMASTER_API_KEY set: skipping Ticketmaster.'); return null; }
  // Ticketmaster returns at most 1,000 results per search, so search one day at a time.
  const all = [];
  const size = 200;
  let requests = 0, capped = 0;
  for (let day = TODAY; day <= END; day = addDays(day, 1)) {
    let dayCount = 0, retries = 0;
    for (let page = 0; page < 5; page++) {
      const params = new URLSearchParams({
        apikey: KEY, city: 'London', countryCode: 'GB', locale: '*', sort: 'date,asc',
        startDateTime: `${day}T00:00:00Z`, endDateTime: `${day}T23:59:59Z`,
        size: String(size), page: String(page)
      });
      const res = await fetch(`https://app.ticketmaster.com/discovery/v2/events.json?${params}`);
      requests++;
      if (res.status === 429 && retries < 5) { retries++; await sleep(2000 * retries); page--; continue; }
      if (!res.ok) throw new Error(`Ticketmaster returned ${res.status} on ${day}: ${(await res.text()).slice(0, 200)}`);
      const json = await res.json();
      const list = json._embedded?.events || [];
      all.push(...list);
      dayCount += list.length;
      const total = json.page?.totalPages ?? 0;
      await sleep(250); // stay under 5 requests a second
      if (page + 1 >= total) break;
      if (page === 4) capped++;
    }
    console.log(`${day}: ${dayCount} listings`);
  }
  console.log(`Ticketmaster: ${all.length} listings from ${requests} requests${capped ? ` (${capped} days hit the 1,000 limit)` : ''}`);
  return all;
}

// ---------- Manual picks ----------
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
// Accepts "8pm", "7:30pm", "11am" or 24-hour "19:30".
function parseClock(t) {
  const s = String(t || '').trim().toLowerCase();
  let m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/.exec(s);
  if (m) { let h = Number(m[1]) % 12; if (m[3] === 'pm') h += 12; return h + (m[2] ? Number(m[2]) / 60 : 0); }
  m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m) return Number(m[1]) + Number(m[2]) / 60;
  return null;
}
async function loadManual() {
  let raw;
  try { raw = JSON.parse(await readFile('data/manual-events.json', 'utf8')); }
  catch (e) { console.warn('No valid data/manual-events.json:', e.message); return []; }
  const items = Array.isArray(raw) ? raw : (raw.events || []);
  const out = [];
  items.forEach((it, i) => {
    if (!it || !it.title || !it.cat) return;
    const h = parseClock(it.time);
    const base = {
      title: it.title, cat: it.cat, time: h === null ? (it.time || 'Time TBC') : fmtTime(h), h,
      venue: it.venue || '', area: it.area || 'London', region: it.region || 'Central',
      pmin: typeof it.pmin === 'number' ? it.pmin : (it.price && /free/i.test(it.price) ? 0 : null),
      price: it.price || 'Free', img: it.img || '', url: it.url || '', desc: it.desc || '', status: '', source: 'Who\'s In picks'
    };
    const slug = String(it.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
    if (Array.isArray(it.days) && it.days.length) {
      const want = it.days.map(d => WEEKDAYS.indexOf(String(d).slice(0, 3).toLowerCase())).filter(n => n >= 0);
      for (let d = TODAY; d <= END; d = addDays(d, 1)) {
        if (want.includes(new Date(d + 'T12:00:00Z').getUTCDay()) && (!it.until || d <= it.until) && (!it.from || d >= it.from)) {
          out.push({ ...base, id: `m-${slug}-${d}`, date: d });
        }
      }
    } else if (it.date && it.date >= TODAY && it.date <= END) {
      out.push({ ...base, id: `m-${slug}-${it.date}-${i}`, date: it.date });
    }
  });
  return out;
}

// ---------- Main ----------
async function main() {
  let tm = [], tmOk = false, note = '';
  try {
    const raw = await fetchTicketmaster();
    if (raw) {
      tmOk = true;
      const seen = new Set(), seenIds = new Set();
      let skipped = 0, dupes = 0;
      for (const ev of raw) {
        if (seenIds.has(ev.id)) { dupes++; continue; } seenIds.add(ev.id);
        const e = mapTicketmaster(ev);
        if (!e) { skipped++; continue; }
        const key = `${e.title.toLowerCase()}|${e.date}|${e.time}|${e.venue.toLowerCase()}`;
        if (seen.has(key)) { dupes++; continue; } seen.add(key);
        tm.push(e);
      }
      console.log(`Kept ${tm.length}; skipped ${skipped} (cancelled, films, add-ons, parking or unclassified); removed ${dupes} duplicates.`);
    }
  } catch (err) {
    console.error('Ticketmaster fetch failed:', err.message);
    note = 'ticketmaster-failed';
  }

  // If Ticketmaster failed, keep yesterday's Ticketmaster events so the site never goes empty.
  if (!tmOk && FALLBACK_URL) {
    try {
      const res = await fetch(FALLBACK_URL, { cache: 'no-store' });
      if (res.ok) {
        const prev = await res.json();
        tm = (prev.events || []).filter(e => e.source === 'Ticketmaster' && e.date >= TODAY);
        console.log(`Reused ${tm.length} Ticketmaster events from the live site.`);
        note = note || 'reused-previous';
      }
    } catch (e) { console.warn('Could not reuse previous events:', e.message); }
  }

  const manual = await loadManual();
  const events = [...tm, ...manual].sort((a, b) => a.date.localeCompare(b.date) || (a.h ?? 12) - (b.h ?? 12));
  const data = { updated: new Date().toISOString(), from: TODAY, to: END, note, counts: { ticketmaster: tm.length, manual: manual.length }, events };
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, 'events.json'), JSON.stringify(data));
  console.log(`Wrote ${events.length} events (${tm.length} Ticketmaster, ${manual.length} your picks) to ${join(OUT_DIR, 'events.json')}`);
}

main().catch(err => { console.error(err); process.exit(1); });
