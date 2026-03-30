// server.js — Tasky Dashboard v8 (100-user optimised)
// ─────────────────────────────────────────────────────────────────────────────
// Key design decisions for scale:
//   • /api/summary  → tiny payload (metadata only, no session arrays)
//   • /api/sessions/:email → lazy-loaded only on drill-down
//   • /api/track    → rate-limited (20 req/min/user), 2mb body cap
//   • /api/heartbeat → 1 KB in, 1 KB out, O(1)
//   • Gzip on all JSON responses
//   • ETag on /api/summary — 304 when nothing changed (dashboard skips render)
//   • Persist debounce capped at 10 s so rapid traffic can't delay writes forever
//   • _keySet rebuilt once at startup, maintained in-memory

const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const zlib    = require('zlib');

const app        = express();
const PORT       = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE  = path.join(__dirname, 'data.json');
const ACTIVE_MS  = 5 * 60 * 1000; // 5 minutes

// ── In-memory store ───────────────────────────────────────────────────────────
let store = { contributors: {}, lastWrite: null };

try {
  if (fs.existsSync(DATA_FILE)) {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    store = JSON.parse(raw);
    // Rebuild all _keySets once at startup (not per-request)
    for (const c of Object.values(store.contributors || {})) {
      c._keySet = new Set((c.sessions || []).map(s =>
        (s.taskId || '') + '_' + (s.startTime || 0)
      ));
    }
    const count    = Object.keys(store.contributors || {}).length;
    const sessions = Object.values(store.contributors || {})
      .reduce((a, c) => a + (c.sessions || []).length, 0);
    console.log(`[Tasky] Loaded: ${count} contributors, ${sessions} sessions`);
  }
} catch (e) { console.log('[Tasky] Fresh data store'); }

// ── Persist — debounced but capped so rapid traffic never delays > 10s ────────
let writeTimer     = null;
let pendingWrite   = false;
let firstPendingAt = null;
const DEBOUNCE_MS  = 2000;
const MAX_DELAY_MS = 10000;

function schedulePersist() {
  pendingWrite = true;
  if (!firstPendingAt) firstPendingAt = Date.now();
  if (Date.now() - firstPendingAt >= MAX_DELAY_MS) {
    if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
    flushToDisk(); return;
  }
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(flushToDisk, DEBOUNCE_MS);
}

function flushToDisk() {
  writeTimer = null; firstPendingAt = null; pendingWrite = false;
  try {
    const out = { contributors: {}, lastWrite: Date.now() };
    for (const [email, c] of Object.entries(store.contributors || {})) {
      const { _keySet, ...rest } = c;
      out.contributors[email] = rest;
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(out));
    store.lastWrite = out.lastWrite;
  } catch (e) { console.error('[Tasky] Persist error:', e.message); }
}

process.on('SIGTERM', () => { if (pendingWrite) flushToDisk(); process.exit(0); });
process.on('SIGINT',  () => { if (pendingWrite) flushToDisk(); process.exit(0); });

// ── Summary cache + ETag (invalidated on every write) ─────────────────────────
let summaryCache   = null;
let summaryEtag    = null;
let summaryVersion = 0;

function bumpVersion() { summaryVersion++; summaryCache = null; summaryEtag = null; }

function buildSummary() {
  if (summaryCache) return { cache: summaryCache, etag: summaryEtag };
  const now      = Date.now();
  const contribs = [];
  for (const c of Object.values(store.contributors || {})) {
    const lastSeenMs = c.lastSeen ? new Date(c.lastSeen).getTime() : 0;
    contribs.push({
      email:        c.email,
      lastSeen:     c.lastSeen || null,
      currentTask:  c.currentTask  || null,
      parkedTasks:  c.parkedTasks  || [],
      active:       (now - lastSeenMs) < ACTIVE_MS,
      sessionCount: (c.sessions || []).length,
      allTimeTasks: c.allTimeTasks || 0,
      totalTimeMs:  c.totalTimeMs  || 0,
    });
  }
  summaryCache = JSON.stringify({ contributors: contribs, lastWrite: store.lastWrite });
  summaryEtag  = `"v${summaryVersion}"`;
  return { cache: summaryCache, etag: summaryEtag };
}

// ── Rate limiter — token bucket per email ─────────────────────────────────────
const rateBuckets = new Map();
const RATE_MAX    = 20;     // requests
const RATE_WIN    = 60000;  // per minute

function checkRate(email) {
  const now    = Date.now();
  let   bucket = rateBuckets.get(email);
  if (!bucket || now - bucket.last > RATE_WIN) bucket = { tokens: RATE_MAX, last: now };
  if (bucket.tokens <= 0) return false;
  bucket.tokens--;
  rateBuckets.set(email, bucket);
  return true;
}
setInterval(() => {
  const cutoff = Date.now() - RATE_WIN * 2;
  for (const [k, v] of rateBuckets) if (v.last < cutoff) rateBuckets.delete(k);
}, 300000);

// ── Gzip helper ───────────────────────────────────────────────────────────────
function gzipJSON(res, jsonStr) {
  zlib.gzip(Buffer.from(jsonStr, 'utf8'), (err, gz) => {
    if (err) { res.setHeader('Content-Type','application/json'); res.end(jsonStr); return; }
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Length', gz.length);
    res.end(gz);
  });
}

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.text({ limit: '2mb' }));
app.use(express.static(PUBLIC_DIR));

// ── GET / ─────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const idx = path.join(PUBLIC_DIR, 'index.html');
  fs.existsSync(idx) ? res.sendFile(idx) : res.send('<h2>Tasky API running</h2>');
});

// ── POST /api/track ────────────────────────────────────────────────────────────
app.post('/api/track', (req, res) => {
  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) { body = {}; } }

    const { email, sessions = [], current, parkedTasks = [], allTimeTasks, totalTimeMs } = body;
    if (!email) return res.status(400).json({ error: 'email required' });
    if (!checkRate(email)) return res.status(429).json({ error: 'too many requests' });

    if (!store.contributors) store.contributors = {};
    const c = store.contributors[email] || { email, sessions: [], lastSeen: null, allTimeTasks: 0, totalTimeMs: 0 };
    if (!c._keySet) c._keySet = new Set((c.sessions||[]).map(s => (s.taskId||'')+'_'+(s.startTime||0)));

    let added = 0;
    for (const s of sessions) {
      const k = (s.taskId||'') + '_' + (s.startTime||0);
      if (!c._keySet.has(k)) { c.sessions.push(s); c._keySet.add(k); added++; }
    }

    c.lastSeen     = new Date().toISOString();
    c.currentTask  = current      || null;
    c.parkedTasks  = parkedTasks;
    c.allTimeTasks = allTimeTasks  || c.sessions.filter(s => !s.isRevisit).length;
    c.totalTimeMs  = totalTimeMs   || c.sessions.reduce((a,s) => a+(s.durationMs||0), 0);
    store.contributors[email] = c;
    bumpVersion();
    schedulePersist();

    res.json({ ok: true, newSessions: added, total: c.sessions.length });
  } catch(e) { console.error('[Tasky] /track:', e.message); res.status(500).json({ error: e.message }); }
});

// ── POST /api/heartbeat ───────────────────────────────────────────────────────
app.post('/api/heartbeat', (req, res) => {
  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) { body = {}; } }
    const { email, current } = body;
    if (!email) return res.status(400).json({ error: 'email required' });
    if (!checkRate(email)) return res.status(429).json({ error: 'too many requests' });

    const c = store.contributors && store.contributors[email];
    if (!c) return res.json({ ok: true, note: 'unknown contributor' });

    c.lastSeen = new Date().toISOString();
    if ('current' in body) c.currentTask = current || null;
    bumpVersion();
    schedulePersist();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/summary — dashboard polls this (tiny, ETag-cached) ───────────────
app.get('/api/summary', (req, res) => {
  const { cache, etag } = buildSummary();
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'no-cache');
  gzipJSON(res, cache);
});

// ── GET /api/sessions/:email — lazy drill-down ────────────────────────────────
app.get('/api/sessions/:email', (req, res) => {
  const email = decodeURIComponent(req.params.email);
  const c     = store.contributors && store.contributors[email];
  if (!c) return res.status(404).json({ error: 'not found' });

  const filter = req.query.filter || 'today';
  const now    = new Date();
  const today  = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let sessions = (c.sessions || []).filter(s => !s.isRevisit && s.startTime);

  if (filter === 'today') {
    sessions = sessions.filter(s => s.startTime >= today.getTime());
  } else if (filter === 'yesterday') {
    const y = new Date(today); y.setDate(y.getDate() - 1);
    sessions = sessions.filter(s => s.startTime >= y.getTime() && s.startTime < today.getTime());
  } else if (filter === 'week') {
    const w = new Date(today); w.setDate(w.getDate() - 7);
    sessions = sessions.filter(s => s.startTime >= w.getTime());
  } else if (filter === 'custom' && req.query.date) {
    const cd = new Date(req.query.date), ce = new Date(cd); ce.setDate(ce.getDate() + 1);
    sessions = sessions.filter(s => s.startTime >= cd.getTime() && s.startTime < ce.getTime());
  }

  sessions.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
  gzipJSON(res, JSON.stringify({ email, sessions: sessions.slice(0, 500) }));
});

// ── GET /api/data — legacy compat (capped at 1000 sessions/user) ──────────────
app.get('/api/data', (req, res) => {
  const clean = { contributors: {} };
  for (const [email, c] of Object.entries(store.contributors || {})) {
    const { _keySet, ...rest } = c;
    clean.contributors[email] = { ...rest, sessions: (rest.sessions || []).slice(-1000) };
  }
  gzipJSON(res, JSON.stringify(clean));
});

// ── GET /api/stats ────────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const now = Date.now();
  const stats = { contributors: 0, totalSessions: 0, activeSessions: 0, lastUpdated: store.lastWrite };
  for (const c of Object.values(store.contributors || {})) {
    stats.contributors++;
    stats.totalSessions += (c.sessions || []).length;
    if ((now - new Date(c.lastSeen || 0).getTime()) < ACTIVE_MS) stats.activeSessions++;
  }
  res.json(stats);
});

// ── GET /api/export ───────────────────────────────────────────────────────────
app.get('/api/export', (req, res) => {
  const pad    = n => String(n).padStart(2,'0');
  const fmtDur = ms => { if(!ms||ms<0) return '00:00:00'; const s=Math.floor(ms/1000),h=Math.floor(s/3600),m=Math.floor((s%3600)/60),r=s%60; return `${pad(h)}:${pad(m)}:${pad(r)}`; };
  const fmtISO = ts => ts ? new Date(ts).toISOString() : '';

  // Build time window from ?filter=today|yesterday|week|all|custom & ?date=YYYY-MM-DD
  const filter   = req.query.filter || 'all';
  const now      = new Date();
  const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  let startMs = null, endMs = null;

  if (filter === 'today') {
    startMs = todayUTC.getTime();
  } else if (filter === 'yesterday') {
    endMs   = todayUTC.getTime();
    startMs = endMs - 86400000;
  } else if (filter === 'week') {
    startMs = todayUTC.getTime() - 7 * 86400000;
  } else if (filter === 'custom' && req.query.date) {
    const parts = req.query.date.split('-').map(Number);
    const cd    = new Date(Date.UTC(parts[0], parts[1]-1, parts[2]));
    startMs = cd.getTime();
    endMs   = startMs + 86400000;
  }
  // filter === 'all': no time filter

  // Friendly filename
  const labelMap = { today:'today', yesterday:'yesterday', week:'this-week', all:'all-time', custom: req.query.date||'custom' };
  const label    = labelMap[filter] || 'all-time';
  const filename = `tasky-team-${label}-${now.toISOString().split('T')[0]}.csv`;

  // Optional single-contributor filter
  const emailFilter = req.query.email || null;
  const contribs    = Object.values(store.contributors || {})
    .filter(c => !emailFilter || c.email === emailFilter);

  const rows = [['Email','Task Name','Job Name','Stage','Status',
    'Date (UTC)','Start Time (UTC)','End Time (UTC)','Start (ISO)','End (ISO)','Duration','Task Link']];

  for (const c of contribs) {
    for (const s of (c.sessions || [])) {
      if (s.isRevisit) continue;
      const st = s.startTime || 0;
      if (!st) continue;
      if (startMs !== null && st < startMs) continue;
      if (endMs   !== null && st >= endMs)  continue;
      const et = st + (s.durationMs || 0);
      const si = fmtISO(st), ei = fmtISO(et);
      rows.push([
        c.email,
        `"${(s.taskName||'').replace(/"/g,'""')}"`,
        `"${(s.jobName ||'').replace(/"/g,'""')}"`,
        s.stage||'', s.status||'Completed',
        si?si.slice(0,10):'', si?si.slice(11,19)+' UTC':'', ei?ei.slice(11,19)+' UTC':'',
        si, ei, fmtDur(s.durationMs), s.url||'',
      ]);
    }
  }

  const csv = rows.map(r => r.join(',')).join('\n');
  res.setHeader('Content-Type','text/csv;charset=utf-8');
  res.setHeader('Content-Disposition', `attachment;filename="${filename}"`);
  res.send(csv);
});
// ── GET /api/health ───────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const contributors = Object.keys(store.contributors || {}).length;
  const sessions     = Object.values(store.contributors || {}).reduce((a,c) => a+(c.sessions||[]).length, 0);
  res.json({ ok:true, contributors, sessions, time: new Date().toISOString(), version: summaryVersion });
});

app.listen(PORT, () => {
  console.log(`✅ Tasky Dashboard v8 (scale edition) — port ${PORT}`);
  console.log(`   /api/summary   ETag-cached, gzipped metadata`);
  console.log(`   /api/sessions/:email   lazy drill-down`);
  console.log(`   /api/heartbeat   O(1) presence ping`);
});
