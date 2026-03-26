// server.js — Tasky Dashboard v8
// Supports 100+ users. Deploy on Render.com (free) or any Node.js host.
// Data persisted in data.json. In-memory cache for speed.

const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app        = express();
const PORT       = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE  = path.join(__dirname, 'data.json');

// In-memory store — fast reads, written to disk on every change
let store = { contributors: {} };

try {
  if (fs.existsSync(DATA_FILE)) {
    store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    console.log('[Tasky] Loaded data. Contributors:', Object.keys(store.contributors || {}).length);
  }
} catch(e) { console.log('[Tasky] Fresh start'); }

function persist() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2)); } catch(e) {}
}

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.text({ limit: '10mb' }));
app.use(express.static(PUBLIC_DIR));

app.get('/', (req, res) => {
  const idx = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(idx)) res.sendFile(idx);
  else res.send('<h2>✅ Tasky API running! Put index.html in the public/ folder.</h2>');
});

// ── POST /api/track — receives data from extension (auto-sent after each task) ──
app.post('/api/track', (req, res) => {
  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch(e) { body = {}; }
    }

    const { email, sessions, current, parkedTasks, allTimeTasks, totalTimeMs } = body;
    if (!email) return res.status(400).json({ error: 'email required' });

    if (!store.contributors) store.contributors = {};
    const existing = store.contributors[email] || { email, sessions: [], lastSeen: null };

    // Deduplicate by taskId + startTime
    const keys = new Set(existing.sessions.map(s => s.taskId + '_' + (s.startTime||0)));
    let added = 0;
    for (const s of (sessions || [])) {
      const k = s.taskId + '_' + (s.startTime||0);
      if (!keys.has(k)) { existing.sessions.push(s); keys.add(k); added++; }
    }

    existing.lastSeen      = new Date().toISOString();
    existing.currentTask   = current || null;
    existing.allTimeTasks  = allTimeTasks || existing.sessions.filter(s => !s.isRevisit).length;
    existing.totalTimeMs   = totalTimeMs  || existing.sessions.reduce((a,s) => a+(s.durationMs||0), 0);

    store.contributors[email] = existing;
    persist();

    console.log(`[Tasky] ${email} synced — ${added} new sessions`);
    res.json({ ok: true, newSessions: added });

  } catch(e) {
    console.error('[Tasky] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/data — dashboard reads all contributor data ─────────────────────
app.get('/api/data', (req, res) => {
  res.json(store);
});

// ── GET /api/export — download full team CSV ──────────────────────────────────
app.get('/api/export', (req, res) => {
  function pad(n) { return String(n).padStart(2,'0'); }
  function fmtMs(ms) {
    if (!ms) return '00:00:00';
    const s=Math.floor(ms/1000),h=Math.floor(s/3600),m=Math.floor((s%3600)/60),r=s%60;
    return `${pad(h)}:${pad(m)}:${pad(r)}`;
  }
  function fmtDate(ts) {
    if (!ts) return '';
    const d=new Date(ts);
    return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()}`;
  }
  function fmtTime(ts) {
    if (!ts) return '';
    const d=new Date(ts);
    let h=d.getHours(),m=d.getMinutes(),s=d.getSeconds();
    const ap=h>=12?'PM':'AM'; h=h%12||12;
    return `${pad(h)}:${pad(m)}:${pad(s)} ${ap}`;
  }

  const rows = [['Email','Task Name','Job Name','Stage','Status','Date','Start Time','End Time','Duration']];
  for (const [email, c] of Object.entries(store.contributors||{})) {
    for (const s of (c.sessions||[])) {
      if (s.isRevisit) continue;
      rows.push([
        email,
        `"${(s.taskName||'').replace(/"/g,'""')}"`,
        `"${(s.jobName||'').replace(/"/g,'""')}"`,
        s.stage||'',
        s.status||'Completed',
        fmtDate(s.startTime),
        fmtTime(s.startTime),
        fmtTime(s.endTime),
        fmtMs(s.durationMs)
      ]);
    }
  }

  const csv = rows.map(r=>r.join(',')).join('\n');
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition',`attachment;filename="tasky-team-${new Date().toISOString().split('T')[0]}.csv"`);
  res.send(csv);
});

// ── GET /api/health ───────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ ok: true, contributors: Object.keys(store.contributors||{}).length, time: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`✅ Tasky Dashboard v8 running on port ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
  console.log(`📡 API: http://localhost:${PORT}/api/track`);
});
