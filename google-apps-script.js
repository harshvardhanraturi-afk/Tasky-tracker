/**
 * TASKY TRACKER — Google Apps Script v8
 * ======================================
 * Receives task data from the Tasky extension and writes it to Google Sheets.
 * Handles 100+ users, 300+ tasks/day efficiently.
 *
 * SETUP (one time, team lead):
 * 1. Go to https://script.google.com → New project → paste this file
 * 2. Deploy → New deployment → Web App
 *    Execute as: Me  |  Who has access: Anyone
 * 3. Copy the Web App URL
 * 4. In each person's Tasky extension → 📡 API → paste URL → Save & Connect
 *
 * COLUMNS (per person sheet):
 * Email | Task Name | Job Name | Stage | Status | Date | Day |
 * Start Time | End Time | Duration | Task Link
 *
 * 📊 Summary sheet: auto-updated with everyone's daily totals
 */

// ── Entry points ──────────────────────────────────────────────────────────────

function doPost(e) {
  try {
    const raw  = e.postData ? e.postData.contents : '{}';
    const data = JSON.parse(raw);
    if (!data.email) return respond({ ok: false, error: 'email required' });
    const result = processContributorData(data);
    return respond({ ok: true, ...result });
  } catch(err) {
    Logger.log('doPost error: ' + err.message);
    return respond({ ok: false, error: err.message });
  }
}

function doGet(e) {
  return respond({ ok: true, message: 'Tasky Sheet v8 is live!' });
}

function respond(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Process one contributor ────────────────────────────────────────────────────

function processContributorData(data) {
  const ss       = SpreadsheetApp.getActiveSpreadsheet();
  const email    = data.email;
  const sessions = data.sessions || [];

  // Sheet name = email prefix (e.g. "john" from "john@company.com")
  const sheetName = email.split('@')[0]
    .replace(/[^a-zA-Z0-9_\- ]/g, '').slice(0, 30) || 'contributor';

  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    setupSheet(sheet);
  }

  // Read all existing keys in one batch (fast — one API call)
  const lastRow = sheet.getLastRow();
  const existingKeys = new Set();

  if (lastRow > 1) {
    // Read only cols A (email), B (taskName), H (startTime) for dedup
    const existing = sheet.getRange(2, 1, lastRow - 1, 8).getValues();
    for (const row of existing) {
      // Key: startTime string + taskName — robust dedup
      const key = String(row[7]) + '_' + String(row[1]);
      if (row[7]) existingKeys.add(key);
    }
  }

  const rowsToAdd = [];

  for (const s of sessions) {
    if (s.isRevisit) continue;

    const startMs = s.startTime || 0;
    const endMs   = s.endTime   || 0;
    const status  = s.status    || 'Completed';

    // Dedup key: formatted startTime + taskName
    const startStr = startMs ? fmtTime(startMs) : '';
    const key = startStr + '_' + (s.taskName || '');
    if (existingKeys.has(key)) continue;

    // Build task link from URL
    const taskLink = s.url || '';

    rowsToAdd.push([
      email,                             // A: Email
      s.taskName  || '',                 // B: Task Name
      s.jobName   || '',                 // C: Job Name
      s.stage     || 'Unknown',          // D: Stage
      status,                            // E: Status
      startMs ? fmtDate(startMs) : '',   // F: Date (DD/MM/YYYY)
      startMs ? fmtDay(startMs)  : '',   // G: Day (Monday…)
      startMs ? fmtTime(startMs) : '',   // H: Start Time (HH:MM:SS AM/PM)
      endMs   ? fmtTime(endMs)   : '',   // I: End Time
      formatDuration(s.durationMs || 0), // J: Duration (HH:MM:SS)
      taskLink                           // K: Task Link ← RESTORED
    ]);

    existingKeys.add(key);
  }

  // Batch write — one API call for all rows (fast even for 300 rows)
  if (rowsToAdd.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rowsToAdd.length, 11)
         .setValues(rowsToAdd);

    // Make task links clickable
    const startRow = sheet.getLastRow() - rowsToAdd.length + 1;
    for (let i = 0; i < rowsToAdd.length; i++) {
      const url = rowsToAdd[i][10];
      if (url) {
        const cell = sheet.getRange(startRow + i, 11);
        cell.setFormula(`=HYPERLINK("${url}","Open Task")`);
      }
    }

    applyStatusColors(sheet, sheet.getLastRow() - rowsToAdd.length + 1, rowsToAdd.length);
  }

  // Refresh summary (rate-limit: only if this is a meaningful update)
  if (rowsToAdd.length > 0) {
    updateSummarySheet(ss);
  }

  Logger.log('[Tasky] ' + email + ': +' + rowsToAdd.length + ' new sessions');
  return { newSessions: rowsToAdd.length, sheet: sheetName };
}

// ── Set up fresh contributor sheet ────────────────────────────────────────────

function setupSheet(sheet) {
  const headers = [
    'Email', 'Task Name', 'Job Name', 'Stage', 'Status',
    'Date', 'Day', 'Start Time', 'End Time', 'Duration', 'Task Link'
  ];
  sheet.appendRow(headers);

  const hRange = sheet.getRange(1, 1, 1, headers.length);
  hRange.setBackground('#1a73e8')
        .setFontColor('#ffffff')
        .setFontWeight('bold')
        .setFontSize(11);
  sheet.setFrozenRows(1);

  // Column widths
  const widths = [180, 240, 240, 120, 90, 100, 100, 130, 130, 90, 200];
  widths.forEach((w, i) => sheet.setColumnWidth(i + 1, w));

  // Conditional formatting for Stage (col D) and Status (col E)
  const stageRules = [
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('Senior Review').setBackground('#fce8e6').setFontColor('#c5221f')
      .setRanges([sheet.getRange('D2:D5000')]).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('Review').setBackground('#e8f0fe').setFontColor('#1a73e8')
      .setRanges([sheet.getRange('D2:D5000')]).build()
  ];
  const statusRules = [
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('Completed').setBackground('#e6f4ea').setFontColor('#137333')
      .setRanges([sheet.getRange('E2:E5000')]).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('Parked').setBackground('#fff3e0').setFontColor('#e65100')
      .setRanges([sheet.getRange('E2:E5000')]).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('Blocked').setBackground('#fce8e6').setFontColor('#c5221f')
      .setRanges([sheet.getRange('E2:E5000')]).build()
  ];
  sheet.setConditionalFormatRules([...stageRules, ...statusRules]);
}

function applyStatusColors(sheet, startRow, numRows) {
  // Already handled by conditional formatting rules — no per-row work needed
}

// ── Summary sheet ──────────────────────────────────────────────────────────────

function updateSummarySheet(ss) {
  let summary = ss.getSheetByName('📊 Summary');
  if (!summary) summary = ss.insertSheet('📊 Summary', 0);
  summary.clearContents();

  const today = fmtDate(Date.now());

  summary.getRange('A1').setValue('Tasky Team Summary — ' + today)
         .setFontSize(14).setFontWeight('bold').setFontColor('#1a73e8');
  summary.getRange('A2').setValue('Last updated: ' + new Date().toLocaleString())
         .setFontColor('#5f6368').setFontSize(10);

  const headers = [
    'Contributor', 'Email',
    'Completed', 'Parked', 'Blocked', 'Total Tasks',
    'Total Time', 'Avg / Task',
    'Review', 'Senior Review',
    'First Task', 'Last Task', 'Date'
  ];
  summary.getRange(4, 1, 1, headers.length).setValues([headers]);
  summary.getRange(4, 1, 1, headers.length)
    .setBackground('#1a73e8').setFontColor('#fff').setFontWeight('bold').setFontSize(11);

  const sheets   = ss.getSheets();
  const dataRows = [];

  for (const sheet of sheets) {
    const name = sheet.getName();
    if (name === '📊 Summary') continue;

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) continue;

    // Batch read all data in one call
    const values = sheet.getRange(2, 1, lastRow - 1, 11).getValues();
    const email  = values[0][0] || name;

    let completed = 0, parked = 0, blocked = 0, review = 0, senior = 0;
    let totalMs = 0;
    let firstTime = '', lastTime = '';

    for (const row of values) {
      const status = String(row[4] || 'Completed');
      const stage  = String(row[3] || '');
      const dur    = parseDuration(String(row[9] || ''));
      totalMs += dur;

      if (status === 'Completed') completed++;
      else if (status === 'Parked')  parked++;
      else if (status === 'Blocked') blocked++;

      if (stage === 'Senior Review') senior++;
      else if (stage === 'Review')   review++;

      if (row[7]) {
        if (!firstTime) firstTime = String(row[7]);
        lastTime = String(row[7]);
      }
    }

    const total = completed + parked + blocked;
    const avg   = completed > 0 ? formatDuration(Math.round(totalMs / completed)) : '—';

    dataRows.push([
      name, email,
      completed, parked, blocked, total,
      formatDuration(totalMs), avg,
      review, senior,
      firstTime || '—', lastTime || '—', today
    ]);
  }

  if (dataRows.length > 0) {
    // Sort by completed tasks desc
    dataRows.sort((a, b) => b[2] - a[2]);
    summary.getRange(5, 1, dataRows.length, headers.length).setValues(dataRows);

    // Alternating rows
    for (let i = 0; i < dataRows.length; i++) {
      summary.getRange(5 + i, 1, 1, headers.length)
             .setBackground(i % 2 === 0 ? '#f8fafd' : '#ffffff');
    }

    // Column widths
    [160,200,80,70,70,80,100,100,80,100,130,130,110].forEach((w,i) => {
      summary.setColumnWidth(i+1, w);
    });
  } else {
    summary.getRange('A5').setValue('No data yet.')
           .setFontColor('#9aa0a6').setFontStyle('italic');
  }

  summary.setFrozenRows(4);
}

// ── Date/time helpers ─────────────────────────────────────────────────────────

function fmtDate(ts) {
  const d = new Date(ts);
  return pad(d.getDate()) + '/' + pad(d.getMonth()+1) + '/' + d.getFullYear();
}

function fmtDay(ts) {
  return new Date(ts).toLocaleDateString('en-US', { weekday: 'long' });
}

function fmtTime(ts) {
  const d = new Date(ts);
  let h = d.getHours();
  const m = d.getMinutes(), s = d.getSeconds();
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return pad(h) + ':' + pad(m) + ':' + pad(s) + ' ' + ap;
}

function formatDuration(ms) {
  if (!ms || ms < 0) return '00:00:00';
  const s = Math.floor(ms/1000);
  return pad(Math.floor(s/3600)) + ':' + pad(Math.floor((s%3600)/60)) + ':' + pad(s%60);
}

function parseDuration(str) {
  if (!str || typeof str !== 'string') return 0;
  const parts = str.split(':').map(Number);
  if (parts.length !== 3) return 0;
  return ((parts[0]*3600) + (parts[1]*60) + parts[2]) * 1000;
}

function pad(n) { return String(n).padStart(2, '0'); }

// ── Manual trigger (run from Apps Script editor) ──────────────────────────────

function refreshSummary() {
  updateSummarySheet(SpreadsheetApp.getActiveSpreadsheet());
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('⏱ Tasky')
    .addItem('Refresh Summary', 'refreshSummary')
    .addToUi();
}
