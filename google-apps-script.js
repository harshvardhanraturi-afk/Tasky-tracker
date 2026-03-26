/**
 * TASKY TRACKER — Google Apps Script v7
 * ======================================
 * Receives task data from the Tasky extension and writes it to Google Sheets.
 *
 * SETUP:
 * 1. Go to https://script.google.com → New project
 * 2. Paste this entire file (replace existing code)
 * 3. Deploy → New deployment → Web App
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 4. Copy the Web App URL
 * 5. In the Tasky extension → 📡 API → paste URL into "Google Sheets Script URL"
 *
 * COLUMNS (per contributor sheet):
 * Email | Task Name | Job Name | Stage | Status | Date | Day | Start Time | End Time | Duration | URL
 *
 * A "📊 Summary" sheet is auto-updated with everyone's daily totals.
 */

// ── Entry point ────────────────────────────────────────────────────────────────

function doPost(e) {
  try {
    const raw  = e.postData ? e.postData.contents : '{}';
    const data = JSON.parse(raw);
    if (!data.email) {
      return respond({ ok: false, error: 'email required' });
    }
    const result = processContributorData(data);
    return respond({ ok: true, ...result });
  } catch(err) {
    Logger.log('Error: ' + err.message);
    return respond({ ok: false, error: err.message });
  }
}

function doGet(e) {
  return respond({ ok: true, message: 'Tasky Sheet is live! Use POST to send data.' });
}

function respond(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Process one contributor's data ────────────────────────────────────────────

function processContributorData(data) {
  const ss       = SpreadsheetApp.getActiveSpreadsheet();
  const email    = data.email;
  const sessions = data.sessions || [];

  // Sheet name = email prefix (e.g. "john" from "john@company.com")
  const sheetName = email.split('@')[0].replace(/[^a-zA-Z0-9_\- ]/g, '').slice(0, 30) || 'contributor';
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    setupContributorSheet(sheet);
  }

  // Build set of existing row keys to avoid duplicates
  // Key = startTime + taskName + status (robust even if taskId changes)
  const existingData = sheet.getDataRange().getValues();
  const existingKeys = new Set();
  for (let i = 1; i < existingData.length; i++) {
    const row = existingData[i];
    // startTime is col 7 (index 6) stored as Date object or timestamp string
    const st  = row[6] ? new Date(row[6]).getTime() : 0;
    const key = `${st}_${row[1]}_${row[4]}`; // startTime_taskName_status
    if (st) existingKeys.add(key);
  }

  let newCount = 0;
  const rowsToAppend = [];

  for (const s of sessions) {
    if (s.isRevisit) continue;

    const startMs = s.startTime || 0;
    const endMs   = s.endTime   || 0;
    const status  = s.status    || 'Completed';
    const key     = `${startMs}_${(s.taskName||'')}_${status}`;
    if (existingKeys.has(key)) continue;

    rowsToAppend.push([
      email,                            // A: Email
      s.taskName  || '',                // B: Task Name
      s.jobName   || '',                // C: Job Name
      s.stage     || 'Unknown',         // D: Stage
      status,                           // E: Status
      startMs ? fmtDate(startMs) : '',  // F: Date  (DD/MM/YYYY)
      startMs ? fmtDay(startMs)  : '',  // G: Day   (Monday, Tuesday…)
      startMs ? fmtTime(startMs) : '',  // H: Start Time (HH:MM:SS AM/PM)
      endMs   ? fmtTime(endMs)   : '',  // I: End Time
      formatDuration(s.durationMs || 0),// J: Duration (HH:MM:SS)
      s.url       || ''                 // K: URL
    ]);
    newCount++;
  }

  if (rowsToAppend.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rowsToAppend.length, 11)
         .setValues(rowsToAppend);
  }

  // Refresh summary sheet
  updateSummarySheet(ss);

  Logger.log('[Tasky] ' + email + ': +' + newCount + ' new sessions');
  return { newSessions: newCount, sheet: sheetName };
}

// ── Set up a fresh contributor sheet ──────────────────────────────────────────

function setupContributorSheet(sheet) {
  const headers = [
    'Email', 'Task Name', 'Job Name', 'Stage', 'Status',
    'Date', 'Day', 'Start Time', 'End Time', 'Duration', 'URL'
  ];
  sheet.appendRow(headers);

  // Style header
  const hRange = sheet.getRange(1, 1, 1, headers.length);
  hRange.setBackground('#1a73e8')
        .setFontColor('#ffffff')
        .setFontWeight('bold')
        .setFontSize(11);
  sheet.setFrozenRows(1);

  // Column widths
  sheet.setColumnWidth(1,  180); // Email
  sheet.setColumnWidth(2,  240); // Task Name
  sheet.setColumnWidth(3,  240); // Job Name
  sheet.setColumnWidth(4,  120); // Stage
  sheet.setColumnWidth(5,  90);  // Status
  sheet.setColumnWidth(6,  100); // Date
  sheet.setColumnWidth(7,  100); // Day
  sheet.setColumnWidth(8,  120); // Start Time
  sheet.setColumnWidth(9,  120); // End Time
  sheet.setColumnWidth(10, 90);  // Duration
  sheet.setColumnWidth(11, 320); // URL
}

// ── Summary sheet ──────────────────────────────────────────────────────────────

function updateSummarySheet(ss) {
  let summary = ss.getSheetByName('📊 Summary');
  if (!summary) summary = ss.insertSheet('📊 Summary', 0);
  summary.clearContents();

  const today = fmtDate(Date.now());

  summary.getRange('A1').setValue('Tasky Team Summary — ' + today)
         .setFontSize(14).setFontWeight('bold').setFontColor('#1a73e8');
  summary.getRange('A2').setValue('Updated: ' + new Date().toLocaleString())
         .setFontColor('#5f6368').setFontSize(10);

  const headers = ['Contributor', 'Email', 'Completed', 'Parked', 'Blocked',
                   'Total Time', 'Avg / Task', 'First Task', 'Last Task', 'Date'];
  summary.getRange(4, 1, 1, headers.length).setValues([headers]);
  summary.getRange(4, 1, 1, headers.length)
         .setBackground('#1a73e8').setFontColor('#fff').setFontWeight('bold').setFontSize(11);

  const sheets   = ss.getSheets();
  const dataRows = [];

  for (const sheet of sheets) {
    const name = sheet.getName();
    if (name === '📊 Summary') continue;

    const values = sheet.getDataRange().getValues();
    if (values.length < 2) continue;

    const email  = values[1][0] || name;
    let completed = 0, parked = 0, blocked = 0;
    let totalMs   = 0;
    let firstTs   = null, lastTs = null;

    for (let i = 1; i < values.length; i++) {
      const row    = values[i];
      const status = row[4] || 'Completed';  // col E = Status
      const dur    = parseDuration(row[9]);  // col J = Duration HH:MM:SS
      totalMs += dur;
      if (status === 'Completed') completed++;
      else if (status === 'Parked')  parked++;
      else if (status === 'Blocked') blocked++;
      // col H = Start Time string
      if (row[7]) {
        // Use the row index to track first/last task of day
        if (!firstTs) firstTs = row[7];
        lastTs = row[7];
      }
    }

    const avg = completed > 0 ? formatDuration(Math.round(totalMs / completed)) : '—';
    dataRows.push([
      name, email, completed, parked, blocked,
      formatDuration(totalMs), avg,
      firstTs || '—', lastTs || '—', today
    ]);
  }

  if (dataRows.length > 0) {
    dataRows.sort((a, b) => b[2] - a[2]); // sort by completed desc
    summary.getRange(5, 1, dataRows.length, 10).setValues(dataRows);

    // Alternating row colours
    for (let i = 0; i < dataRows.length; i++) {
      summary.getRange(5 + i, 1, 1, 10)
             .setBackground(i % 2 === 0 ? '#f8fafd' : '#ffffff');
    }

    // Widen columns
    [160, 200, 80, 70, 70, 100, 100, 120, 120, 110].forEach((w, i) => {
      summary.setColumnWidth(i + 1, w);
    });
  } else {
    summary.getRange('A5').setValue('No data yet.')
           .setFontColor('#9aa0a6').setFontStyle('italic');
  }

  summary.setFrozenRows(4);
}

// ── Date / time helpers ────────────────────────────────────────────────────────

function fmtDate(ts) {
  // Returns "26/03/2026"
  const d = new Date(ts);
  return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear();
}

function fmtDay(ts) {
  // Returns "Wednesday"
  return new Date(ts).toLocaleDateString('en-US', { weekday: 'long' });
}

function fmtTime(ts) {
  // Returns "02:34:00 PM"
  const d    = new Date(ts);
  let h      = d.getHours();
  const m    = d.getMinutes();
  const s    = d.getSeconds();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return pad(h) + ':' + pad(m) + ':' + pad(s) + ' ' + ampm;
}

function formatDuration(ms) {
  // Returns "01:23:45"
  if (!ms || ms < 0) return '00:00:00';
  const s = Math.floor(ms / 1000);
  return pad(Math.floor(s / 3600)) + ':' + pad(Math.floor((s % 3600) / 60)) + ':' + pad(s % 60);
}

function parseDuration(str) {
  // Parses "01:23:45" back to ms
  if (!str || typeof str !== 'string') return 0;
  const parts = str.split(':').map(Number);
  if (parts.length !== 3) return 0;
  return ((parts[0] * 3600) + (parts[1] * 60) + parts[2]) * 1000;
}

function pad(n) { return String(n).padStart(2, '0'); }
