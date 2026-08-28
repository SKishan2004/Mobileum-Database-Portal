const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { sendReminderEmail, PRIMARY_OWNER_EMAIL, GLOBAL_OWNER_EMAIL } = require('./emailService');

const LOGS_FILE = path.join(__dirname, 'reminder_logs.json');

function loadLogs() {
  if (fs.existsSync(LOGS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(LOGS_FILE, 'utf-8'));
      return Array.isArray(data) ? data : [];
    } catch (e) {
      console.error('Error reading reminder_logs.json:', e);
    }
  }
  return [];
}

function saveLogs(logs) {
  try {
    fs.writeFileSync(LOGS_FILE, JSON.stringify(logs, null, 2));
  } catch (e) {
    console.error('Error saving reminder_logs.json:', e);
  }
}

// Format Date as YYYY-MM-DD
function formatDate(d) {
  if (!d) return '';
  const dateObj = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dateObj.getTime())) return '';
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const day = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Get tomorrow's date string YYYY-MM-DD
function getTomorrowDateStr() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return formatDate(tomorrow);
}

// Check and send reminder emails
async function runReminderCheck(allRows = [], force = false) {
  const tomorrowStr = getTomorrowDateStr();
  const todayStr = formatDate(new Date());

  console.log(`[ReminderScheduler] Checking reminders across ${allRows.length} records. Today: ${todayStr}, Target (1-Day Prior): ${tomorrowStr}`);

  const logs = loadLogs();
  const sentKeysToday = new Set(
    logs
      .filter(l => l.sentDate === todayStr)
      .map(l => `${l.opportunityId}_${l.remindDate}`)
  );

  const matchedOpps = [];
  const results = [];

  for (const row of allRows) {
    const remindDateRaw = row['Customer Remind Date'] || row['Customer remind date'];
    const remindDateStr = formatDate(remindDateRaw);
    if (!remindDateStr) continue;

    const oppId = row['Opportunity Name'] || row['Opportunity ID 18 Digit'] || row['Account ID'] || 'Unnamed';
    const logKey = `${oppId}_${remindDateStr}`;

    // Target condition: Customer Remind Date is tomorrow (1 day prior alert)
    // Or if force is true and remindDate is upcoming in next 1 day
    const isTomorrow = (remindDateStr === tomorrowStr);
    const isDueSoon = force && (remindDateStr >= todayStr && remindDateStr <= tomorrowStr);

    if (isTomorrow || isDueSoon) {
      if (!sentKeysToday.has(logKey) || force) {
        matchedOpps.push(row);

        const recipients = [PRIMARY_OWNER_EMAIL, GLOBAL_OWNER_EMAIL];
        const res = await sendReminderEmail({
          opportunity: row,
          recipients: recipients,
          daysRemaining: 1
        });

        const logEntry = {
          id: 'rem_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
          opportunityId: oppId,
          opportunityName: row['Opportunity Name'] || oppId,
          owner: row['Opportunity Owner'] || 'Unassigned',
          remindDate: remindDateStr,
          sentDate: todayStr,
          timestamp: new Date().toISOString(),
          recipients: recipients,
          status: res.success ? (res.simulated ? 'SIMULATED' : 'DELIVERED') : 'FAILED',
          details: res.message || res.error || ''
        };

        logs.unshift(logEntry);
        sentKeysToday.add(logKey);
        results.push(logEntry);
      }
    }
  }

  // Keep last 500 log entries
  saveLogs(logs.slice(0, 500));

  console.log(`[ReminderScheduler] Completed scan. Matched: ${matchedOpps.length}, Dispatched: ${results.length}`);
  return {
    today: todayStr,
    tomorrow: tomorrowStr,
    matchedCount: matchedOpps.length,
    dispatchedCount: results.length,
    logs: results
  };
}

// Get upcoming reminders due in the next N days
function getUpcomingReminders(allRows = [], daysWindow = 7) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const future = new Date(today.getTime() + daysWindow * 24 * 60 * 60 * 1000);

  const upcoming = [];

  for (const row of allRows) {
    const remindDateRaw = row['Customer Remind Date'] || row['Customer remind date'];
    const remindDateStr = formatDate(remindDateRaw);
    if (!remindDateStr) continue;

    const rDate = new Date(remindDateStr);
    if (isNaN(rDate.getTime())) continue;

    if (rDate >= today && rDate <= future) {
      const diffTime = rDate.getTime() - today.getTime();
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      upcoming.push({
        ...row,
        _remindDateFormatted: remindDateStr,
        _daysUntilRemind: diffDays,
        _isOneDayPrior: diffDays === 1
      });
    }
  }

  upcoming.sort((a, b) => a._daysUntilRemind - b._daysUntilRemind);
  return upcoming;
}

// Initialize automated background scheduler
function initScheduler(getDataFn) {
  console.log('⏰ Automated Background Reminder Scheduler Initialized (Cron & Interval Active)');
  
  // 1. Initial automated scan on server startup (delayed 5s for DB load)
  setTimeout(async () => {
    try {
      console.log('⏰ Running automated startup reminder scan...');
      const rows = await getDataFn();
      await runReminderCheck(rows, false);
    } catch (err) {
      console.error('Error running startup reminder scan:', err.message);
    }
  }, 5000);

  // 2. Daily Cron Schedule (Every day at 08:00 AM IST)
  cron.schedule('0 8 * * *', async () => {
    console.log('⏰ Running daily scheduled reminder check (08:00 AM)...');
    try {
      const rows = await getDataFn();
      await runReminderCheck(rows, false);
    } catch (err) {
      console.error('Error running scheduled reminder check:', err.message);
    }
  });

  // 3. Periodic Background Check (Every 6 hours)
  setInterval(async () => {
    try {
      const rows = await getDataFn();
      await runReminderCheck(rows, false);
    } catch (err) {
      console.error('Error in periodic background reminder check:', err.message);
    }
  }, 6 * 60 * 60 * 1000);
}

module.exports = {
  initScheduler,
  runReminderCheck,
  getUpcomingReminders,
  getReminderLogs: loadLogs
};
