// server.js — Tasky Dashboard v8
// SCALE: 100+ users, 300+ tasks/day per user (30,000+ tasks/day total)
// Deploy free on Render.com or Railway.app

const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app        = express();
const PORT       = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE  = path.join(__dirname, 'data.json');

// ── In-memory store with write-through to disk ────────────────────────────────
// Memory: instant reads for all API calls
// Disk:   survives server restarts
// This pattern handles 100+ concurrent users easily

let store = { contributors: {}, lastWrite: null };

// Load from disk on startup
try {
  if (fs.existsSync(DATA_FILE)) {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    store = JSON.parse(raw);
    const count = Object.keys(store.contributors || {}).length;
    const sessions = Object.values(store.contributors || {})
      .reduce((a, c) => a + (c.sessions||[]).length, 0);
    console.log(`[Tasky] Loaded: ${count} contributors, ${sessions} sessions`);
  }
} catch(e) { console.log('[Tasky] Fresh data store'); }

// Debounced disk write — prevents hammering disk on rapid requests
let writeTimer = null;
function schedulePersist() {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(store));
      store.lastWrite = Date.now();
    } catch(e) {}
    writeTimer = null;
  }, 2000); // write 2 seconds after last update
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.text({ limit: '10mb' }));
app.use(express.static(PUBLIC_DIR));

// ── GET / ─────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const idx = path.join(PUBLIC_DIR, 'index.html');
  fs.existsSync(idx) ? res.sendFile(idx) : res.send('<h2>✅ Tasky API running!</h2>');
});

// ── POST /api/track — auto-called by extension after every task ───────────────
app.post('/api/track', (req, res) => {
  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch(e) { body = {}; }
    }

    const { email, sessions = [], current, parkedTasks = [],
            allTimeTasks, totalTimeMs } = body;

    if (!email) return res.status(400).json({ error: 'email required' });

    if (!store.contributors) store.contributors = {};

    // Get or create contributor record
    const c = store.contributors[email] || {
      email,
      sessions: [],
      lastSeen: null,
      allTimeTasks: 0,
      totalTimeMs: 0
    };

    // Efficient dedup using a Set of keys
    // Key = taskId + startTime (unique per task occurrence)
    if (!c._keySet) {
      // Rebuild key set from existing sessions (only on first access)
      c._keySet = new Set(c.sessions.map(s =>
        (s.taskId||'') + '_' + (s.startTime||0)
      ));
    }

    let added = 0;
    for (const s of sessions) {
      const k = (s.taskId||'') + '_' + (s.startTime||0);
      if (!c._keySet.has(k)) {
        c.sessions.push(s);
        c._keySet.add(k);
        added++;
      }
    }

    c.lastSeen     = new Date().toISOString();
    c.currentTask  = current    || null;
    c.parkedTasks  = parkedTasks;
    c.allTimeTasks = allTimeTasks || c.sessions.filter(s => !s.isRevisit).length;
    c.totalTimeMs  = totalTimeMs  || c.sessions.reduce((a,s) => a+(s.durationMs||0), 0);

    store.contributors[email] = c;
    schedulePersist();

    console.log(`[Tasky] ${email}: +${added} sessions (total: ${c.sessions.length})`);
    res.json({ ok: true, newSessions: added, total: c.sessions.length });

  } catch(e) {
    console.error('[Tasky] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/data — dashboard reads (strips internal _keySet before sending) ──
app.get('/api/data', (req, res) => {
  // Return clean copy without internal _keySet fields
  const clean = { contributors: {} };
  for (const [email, c] of Object.entries(store.contributors || {})) {
    const { _keySet, ...rest } = c;
    clean.contributors[email] = rest;
  }
  res.json(clean);
});

// ── GET /api/stats — quick stats without full session data ────────────────────
app.get('/api/stats', (req, res) => {
  const stats = {
    contributors: 0,
    totalSessions: 0,
    activeSessions: 0,
    lastUpdated: store.lastWrite
  };
  for (const c of Object.values(store.contributors || {})) {
    stats.contributors++;
    stats.totalSessions += (c.sessions||[]).length;
    if (c.currentTask) stats.activeSessions++;
  }
  res.json(stats);
});

// ── GET /api/export — download full team CSV ──────────────────────────────────
// TIMEZONE FIX: We store raw UTC timestamps (ms) in sessions.
// The server runs in UTC — using getHours() would give UTC hours, not local time.
// Solution: export raw ISO strings and let the user's browser/Excel/Sheets handle timezone.
// Also compute endTime = startTime + durationMs (always correct, no clock mismatch).
app.get('/api/export', (req, res) => {
  function pad(n) { return String(n).padStart(2,'0'); }

  function fmtDuration(ms) {
    if (!ms || ms < 0) return '00:00:00';
    const s=Math.floor(ms/1000), h=Math.floor(s/3600), m=Math.floor((s%3600)/60), r=s%60;
    return `${pad(h)}:${pad(m)}:${pad(r)}`;
  }

  // Returns "HH:MM:SS AM/PM" using UTC — but we embed timezone offset so user sees local time
  // Strategy: use ISO string slice — unambiguous, Excel/Sheets auto-converts to local timezone
  function fmtISO(ts) {
    if (!ts) return '';
    return new Date(ts).toISOString(); // e.g. "2026-03-26T18:11:00.000Z"
  }

  const rows = [[
    'Email','Task Name','Job Name','Stage','Status',
    'Date (UTC)','Start Time (UTC)','End Time (UTC)','Start (ISO)','End (ISO)','Duration','Task Link'
  ]];

  for (const c of Object.values(store.contributors||{})) {
    for (const s of (c.sessions||[])) {
      if (s.isRevisit) continue;
      const startTs = s.startTime   || 0;
      // ALWAYS compute endTime as startTime + durationMs — never trust stored endTime
      // This eliminates all clock mismatch issues between content.js and background.js
      const endTs   = startTs ? startTs + (s.durationMs || 0) : (s.endTime || 0);

      const startISO = fmtISO(startTs);
      const endISO   = fmtISO(endTs);

      // Date and time parts from ISO (always UTC, unambiguous)
      const startDate = startISO ? startISO.slice(0,10) : '';           // 2026-03-26
      const startTime = startISO ? startISO.slice(11,19) + ' UTC' : ''; // 18:11:00 UTC
      const endTime   = endISO   ? endISO.slice(11,19)   + ' UTC' : ''; // 18:13:04 UTC

      rows.push([
        c.email,
        `"${(s.taskName||'').replace(/"/g,'""')}"`,
        `"${(s.jobName||'').replace(/"/g,'""')}"`,
        s.stage  || '',
        s.status || 'Completed',
        startDate,
        startTime,
        endTime,
        startISO,
        endISO,
        fmtDuration(s.durationMs),
        s.url || ''
      ]);
    }
  }

  const csv = rows.map(r=>r.join(',')).join('\n');
  res.setHeader('Content-Type','text/csv;charset=utf-8');
  res.setHeader('Content-Disposition',
    `attachment;filename="tasky-team-${new Date().toISOString().split('T')[0]}.csv"`);
  res.send(csv);
});

// ── GET /api/health ───────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const contributors = Object.keys(store.contributors||{}).length;
  const sessions     = Object.values(store.contributors||{})
    .reduce((a,c) => a+(c.sessions||[]).length, 0);
  res.json({ ok:true, contributors, sessions, time: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`✅ Tasky Dashboard v8`);
  console.log(`   Port: ${PORT}`);
  console.log(`   Dashboard: http://localhost:${PORT}`);
  console.log(`   API: POST http://localhost:${PORT}/api/track`);
  console.log(`   Export: GET http://localhost:${PORT}/api/export`);
});
