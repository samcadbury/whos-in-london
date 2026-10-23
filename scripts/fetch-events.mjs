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
const SKIDDLE_KEY = process.env.SKIDDLE_API_KEY || '';
const SKIDDLE_MOCK = process.env.SKIDDLE_MOCK_FILE || '';
const OSM_MOCK = process.env.OSM_MOCK_FILE || '';
const LONDON = { lat: 51.5074, lon: -0.1278 };

// Arenas, stadiums and other very large venues. Events here are marked "big" and hidden by default in the app.
const BIG_VENUE = /\bO2\b(?! Academy (Islington|Kentish))|wembley|ovo arena|\barena\b|stadium|royal albert hall|eventim apollo|hammersmith apollo|alexandra palace|ally pally|hyde park|finsbury park|victoria park|brockwell park|crystal palace park|gunnersbury park|twickenham|emirates|tottenham hotspur|craven cottage|stamford bridge|selhurst park|lord'?s cricket|kia oval|the oval|excel london|olympia london|copper box|lee valley|outernet|troxy|printworks|drumsheds|o2 academy brixton|brixton academy|indigo at the o2/i;

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
  W12: "Shepherd's Bush", W14: 'West Kensington', HA9: 'Wembley', TW1: 'Twickenham', TW2: 'Twickenham',
  E1W: 'Wapping', E6: 'East Ham', E7: 'Forest Gate', E11: 'Leytonstone', E13: 'Plaistow',
  N2: 'East Finchley', N6: 'Highgate', N8: 'Crouch End', N10: 'Muswell Hill', N15: 'Tottenham', N17: 'Tottenham',
  NW2: 'Cricklewood', NW9: 'Colindale', SE4: 'Brockley', SE6: 'Catford', SE9: 'Eltham', SE13: 'Lewisham', SE17: 'Walworth',
  SE18: 'Woolwich', SE19: 'Crystal Palace', SE23: 'Forest Hill', SE24: 'Herne Hill', SE27: 'West Norwood',
  SW12: 'Balham', SW16: 'Streatham', W3: 'Acton', W5: 'Ealing', W9: 'Maida Vale', W13: 'West Ealing'
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
    genre: ((ev.classifications || [])[0] || {}).genre?.name || '',
    sub: ((ev.classifications || [])[0] || {}).subGenre?.name || '',
    big: BIG_VENUE.test(venue.name || ''),
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

// ---------- Skiddle (grassroots gigs, club nights, comedy) ----------
// Free key from skiddle.com/api. Skiddle's API is for non-commercial use unless they approve otherwise.
const SKIDDLE_CATS = { LIVE: 'gigs', FEST: 'gigs', CLUB: 'clubs', LGB: 'clubs', BARPUB: 'clubs', COMEDY: 'comedy', THEATRE: 'theatre', ARTS: 'theatre', EXHIB: 'theatre', SPORT: 'sport' };
async function fetchSkiddle() {
  if (SKIDDLE_MOCK) return JSON.parse(await readFile(SKIDDLE_MOCK, 'utf8'));
  if (!SKIDDLE_KEY) { console.log('No SKIDDLE_API_KEY set: skipping Skiddle.'); return null; }
  const all = [];
  // Search a week at a time and page through 100 results per request.
  for (let from = TODAY; from <= END; from = addDays(from, 7)) {
    const to = addDays(from, 6) > END ? END : addDays(from, 6);
    for (let offset = 0; offset < 3000; offset += 100) {
      const params = new URLSearchParams({
        api_key: SKIDDLE_KEY, latitude: String(LONDON.lat), longitude: String(LONDON.lon), radius: '12',
        minDate: from, maxDate: to, limit: '100', offset: String(offset), description: '1'
      });
      const res = await fetch(`https://www.skiddle.com/api/v1/events/search/?${params}`);
      if (!res.ok) throw new Error(`Skiddle returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const json = await res.json();
      if (json.error && Number(json.error) !== 0) throw new Error(`Skiddle error: ${json.errormessage || json.error}`);
      const list = json.results || [];
      all.push(...list);
      await sleep(300);
      if (list.length < 100) break;
    }
    console.log(`Skiddle ${from} to ${to}: ${all.length} listings so far`);
  }
  return all;
}
function parseLocal(dt) { // "2026-10-24T19:30:00+01:00" or "2026-10-24 19:30:00"
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/.exec(String(dt || ''));
  return m ? { date: m[1], h: Number(m[2]) + Number(m[3]) / 60 } : null;
}
function cleanText(t) { return String(t || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&rsquo;/g, "'").replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim(); }
function mapSkiddle(ev) {
  const cat = SKIDDLE_CATS[String(ev.EventCode || ev.eventcode || '').toUpperCase()];
  if (!cat) return null;
  if (ev.cancelled === '1' || ev.cancelled === 1 || ev.cancelled === true) return null;
  const t = parseLocal(ev.startdate) || (ev.date ? { date: String(ev.date).slice(0, 10), h: null } : null);
  if (!t || t.date < TODAY || t.date > END) return null;
  const v = ev.venue || {};
  const place = placeFromPostcode(v.postcode, v.town && !/london/i.test(v.town) ? v.town : '');
  const raw = ev.entryprice ?? ev.ticketpricing?.minPrice;
  const num = typeof raw === 'number' ? raw : parseFloat(String(raw || '').replace(/[^0-9.]/g, ''));
  const free = /free/i.test(String(raw || ''));
  const pmin = free ? 0 : (isNaN(num) ? null : Math.round(num));
  const img = [ev.largeimageurl, ev.imageurl].find(u => /^https:\/\//.test(String(u || ''))) || '';
  return {
    id: 'sk-' + ev.id, title: cleanText(ev.eventname), cat, date: t.date,
    time: t.h === null ? 'Time TBC' : fmtTime(t.h), h: t.h,
    venue: cleanText(v.name), area: place.area, region: place.region,
    pmin, price: pmin === null ? 'See tickets' : pmin === 0 ? 'Free' : 'From £' + pmin,
    img, url: /^https:\/\//.test(String(ev.link || '')) ? ev.link : '',
    desc: cleanText(ev.description).slice(0, 280), status: '',
    big: BIG_VENUE.test(v.name || ''), source: 'Skiddle'
  };
}

// ---------- Markets from OpenStreetMap ----------
// Data © OpenStreetMap contributors, available under the Open Database Licence. The app credits it.
const OSM_DAYS = { Mo: 1, Tu: 2, We: 3, Th: 4, Fr: 5, Sa: 6, Su: 0 };
const OSM_ORDER = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
// Understands simple opening hours such as "Sa 09:00-17:00; Su 10:00-16:00" or "Mo-Fr 10:00-18:00".
// Returns { weekday: firstOpeningHour } or null when the hours are too complex to trust.
function parseOpeningHours(oh) {
  // Public and school holiday rules ("PH off") don't change the weekly pattern, so drop them.
  const rules = String(oh || '').split(/[;|]/).map(r => r.trim()).filter(r => r && !/^(PH|SH)\b/.test(r));
  const s = rules.join('; ');
  if (!s || /24\/7|\[|\bweek\b|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|sunrise|sunset|easter/i.test(s)) return null;
  const out = {};
  for (const rule of rules) {
    if (/\boff\b|closed/i.test(rule)) continue;
    const m = /^((?:Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*-\s*(?:Mo|Tu|We|Th|Fr|Sa|Su))?(?:\s*,\s*(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*-\s*(?:Mo|Tu|We|Th|Fr|Sa|Su))?)*)\s+(\d{1,2}):(\d{2})\s*-/.exec(rule);
    if (!m) return null;
    const h = Number(m[2]) + Number(m[3]) / 60;
    for (const part of m[1].split(',').map(x => x.trim())) {
      const [a, b] = part.split('-').map(x => x.trim());
      const i = OSM_ORDER.indexOf(a), j = b ? OSM_ORDER.indexOf(b) : i;
      if (i < 0 || j < 0) return null;
      for (let k = i; ; k = (k + 1) % 7) { const d = OSM_DAYS[OSM_ORDER[k]]; if (out[d] === undefined || h < out[d]) out[d] = h; if (k === j) break; }
    }
  }
  return Object.keys(out).length ? out : null;
}
function regionFromPoint(lat, lon) {
  const dy = (lat - LONDON.lat) * 111, dx = (lon - LONDON.lon) * 111 * Math.cos(LONDON.lat * Math.PI / 180);
  if (Math.hypot(dx, dy) < 3.5) return 'Central';
  const ang = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
  return ang >= 45 && ang < 135 ? 'North' : ang >= 135 && ang < 225 ? 'West' : ang >= 225 && ang < 315 ? 'South' : 'East';
}
async function fetchMarkets() {
  if (OSM_MOCK) return JSON.parse(await readFile(OSM_MOCK, 'utf8')).elements || [];
  const query = '[out:json][timeout:90];area["name"="Greater London"]["boundary"="administrative"]->.a;(nwr["amenity"="marketplace"](area.a););out center tags;';
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'WhosIn/1.0 (London events tester)' },
    body: 'data=' + encodeURIComponent(query)
  });
  if (!res.ok) throw new Error(`OpenStreetMap returned ${res.status}`);
  return (await res.json()).elements || [];
}
function expandMarkets(elements) {
  const out = []; let noHours = 0;
  for (const el of elements) {
    const t = el.tags || {};
    if (!t.name || t.disused || t['disused:amenity'] || /^no$/i.test(t.access || '')) continue;
    const hours = parseOpeningHours(t.opening_hours);
    if (!hours) { noHours++; continue; }
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    const byPost = t['addr:postcode'] ? placeFromPostcode(t['addr:postcode'], '') : null;
    const region = byPost && byPost.area !== 'London' ? byPost.region : (lat ? regionFromPoint(lat, lon) : 'Central');
    const area = t['addr:suburb'] || t['addr:district'] || (byPost && !/^[A-Z]{1,2}\d/.test(byPost.area) ? byPost.area : '') || region + ' London';
    const daysOpen = Object.keys(hours).length;
    const url = [t.website, t['contact:website'], t.url].find(u => /^https:\/\//.test(String(u || ''))) || '';
    for (let d = TODAY; d <= END; d = addDays(d, 1)) {
      const wd = new Date(d + 'T12:00:00Z').getUTCDay();
      if (hours[wd] === undefined) continue;
      out.push({
        id: `osm-${el.type?.[0] || 'x'}${el.id}-${d}`, title: t.name, cat: 'markets', date: d,
        time: fmtTime(hours[wd]), h: hours[wd], venue: t['addr:street'] || '', area, region,
        pmin: 0, price: 'Free entry', img: '', url,
        desc: cleanText(t.description || `Market open ${t.opening_hours}. Hours from OpenStreetMap: check before you go.`).slice(0, 280),
        status: '', big: daysOpen >= 5, source: 'OpenStreetMap'
      });
    }
  }
  console.log(`Markets: ${out.length} market days from ${elements.length} mapped markets (${noHours} skipped with no clear opening hours).`);
  return out;
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
async function previousEvents() {
  if (!FALLBACK_URL) return [];
  try { const res = await fetch(FALLBACK_URL, { cache: 'no-store' }); if (res.ok) return (await res.json()).events || []; }
  catch (e) { console.warn('Could not load previous events:', e.message); }
  return [];
}
function dedupe(list) {
  const seen = new Set(), out = []; let dupes = 0;
  for (const e of list) {
    const venueKey = e.cat === 'markets' ? '' : (e.venue || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const key = `${e.title.toLowerCase().replace(/[^a-z0-9]/g, '')}|${e.date}|${venueKey}`;
    if (seen.has(key)) { dupes++; continue; } seen.add(key); out.push(e);
  }
  return { out, dupes };
}
async function main() {
  const notes = [];
  let prev = null;
  const fromPrev = async (source) => { prev = prev || await previousEvents(); return prev.filter(e => e.source === source && e.date >= TODAY); };

  // Each source is optional: if one fails, yesterday's events from that source are kept.
  async function run(name, fetcher, mapper) {
    try {
      const raw = await fetcher();
      if (raw === null) return [];
      const mapped = mapper(raw);
      console.log(`${name}: kept ${mapped.length}`);
      return mapped;
    } catch (err) {
      console.error(`${name} failed: ${err.message}`);
      notes.push(`${name.toLowerCase()}-failed`);
      const old = await fromPrev(name);
      console.log(`${name}: reused ${old.length} events from the live site.`);
      return old;
    }
  }
  const tm = await run('Ticketmaster', fetchTicketmaster, raw => {
    const ids = new Set(); return raw.filter(ev => !ids.has(ev.id) && ids.add(ev.id)).map(mapTicketmaster).filter(Boolean);
  });
  const sk = await run('Skiddle', fetchSkiddle, raw => {
    const ids = new Set(); return raw.filter(ev => !ids.has(ev.id) && ids.add(ev.id)).map(mapSkiddle).filter(Boolean);
  });
  const mk = await run('OpenStreetMap', fetchMarkets, expandMarkets);
  const manual = await loadManual();

  // Your picks first, then Skiddle (smaller venues), then markets, then Ticketmaster, so duplicates keep the better listing.
  const { out: events, dupes } = dedupe([...manual, ...sk, ...mk, ...tm]);

  // Long-running shows (the same title at the same venue on 6+ days) are marked "big" so they don't swamp the feed.
  const runs = {};
  events.forEach(e => { if (e.source !== 'OpenStreetMap' && !e.source.includes('picks')) { const k = e.title.toLowerCase() + '|' + (e.venue || '').toLowerCase(); runs[k] = (runs[k] || 0) + 1; } });
  events.forEach(e => { const k = e.title.toLowerCase() + '|' + (e.venue || '').toLowerCase(); if (runs[k] >= 6) { e.big = true; e.longrun = true; } });

  events.sort((a, b) => a.date.localeCompare(b.date) || (a.h ?? 12) - (b.h ?? 12));
  const counts = { ticketmaster: tm.length, skiddle: sk.length, markets: mk.length, manual: manual.length, duplicatesRemoved: dupes, big: events.filter(e => e.big).length };
  const data = { updated: new Date().toISOString(), from: TODAY, to: END, note: notes.join(','), counts, events };
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, 'events.json'), JSON.stringify(data));
  console.log(`Wrote ${events.length} events to ${join(OUT_DIR, 'events.json')}:`, counts);
}

main().catch(err => { console.error(err); process.exit(1); });
