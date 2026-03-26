/**
 * TASKY TRACKER — Google Apps Script
 * ====================================
 * This script receives task data from the Tasky extension and writes it
 * to a Google Sheet automatically.
 *
 * SETUP INSTRUCTIONS:
 * 1. Go to https://script.google.com and create a new project
 * 2. Paste this entire file into the editor (replacing any existing code)
 * 3. Click "Deploy" → "New deployment" → Type: "Web App"
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 4. Click "Deploy" and copy the Web App URL
 * 5. In the Tasky extension popup → "📡 API" panel:
 *    - Paste the URL into "Google Sheets Script URL"
 *    - Enter your email
 *    - Click "Save & Send Now"
 *
 * The script will automatically create sheets named after each contributor.
 * A "Summary" sheet shows totals across all contributors.
 */

const SHEET_VERSION = '7.0';

// ── Entry point ───────────────────────────────────────────────────────────────

function doPost(e) {
  try {
    const raw  = e.postData ? e.postData.contents : '{}';
    const data = JSON.parse(raw);

    if (!data.email) {
      return ContentService
        .createTextOutput(JSON.stringify({ ok: false, error: 'email required' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const result = processContributorData(data);

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, ...result }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch(err) {
    Logger.log('Error: ' + err.message);
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// Allow CORS preflight
function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, version: SHEET_VERSION, message: 'Tasky Sheet is live!' }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Process data for one contributor ──────────────────────────────────────────

function processContributorData(data) {
  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  const email   = data.email;
  const sessions = data.sessions || [];

  // Get or create contributor sheet
  const sheetName = email.split('@')[0].replace(/[^a-zA-Z0-9_\- ]/g, '');
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    setupContributorSheet(sheet);
  }

  // Get existing rows to avoid duplicates
  const existingData = sheet.getDataRange().getValues();
  const existingKeys = new Set();
  for (let i = 1; i < existingData.length; i++) {
    const row = existingData[i];
    // Key: startTime + taskId + status
    if (row[6]) existingKeys.add(`${row[6]}_${row[1]}_${row[5]}`);
  }

  // Write new sessions
  let newCount = 0;
  const rowsToAppend = [];

  for (const s of sessions) {
    if (s.isRevisit) continue;

    const startMs  = s.startTime || 0;
    const key      = `${startMs}_${s.taskId||''}_${s.status||'Completed'}`;
    if (existingKeys.has(key)) continue;

    const durationSec = Math.floor((s.durationMs || 0) / 1000);
    const durationFmt = formatDuration(s.durationMs || 0);
    const startDt     = startMs ? new Date(startMs) : '';
    const endDt       = s.endTime ? new Date(s.endTime) : '';

    rowsToAppend.push([
      email,
      s.taskId    || '',
      s.taskName  || '',
      s.jobName   || '',
      s.stage     || 'Unknown',
      s.status    || 'Completed',
      startDt,
      endDt,
      durationSec,
      durationFmt,
      s.dateStr   || (startMs ? new Date(startMs).toDateString() : ''),
      s.url       || ''
    ]);
    newCount++;
  }

  if (rowsToAppend.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rowsToAppend.length, 12)
         .setValues(rowsToAppend);
  }

  // Update Summary sheet
  updateSummarySheet(ss);

  Logger.log(`[Tasky] ${email}: +${newCount} new sessions written`);
  return { newSessions: newCount, sheet: sheetName };
}

// ── Set up a fresh contributor sheet ──────────────────────────────────────────

function setupContributorSheet(sheet) {
  const headers = [
    'Email', 'Task ID', 'Task Name', 'Job Name', 'Stage', 'Status',
    'Start Time', 'End Time', 'Duration (s)', 'Duration', 'Date', 'URL'
  ];
  sheet.appendRow(headers);

  // Style header row
  const headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setBackground('#1a73e8')
             .setFontColor('#ffffff')
             .setFontWeight('bold')
             .setFontSize(11);

  // Freeze header row
  sheet.setFrozenRows(1);

  // Set column widths
  sheet.setColumnWidth(1, 180);  // Email
  sheet.setColumnWidth(2, 120);  // Task ID
  sheet.setColumnWidth(3, 220);  // Task Name
  sheet.setColumnWidth(4, 220);  // Job Name
  sheet.setColumnWidth(5, 110);  // Stage
  sheet.setColumnWidth(6, 90);   // Status
  sheet.setColumnWidth(7, 130);  // Start Time
  sheet.setColumnWidth(8, 130);  // End Time
  sheet.setColumnWidth(9, 90);   // Duration (s)
  sheet.setColumnWidth(10, 90);  // Duration
  sheet.setColumnWidth(11, 110); // Date
  sheet.setColumnWidth(12, 300); // URL
}

// ── Update Summary sheet ──────────────────────────────────────────────────────

function updateSummarySheet(ss) {
  const today = new Date().toDateString();
  let summary = ss.getSheetByName('📊 Summary');
  if (!summary) {
    summary = ss.insertSheet('📊 Summary', 0); // insert at front
  }

  summary.clearContents();

  // Title
  summary.getRange('A1').setValue('Tasky Team Summary — ' + today);
  summary.getRange('A1').setFontSize(14).setFontWeight('bold').setFontColor('#1a73e8');

  summary.getRange('A2').setValue('Generated: ' + new Date().toLocaleString());
  summary.getRange('A2').setFontColor('#5f6368').setFontSize(10);

  // Headers
  const headers = ['Contributor', 'Email', 'Tasks Completed', 'Parked', 'Blocked', 'Total Time', 'Avg / Task', 'Date'];
  summary.getRange(4, 1, 1, headers.length).setValues([headers]);
  summary.getRange(4, 1, 1, headers.length)
         .setBackground('#1a73e8').setFontColor('#fff').setFontWeight('bold').setFontSize(11);

  // Collect data from each contributor sheet
  const sheets = ss.getSheets();
  const dataRows = [];

  for (const sheet of sheets) {
    const name = sheet.getName();
    if (name === '📊 Summary') continue;

    const values = sheet.getDataRange().getValues();
    if (values.length < 2) continue;

    const email    = values[1][0] || name;
    let completed  = 0, parked = 0, blocked = 0, totalSec = 0;

    for (let i = 1; i < values.length; i++) {
      const row    = values[i];
      const status = row[5] || 'Completed';
      const dur    = parseInt(row[8]) || 0;
      if (status === 'Completed') { completed++; totalSec += dur; }
      else if (status === 'Parked')  { parked++;    totalSec += dur; }
      else if (status === 'Blocked') { blocked++;   totalSec += dur; }
    }

    const avg = completed > 0 ? Math.round(totalSec / completed) : 0;
    dataRows.push([
      name,
      email,
      completed,
      parked,
      blocked,
      formatDuration(totalSec * 1000),
      formatDuration(avg * 1000),
      today
    ]);
  }

  if (dataRows.length > 0) {
    dataRows.sort((a, b) => b[2] - a[2]); // sort by completed desc
    summary.getRange(5, 1, dataRows.length, 8).setValues(dataRows);

    // Alternating row colors
    for (let i = 0; i < dataRows.length; i++) {
      const bg = i % 2 === 0 ? '#f8fafd' : '#ffffff';
      summary.getRange(5 + i, 1, 1, 8).setBackground(bg);
    }

    // Column widths
    summary.setColumnWidth(1, 140);
    summary.setColumnWidth(2, 200);
    summary.setColumnWidth(3, 120);
    summary.setColumnWidth(4, 80);
    summary.setColumnWidth(5, 80);
    summary.setColumnWidth(6, 100);
    summary.setColumnWidth(7, 100);
    summary.setColumnWidth(8, 120);
  } else {
    summary.getRange('A5').setValue('No data yet. Have contributors sync from the extension.');
    summary.getRange('A5').setFontColor('#9aa0a6').setFontStyle('italic');
  }

  summary.setFrozenRows(4);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDuration(ms) {
  if (!ms || ms < 0) return '00:00:00';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(r).padStart(2,'0')}`;
}
