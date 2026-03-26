// server.js — Tasky Dashboard Backend v7
// Run: npm install && node server.js
// Data stored in data.json (no database needed)
// Dashboard at: http://localhost:3000

const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app       = express();
const PORT      = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Load / save data ──────────────────────────────────────────────────────────

function loadData() {
  if (!fs.existsSync(DATA_FILE)) return { contributors: {} };
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch(e) { return { contributors: {} }; }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ── POST /api/track — receives data from extension ────────────────────────────

app.post('/api/track', (req, res) => {
  try {
    const { email, sessions, current, parkedTasks, allTimeTasks, totalTimeMs, exported_at } = req.body;

    if (!email) return res.status(400).json({ error: 'email required' });

    const data = loadData();
    if (!data.contributors) data.contributors = {};

    const existing = data.contributors[email] || { email, sessions: [], lastSeen: null };

    // Merge sessions — deduplicate by startTime + taskId
    const existingKeys = new Set(existing.sessions.map(s => `${s.startTime}_${s.taskId}_${s.status||'Completed'}`));
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
    existing.totalTimeMs  = totalTimeMs  || existing.sessions.reduce((a, s) => a + (s.durationMs || 0), 0);
    existing.currentTask  = current     || null;
    existing.parkedTasks  = parkedTasks || [];

    data.contributors[email] = existing;
    saveData(data);

    console.log(`[Tasky] ${email} synced — ${newCount} new sessions`);
    res.json({ ok: true, newSessions: newCount });

  } catch(e) {
    console.error('[Tasky] Error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/data ─────────────────────────────────────────────────────────────

app.get('/api/data', (req, res) => {
  res.json(loadData());
});

// ── GET /api/export — full team CSV ───────────────────────────────────────────

app.get('/api/export', (req, res) => {
  const data = loadData();
  const rows = [['Email','Task ID','Task Name','Job Name','Stage','Status','Date',
                 'Start Time','End Time','Duration(s)','Duration','URL']];

  for (const [email, contrib] of Object.entries(data.contributors || {})) {
    for (const s of (contrib.sessions || [])) {
      if (s.isRevisit) continue;
      rows.push([
        email,
        s.taskId   || '',
        `"${(s.taskName||'').replace(/"/g,'""')}"`,
        `"${(s.jobName||'').replace(/"/g,'""')}"`,
        s.stage    || 'Unknown',
        s.status   || 'Completed',
        s.dateStr  || '',
        s.startTime ? new Date(s.startTime).toLocaleTimeString() : '',
        s.endTime   ? new Date(s.endTime).toLocaleTimeString()   : '',
        Math.floor((s.durationMs||0)/1000),
        formatDuration(s.durationMs||0),
        s.url || ''
      ]);
    }
  }

  const csv = rows.map(r => r.join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="tasky-team-${new Date().toISOString().split('T')[0]}.csv"`);
  res.send(csv);
});

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(r).padStart(2,'0')}`;
}

app.listen(PORT, () => {
  console.log(`\n✅ Tasky Dashboard running at http://localhost:${PORT}`);
  console.log(`📊 Dashboard:    http://localhost:${PORT}`);
  console.log(`📡 API endpoint: http://localhost:${PORT}/api/track\n`);
});
