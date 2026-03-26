// server.js — Tasky Dashboard v7
// Designed to run on Render.com (free tier) or locally
// Data: stored in memory + written to data.json when disk is available

const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// On Render, __dirname is the folder containing server.js
// public/ must be a subfolder of that same folder
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE  = path.join(__dirname, 'data.json');

// ── In-memory store (survives requests, lost on restart — that's ok for a dashboard) ──
let memoryStore = { contributors: {} };

// Try to load from disk on startup
try {
  if (fs.existsSync(DATA_FILE)) {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    memoryStore = JSON.parse(raw);
    console.log('[Tasky] Loaded existing data from disk');
  }
} catch(e) {
  console.log('[Tasky] Starting with fresh data store');
}

function loadData()    { return memoryStore; }
function saveData(data) {
  memoryStore = data;
  // Write to disk if possible (won't work on Render free tier but no harm trying)
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); } catch(e) {}
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.text({ limit: '10mb' })); // for extension no-cors text/plain fallback

// Serve dashboard HTML from public/
app.use(express.static(PUBLIC_DIR));

// ── Safety net: explicit GET / to make sure dashboard always loads ─────────────
app.get('/', (req, res) => {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.send(`
      <h2 style="font-family:sans-serif;padding:40px">
        ✅ Tasky API is running!<br><br>
        <span style="font-size:16px;color:#666">
          But <code>public/index.html</code> was not found.<br>
          Make sure your GitHub repo has a <code>public/</code> folder with <code>index.html</code> inside it.
        </span>
      </h2>
    `);
  }
});

// ── POST /api/track — receives data from extension ────────────────────────────
app.post('/api/track', (req, res) => {
  try {
    // Handle both JSON body and text/plain body (extension sends text/plain in no-cors mode)
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch(e) { body = {}; }
    }

    const { email, sessions, current, parkedTasks, allTimeTasks, totalTimeMs, exported_at } = body;
    if (!email) return res.status(400).json({ error: 'email required' });

    const data     = loadData();
    if (!data.contributors) data.contributors = {};

    const existing = data.contributors[email] || { email, sessions: [], lastSeen: null };

    // Merge sessions — deduplicate by startTime + taskId + status
    const existingKeys = new Set(
      existing.sessions.map(s => `${s.startTime}_${s.taskId}_${s.status||'Completed'}`)
    );
    let newCount = 0;
    for (const s of (sessions || [])) {
      const key = `${s.startTime}_${s.taskId}_${s.status||'Completed'}`;
      if (!existingKeys.has(key)) {
        existing.sessions.push(s);
        newCount++;
      }
    }

    existing.lastSeen     = exported_at || new Date().toISOString();
    existing.allTimeTasks = allTimeTasks || 0;
    existing.totalTimeMs  = totalTimeMs  || existing.sessions.reduce((a,s) => a + (s.durationMs||0), 0);
    existing.currentTask  = current      || null;
    existing.parkedTasks  = parkedTasks  || [];

    data.contributors[email] = existing;
    saveData(data);

    console.log(`[Tasky] ✅ ${email} synced — ${newCount} new sessions`);
    res.json({ ok: true, newSessions: newCount });

  } catch(e) {
    console.error('[Tasky] Error in /api/track:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/data — returns all data to dashboard ─────────────────────────────
app.get('/api/data', (req, res) => {
  res.json(loadData());
});

// ── GET /api/export — full team CSV download ──────────────────────────────────
app.get('/api/export', (req, res) => {
  const data = loadData();
  // Columns match extension export: no Task ID, separate Date/Day/StartTime/EndTime
  const rows = [['Email','Task Name','Job Name','Stage','Status',
                 'Date','Day','Start Time','End Time','Duration','URL']];

  for (const [email, contrib] of Object.entries(data.contributors || {})) {
    for (const s of (contrib.sessions || [])) {
      if (s.isRevisit) continue;
      rows.push([
        email,
        `"${(s.taskName||'').replace(/"/g,'""')}"`,
        `"${(s.jobName||'').replace(/"/g,'""')}"`,
        s.stage  || 'Unknown',
        s.status || 'Completed',
        fmtDate(s.startTime),
        fmtDay(s.startTime),
        fmtTime12(s.startTime),
        fmtTime12(s.endTime),
        formatDuration(s.durationMs||0),
        s.url || ''
      ]);
    }
  }

  const csv = rows.map(r => r.join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition',
    `attachment; filename="tasky-team-${new Date().toISOString().split('T')[0]}.csv"`);
  res.send(csv);
});

// ── Health check (Render pings this to keep server awake) ─────────────────────
app.get('/health', (req, res) => res.json({ ok: true, contributors: Object.keys(loadData().contributors||{}).length }));

function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return String(d.getDate()).padStart(2,'0') + '/' + String(d.getMonth()+1).padStart(2,'0') + '/' + d.getFullYear();
}
function fmtDay(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('en-US', { weekday: 'long' });
}
function fmtTime12(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  let h = d.getHours(); const m = d.getMinutes(), s = d.getSeconds();
  const ampm = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0') + ' ' + ampm;
}
function formatDuration(ms) {
  const s = Math.floor(ms/1000);
  return `${String(Math.floor(s/3600)).padStart(2,'0')}:${String(Math.floor((s%3600)/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ Tasky Dashboard running on port ${PORT}`);
  console.log(`📊 Dashboard:    http://localhost:${PORT}`);
  console.log(`📡 API endpoint: http://localhost:${PORT}/api/track\n`);
});
