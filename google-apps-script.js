/**
 * TASKY TRACKER — Google Apps Script v9
 * ══════════════════════════════════════════════════════════════════════════════
 * HOW TO DIAGNOSE "no data" in 3 steps:
 *
 * STEP 1 — Verify the script itself works:
 *   Apps Script editor → select "selfTest" → click Run
 *   → You should see a new tab with your name and 2 rows.
 *   → If this fails, check you authorised the script.
 *
 * STEP 2 — Verify the extension is reaching the script:
 *   Trigger any task sync in the extension, then check:
 *   → Does a "📥 Incoming" tab appear in your sheet?
 *   → If NO: the extension URL is wrong, or it's pointing to the old script.
 *   → If YES: open that tab and read the "Raw Payload" column — paste it here.
 *
 * STEP 3 — Check Apps Script → Executions (left sidebar icon)
 *   → Click any doPost entry → read the log lines
 *   → They will say exactly why sessions were skipped
 *
 * SETUP:
 * 1. Google Sheets → new blank sheet → Extensions → Apps Script
 * 2. Delete all code → paste this file → Save (Ctrl+S)
 * 3. Deploy → New deployment → Web App → Execute as: Me → Anyone → Deploy
 * 4. Authorise → copy /exec URL → paste into extension → Save
 */

// ════════════════════════════════════════════════════════════════════════════════
// ENTRY POINTS
// ════════════════════════════════════════════════════════════════════════════════

function doPost(e) {
  try {
    const raw = (e && e.postData && e.postData.contents) ? e.postData.contents : '{}';

    // ── Step 1: capture raw payload BEFORE any parsing ──────────────────────
    // If 📥 Incoming tab appears → extension IS reaching the script
    // If 📥 Incoming tab never appears → extension is NOT calling this URL
    captureRaw(raw);

    // ── Step 2: parse ─────────────────────────────────────────────────────────
    let data;
    try { data = JSON.parse(raw); }
    catch(e) {
      Logger.log('[Tasky] Invalid JSON: ' + raw.slice(0, 300));
      return ok({ ok:false, error: 'invalid JSON' });
    }

    Logger.log('[Tasky] POST | email=' + data.email +
      ' sessions=' + (Array.isArray(data.sessions) ? data.sessions.length :
                       Array.isArray(data.tasks)    ? data.tasks.length + ' (via tasks[])' : 'MISSING') +
      ' type=' + (data.type||'track'));

    if (!data.email) return ok({ ok:false, error:'email required' });
    if (data.type === 'heartbeat') return ok(handleHeartbeat(data));
    return ok(handleTrack(data));

  } catch (err) {
    Logger.log('[Tasky] FATAL: ' + err.message + '\n' + err.stack);
    return ok({ ok:false, error: err.message });
  }
}

function doGet(e) {
  return ok({ ok:true, message:'Tasky Sheet v9 is live!', time:new Date().toISOString() });
}

function ok(obj) {
  if (obj.ok === undefined) obj.ok = true;
  return ContentService.createTextOutput(JSON.stringify(obj))
                       .setMimeType(ContentService.MimeType.JSON);
}

// ════════════════════════════════════════════════════════════════════════════════
// SELF TEST — run from Apps Script editor to confirm writing works
// Function dropdown → selfTest → Run
// ════════════════════════════════════════════════════════════════════════════════

function selfTest() {
  const now   = Date.now();
  const email = Session.getActiveUser().getEmail() || 'selftest@example.com';

  const payload = {
    email: email,
    sessions: [
      { taskId:'t1', taskName:'✅ Self Test — Completed', jobName:'Test Job',
        stage:'Review',        status:'Completed', startTime:now-600000, durationMs:600000,
        url:'https://example.com/1', isRevisit:false },
      { taskId:'t2', taskName:'⏸ Self Test — Parked',    jobName:'Test Job',
        stage:'Senior Review', status:'Parked',    startTime:now-300000, durationMs:300000,
        url:'https://example.com/2', isRevisit:false },
    ]
  };

  const result = handleTrack(payload);
  Logger.log('[selfTest] ' + JSON.stringify(result));

  SpreadsheetApp.getUi().alert(
    '✅ Self Test Result\n\n' +
    'Rows written : ' + result.newSessions + '\n' +
    'Sheet tab    : "' + result.sheet + '"\n' +
    'Skipped      : revisit=' + result.skipped.revisit +
                  ' noTime='  + result.skipped.noTime  +
                  ' dupe='    + result.skipped.dupe    + '\n\n' +
    (result.newSessions > 0
      ? '→ Look for the "' + result.sheet + '" tab in your spreadsheet!'
      : '→ Rows already existed from a previous run (normal).')
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// 📥 INCOMING — capture every raw POST before processing
// ════════════════════════════════════════════════════════════════════════════════

function captureRaw(raw) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let   tab = ss.getSheetByName('📥 Incoming');
    if (!tab) {
      tab = ss.insertSheet('📥 Incoming');
      tab.getRange(1,1,1,5).setValues([['Timestamp','Email','Sessions Count','Type','Raw Payload (first 1000 chars)']]);
      tab.getRange(1,1,1,5).setBackground('#f9ab00').setFontColor('#fff').setFontWeight('bold');
      tab.setFrozenRows(1);
      [160,200,120,90,900].forEach((w,i) => tab.setColumnWidth(i+1, w));
    }

    let email='(parse error)', count='?', type='?';
    try {
      const d = JSON.parse(raw);
      email   = d.email || '(no email)';
      type    = d.type  || 'track';
      count   = Array.isArray(d.sessions) ? String(d.sessions.length) + ' (sessions[])'
              : Array.isArray(d.tasks)    ? String(d.tasks.length)    + ' (tasks[])'
              : d.session                 ? '1 (session{})'
              : '⚠ 0 or missing';
    } catch(e) { email = '⚠ NOT JSON'; }

    tab.appendRow([new Date().toLocaleString(), email, count, type, raw.slice(0,1000)]);

    // Cap at 500 rows
    const lr = tab.getLastRow();
    if (lr > 501) tab.deleteRows(2, lr - 501);
  } catch(e) {
    Logger.log('[captureRaw] error: ' + e.message);
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// HANDLE TRACK
// ════════════════════════════════════════════════════════════════════════════════

function handleTrack(data) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const email = String(data.email || '');

  // Accept sessions under any key the extension might use
  let sessions = [];
  if      (Array.isArray(data.sessions))   sessions = data.sessions;
  else if (Array.isArray(data.tasks))      sessions = data.tasks;
  else if (Array.isArray(data.taskList))   sessions = data.taskList;
  else if (data.session && typeof data.session === 'object') sessions = [data.session];

  Logger.log('[handleTrack] ' + email + ' | raw=' + sessions.length);

  // Get or create sheet
  const sheetName = cleanName(email.split('@')[0]);
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) { sheet = ss.insertSheet(sheetName); setupSheet(sheet); }

  // Build dedup set
  const lr   = sheet.getLastRow();
  const seen = new Set();
  if (lr > 1) {
    sheet.getRange(2, 1, lr - 1, 8).getValues().forEach(r => {
      if (r[7]) seen.add(String(r[7]) + '|' + String(r[1]));
    });
  }

  const rows = [];
  let nRevisit=0, nNoTime=0, nDupe=0;

  for (const s of sessions) {

    // Skip revisits
    if (s.isRevisit === true) { nRevisit++; continue; }

    // startTime — try every possible field name
    const startMs = Number(
      s.startTime  || s.start_time  || s.startedAt ||
      s.started_at || s.timestamp   || s.time       || 0
    );

    // Validate: must be a plausible Unix ms timestamp (after year 2000)
    if (!startMs || startMs < 946684800000) {
      nNoTime++;
      Logger.log('[handleTrack] SKIP no-time: ' + JSON.stringify(s).slice(0,200));
      continue;
    }

    const taskName = String(s.taskName || s.task_name || s.name || s.title || s.taskId || '');
    const startStr = fmtTime(startMs);
    const key      = startStr + '|' + taskName;
    if (seen.has(key)) { nDupe++; continue; }
    seen.add(key);

    const durMs  = Number(s.durationMs || s.duration_ms || s.duration || s.timeSpent || s.elapsed || 0);
    const endMs  = startMs + durMs;
    const status = String(s.status || s.taskStatus || 'Completed');
    const stage  = String(s.stage  || s.stageType  || 'Unknown');

    rows.push([
      email,
      taskName,
      String(s.jobName  || s.job_name  || s.project || ''),
      stage,
      status,
      fmtDate(startMs),
      fmtDay(startMs),
      startStr,
      fmtTime(endMs),
      fmtDur(durMs),
      String(s.url || s.taskUrl || s.task_url || s.link || ''),
    ]);
  }

  Logger.log('[handleTrack] ' + email +
    ' writing=' + rows.length +
    ' skipped: revisit=' + nRevisit + ' noTime=' + nNoTime + ' dupe=' + nDupe);

  if (rows.length > 0) {
    const w = sheet.getLastRow() + 1;
    sheet.getRange(w, 1, rows.length, 11).setValues(rows);
    rows.forEach((r, i) => {
      if (r[10]) sheet.getRange(w + i, 11)
        .setFormula('=HYPERLINK("' + r[10].replace(/"/g,'') + '","Open Task")');
    });
    updateSummary(ss);
  }

  if (data.current !== undefined || data.parkedTasks !== undefined) {
    updateActive(ss, email, data.current||null, data.parkedTasks||[]);
  }

  return {
    ok: true,
    newSessions: rows.length,
    sheet: sheetName,
    skipped: { revisit:nRevisit, noTime:nNoTime, dupe:nDupe }
  };
}

// ════════════════════════════════════════════════════════════════════════════════
// HEARTBEAT
// ════════════════════════════════════════════════════════════════════════════════

function handleHeartbeat(data) {
  updateActive(SpreadsheetApp.getActiveSpreadsheet(),
    data.email, data.current||null, data.parkedTasks||[]);
  return { ok:true };
}

// ════════════════════════════════════════════════════════════════════════════════
// ⚡ ACTIVE SHEET
// ════════════════════════════════════════════════════════════════════════════════

function updateActive(ss, email, currentTask, parkedTasks) {
  let tab = ss.getSheetByName('⚡ Active');
  if (!tab) {
    tab = ss.insertSheet('⚡ Active');
    tab.getRange(1,1,1,6).setValues([['Email','Last Seen','Status','Current Task','Stage','Parked']]);
    tab.getRange(1,1,1,6).setBackground('#1a73e8').setFontColor('#fff').setFontWeight('bold');
    tab.setFrozenRows(1);
    [200,160,100,300,130,80].forEach((w,i) => tab.setColumnWidth(i+1, w));
  }
  const lr = tab.getLastRow();
  let row  = lr + 1;
  if (lr > 1) {
    const emails = tab.getRange(2,1,lr-1,1).getValues();
    for (let i=0; i<emails.length; i++) {
      if (emails[i][0] === email) { row = i+2; break; }
    }
  }
  const status = currentTask ? 'Active 🟢'
    : (parkedTasks.length > 0 ? 'On Break 🟡' : 'Online 🔵');
  tab.getRange(row,1,1,6).setValues([[
    email, new Date().toLocaleString(), status,
    currentTask ? (currentTask.taskName || currentTask.taskId || '') : '',
    currentTask ? (currentTask.stage || '') : '',
    parkedTasks.length
  ]]);
}

// ════════════════════════════════════════════════════════════════════════════════
// 📊 SUMMARY SHEET
// ════════════════════════════════════════════════════════════════════════════════

function updateSummary(ss) {
  let sum = ss.getSheetByName('📊 Summary') || ss.getSheetByName('Summary');
  if (!sum) sum = ss.insertSheet('📊 Summary', 0);
  sum.clearContents();

  sum.getRange('A1').setValue('Tasky Summary — ' + fmtDate(Date.now()))
     .setFontSize(14).setFontWeight('bold').setFontColor('#1a73e8');
  sum.getRange('A2').setValue('Updated: ' + new Date().toLocaleString())
     .setFontColor('#5f6368').setFontSize(10);

  const headers = ['Contributor','Email','Completed','Parked','Blocked',
                   'Total Tasks','Total Time','Avg/Task',
                   'Stage','Start Time','End Time','Date'];
  sum.getRange(4,1,1,headers.length).setValues([headers]);
  sum.getRange(4,1,1,headers.length)
     .setBackground('#1a73e8').setFontColor('#fff').setFontWeight('bold').setFontSize(11);
  sum.setFrozenRows(4);

  const SKIP = ['📊 Summary','Summary','⚡ Active','📥 Incoming','🔍 Debug'];
  const dataRows = [];

  for (const sheet of ss.getSheets()) {
    const name = sheet.getName();
    if (SKIP.includes(name)) continue;
    const lr = sheet.getLastRow();
    if (lr < 2) continue;

    const vals  = sheet.getRange(2,1,lr-1,11).getValues();
    const email = vals[0][0] || name;
    let done=0, parked=0, blocked=0, totalMs=0, hasSenior=false, hasReview=false;

    for (const r of vals) {
      const st = String(r[4]||'Completed');
      const sg = String(r[3]||'');
      totalMs += parseDur(String(r[9]||''));
      if (st==='Completed')    done++;
      else if (st==='Parked')  parked++;
      else if (st==='Blocked') blocked++;
      if (sg==='Senior Review') hasSenior = true;
      else if (sg==='Review')   hasReview = true;
    }

    const startTime = vals[0][7]             ? String(vals[0][7])             : '—';
    const endTime   = vals[vals.length-1][8] ? String(vals[vals.length-1][8]) : '—';

    let stageLabel = 'Production';
    if (hasSenior && hasReview) stageLabel = 'Reviewer + Senior';
    else if (hasSenior)         stageLabel = 'Senior Reviewer';
    else if (hasReview)         stageLabel = 'Reviewer';

    dataRows.push([name, email, done, parked, blocked, done+parked+blocked,
      fmtDur(totalMs),
      done > 0 ? fmtDur(Math.round(totalMs/done)) : '—',
      stageLabel, startTime, endTime, fmtDate(Date.now())]);
  }

  if (dataRows.length > 0) {
    dataRows.sort((a,b) => b[2]-a[2]);
    sum.getRange(5,1,dataRows.length,headers.length).setValues(dataRows);
    for (let i=0; i<dataRows.length; i++) {
      sum.getRange(5+i,1,1,headers.length).setBackground(i%2===0?'#f8fafd':'#ffffff');
      const sc = sum.getRange(5+i,9), sg = dataRows[i][8];
      if (sg==='Senior Reviewer'||sg==='Reviewer + Senior')
        sc.setBackground('#fce8e6').setFontColor('#c5221f').setFontWeight('bold');
      else if (sg==='Reviewer')
        sc.setBackground('#e8f0fe').setFontColor('#1a73e8').setFontWeight('bold');
      else
        sc.setBackground('#e6f4ea').setFontColor('#137333').setFontWeight('bold');
    }
    [160,200,80,70,70,80,100,100,140,110,110,100]
      .forEach((w,i) => sum.setColumnWidth(i+1, w));
  } else {
    sum.getRange('A5').setValue('No task data yet.').setFontColor('#9aa0a6').setFontStyle('italic');
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// SHEET SETUP
// ════════════════════════════════════════════════════════════════════════════════

function setupSheet(sheet) {
  const h = ['Email','Task Name','Job Name','Stage','Status',
             'Date','Day','Start Time','End Time','Duration','Task Link'];
  sheet.appendRow(h);
  sheet.getRange(1,1,1,h.length)
       .setBackground('#1a73e8').setFontColor('#fff').setFontWeight('bold').setFontSize(11);
  sheet.setFrozenRows(1);
  [180,240,240,120,90,100,100,130,130,90,200].forEach((w,i) => sheet.setColumnWidth(i+1, w));
  sheet.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Senior Review')
      .setBackground('#fce8e6').setFontColor('#c5221f').setRanges([sheet.getRange('D2:D10000')]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Review')
      .setBackground('#e8f0fe').setFontColor('#1a73e8').setRanges([sheet.getRange('D2:D10000')]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Completed')
      .setBackground('#e6f4ea').setFontColor('#137333').setRanges([sheet.getRange('E2:E10000')]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Parked')
      .setBackground('#fff3e0').setFontColor('#e65100').setRanges([sheet.getRange('E2:E10000')]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Blocked')
      .setBackground('#fce8e6').setFontColor('#c5221f').setRanges([sheet.getRange('E2:E10000')]).build(),
  ]);
}

// ════════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════════

function cleanName(n) {
  return (n||'contributor').replace(/[^a-zA-Z0-9_\- ]/g,'').slice(0,30)||'contributor';
}
function pad(n) { return String(n).padStart(2,'0'); }
function fmtDate(ts) {
  const d=new Date(ts);
  return pad(d.getDate())+'/'+pad(d.getMonth()+1)+'/'+d.getFullYear();
}
function fmtDay(ts) { return new Date(ts).toLocaleDateString('en-US',{weekday:'long'}); }
function fmtTime(ts) {
  const d=new Date(ts), m=d.getMinutes(), s=d.getSeconds();
  let h=d.getHours(), ap=h>=12?'PM':'AM'; h=h%12||12;
  return pad(h)+':'+pad(m)+':'+pad(s)+' '+ap;
}
function fmtDur(ms) {
  if(!ms||ms<0) return '00:00:00';
  const s=Math.floor(ms/1000);
  return pad(Math.floor(s/3600))+':'+pad(Math.floor((s%3600)/60))+':'+pad(s%60);
}
function parseDur(str) {
  if(!str||typeof str!=='string') return 0;
  const p=str.split(':').map(Number);
  if(p.length!==3||p.some(isNaN)) return 0;
  return ((p[0]*3600)+(p[1]*60)+p[2])*1000;
}

// ════════════════════════════════════════════════════════════════════════════════
// MENU
// ════════════════════════════════════════════════════════════════════════════════

function refreshSummary() { updateSummary(SpreadsheetApp.getActiveSpreadsheet()); }

function onOpen() {
  SpreadsheetApp.getUi().createMenu('⏱ Tasky')
    .addItem('▶ Run Self Test', 'selfTest')
    .addItem('↻ Refresh Summary', 'refreshSummary')
    .addToUi();
}
