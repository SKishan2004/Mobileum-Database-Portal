require('dotenv').config();
const nodemailer = require('nodemailer');

const PRIMARY_OWNER_EMAIL = process.env.PRIMARY_OWNER_EMAIL || 'kishansukumar2004@gmail.com';
const GLOBAL_OWNER_EMAIL = process.env.GLOBAL_OWNER_EMAIL || 'nbhargow@gmail.com';

function createTransporter() {
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = (process.env.SMTP_USER || '').trim();
  const pass = (process.env.SMTP_PASS || '').trim();

  if (!user || !pass) {
    return null; // Local dry-run simulation mode
  }

  return nodemailer.createTransport({
    host: host,
    port: port,
    secure: port === 465,
    auth: { user, pass },
    tls: { rejectUnauthorized: false }
  });
}

function buildEmailHtml(opp, daysRemaining = 1) {
  const oppName = opp['Opportunity Name'] || opp['Opportunity ID 18 Digit'] || 'Unnamed Opportunity';
  const owner = opp['Opportunity Owner'] || 'N/A';
  const remindDate = opp['Customer Remind Date'] || 'N/A';
  const closeDate = opp['Close Date'] || 'N/A';
  const serviceEndDate = opp['Service End Date'] || opp['Service Expiry date'] || 'N/A';
  const accountName = opp['Account Name'] || opp['Customer Name'] || 'N/A';
  const tcv = opp['TCV Amount'] || opp['Forecast ACV Amount'] || 'N/A';
  const status = opp['Renewal Opp Status'] || opp['Renewal Timeline'] || 'N/A';
  const stage = opp['Stage Number'] || 'N/A';

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: #f4f6f9; margin: 0; padding: 20px; color: #2d3748; }
        .card { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08); border: 1px solid #e2e8f0; }
        .header { background: #002b49; padding: 24px; color: #ffffff; text-align: left; }
        .header h2 { margin: 0 0 6px 0; font-size: 20px; font-weight: 700; color: #00d2ff; }
        .header p { margin: 0; font-size: 13px; color: #cbd5e0; }
        .content { padding: 24px; }
        .alert-badge { display: inline-block; background: #fff5f5; color: #e53e3e; border: 1px solid #feb2b2; font-size: 12px; font-weight: 700; padding: 4px 10px; border-radius: 4px; margin-bottom: 16px; }
        .info-grid { width: 100%; border-collapse: collapse; margin-top: 12px; }
        .info-grid td { padding: 10px 12px; border-bottom: 1px solid #edf2f7; font-size: 13px; }
        .info-grid td.label { font-weight: 600; color: #4a5568; width: 40%; background: #f7fafc; }
        .info-grid td.value { color: #1a202c; font-weight: 500; }
        .footer { background: #f7fafc; padding: 16px 24px; font-size: 11px; color: #718096; text-align: center; border-top: 1px solid #edf2f7; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="header">
          <h2>🔔 Renewal Reminder Alert</h2>
          <p>Mobileum Renewal Management System</p>
        </div>
        <div class="content">
          <div class="alert-badge">⚠️ Remind Date Approaching in ${daysRemaining} Day${daysRemaining === 1 ? '' : 's'}</div>
          <p style="font-size:14px; margin-top:0;">This is an automated notification for the upcoming renewal opportunity remind date scheduled for <strong>${remindDate}</strong>.</p>
          
          <table class="info-grid">
            <tr>
              <td class="label">Opportunity Name</td>
              <td class="value"><strong>${oppName}</strong></td>
            </tr>
            <tr>
              <td class="label">Opportunity Owner</td>
              <td class="value">${owner}</td>
            </tr>
            <tr>
              <td class="label">Customer Remind Date</td>
              <td class="value" style="color:#c53030; font-weight:bold;">${remindDate}</td>
            </tr>
            <tr>
              <td class="label">Account Name</td>
              <td class="value">${accountName}</td>
            </tr>
            <tr>
              <td class="label">TCV Amount</td>
              <td class="value">${tcv}</td>
            </tr>
            <tr>
              <td class="label">Renewal Status</td>
              <td class="value">${status}</td>
            </tr>
            <tr>
              <td class="label">Stage Number</td>
              <td class="value">${stage}</td>
            </tr>
            <tr>
              <td class="label">Close Date</td>
              <td class="value">${closeDate}</td>
            </tr>
            <tr>
              <td class="label">Service End Date</td>
              <td class="value">${serviceEndDate}</td>
            </tr>
          </table>
        </div>
        <div class="footer">
          Automated alert sent to <strong>${PRIMARY_OWNER_EMAIL}</strong> & <strong>${GLOBAL_OWNER_EMAIL}</strong><br>
          Mobileum Renewal Management Portal &copy; 2026
        </div>
      </div>
    </body>
    </html>
  `;
}

function buildChangeEmailHtml(recordName, recordData, changes, action = 'Updated') {
  const oppName = recordName || recordData['Opportunity Name'] || 'Unnamed Record';
  const owner = recordData['Opportunity Owner'] || 'N/A';
  const remindDate = recordData['Customer Remind Date'] || 'N/A';
  const accountName = recordData['Account Name'] || recordData['Customer Name'] || 'N/A';

  let changesTableHtml = '';
  if (changes && Object.keys(changes).length > 0) {
    changesTableHtml = `
      <table class="info-grid">
        <tr style="background:#edf2f7; font-weight:bold;">
          <td style="width:30%;">Field Changed</td>
          <td style="width:35%; color:#718096;">Previous Value</td>
          <td style="width:35%; color:#2b6cb0;">Updated Value</td>
        </tr>
        ${Object.entries(changes).map(([col, diff]) => `
          <tr>
            <td class="label">${col}</td>
            <td style="color:#718096; text-decoration:line-through;">${String(diff.old ?? '—')}</td>
            <td style="color:#2b6cb0; font-weight:600;">${String(diff.new ?? '—')}</td>
          </tr>
        `).join('')}
      </table>
    `;
  } else {
    changesTableHtml = `<p style="font-size:13px; color:#4a5568;">Record details updated for <strong>${oppName}</strong>.</p>`;
  }

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: #f4f6f9; margin: 0; padding: 20px; color: #2d3748; }
        .card { max-width: 620px; margin: 0 auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08); border: 1px solid #e2e8f0; }
        .header { background: #002b49; padding: 24px; color: #ffffff; text-align: left; }
        .header h2 { margin: 0 0 6px 0; font-size: 20px; font-weight: 700; color: #38bdf8; }
        .header p { margin: 0; font-size: 13px; color: #cbd5e0; }
        .content { padding: 24px; }
        .change-badge { display: inline-block; background: #ebf8ff; color: #2b6cb0; border: 1px solid #bee3f8; font-size: 12px; font-weight: 700; padding: 4px 10px; border-radius: 4px; margin-bottom: 16px; }
        .info-grid { width: 100%; border-collapse: collapse; margin-top: 12px; }
        .info-grid td { padding: 10px 12px; border-bottom: 1px solid #edf2f7; font-size: 13px; }
        .info-grid td.label { font-weight: 600; color: #4a5568; background: #f7fafc; }
        .footer { background: #f7fafc; padding: 16px 24px; font-size: 11px; color: #718096; text-align: center; border-top: 1px solid #edf2f7; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="header">
          <h2>📝 Opportunity ${action} Alert</h2>
          <p>Mobileum Renewal Management System</p>
        </div>
        <div class="content">
          <div class="change-badge">⚡ Record ${action}</div>
          <p style="font-size:14px; margin-top:0;">
            The opportunity record <strong>${oppName}</strong> (Account: ${accountName}) was successfully <strong>${action.toLowerCase()}</strong>.
          </p>

          ${changesTableHtml}

          <div style="margin-top:20px; padding:12px; background:#f7fafc; border-radius:6px; font-size:12px; color:#4a5568;">
            <strong>Opportunity Owner:</strong> ${owner} &nbsp;|&nbsp; 
            <strong>Customer Remind Date:</strong> ${remindDate}
          </div>
        </div>
        <div class="footer">
          Automated change alert sent to <strong>${PRIMARY_OWNER_EMAIL}</strong> & <strong>${GLOBAL_OWNER_EMAIL}</strong><br>
          Mobileum Renewal Management Portal &copy; 2026
        </div>
      </div>
    </body>
    </html>
  `;
}

async function sendReminderEmail({ opportunity, recipients = [PRIMARY_OWNER_EMAIL, GLOBAL_OWNER_EMAIL], daysRemaining = 1 }) {
  const oppName = opportunity['Opportunity Name'] || opportunity['Opportunity ID 18 Digit'] || 'Opportunity';
  const remindDate = opportunity['Customer Remind Date'] || 'N/A';
  const subject = `[Reminder Alert] 1 Day Prior Notice: ${oppName} (Remind Date: ${remindDate})`;

  const html = buildEmailHtml(opportunity, daysRemaining);
  const transporter = createTransporter();

  if (!transporter) {
    console.log(`\n================= 📧 SIMULATED REMINDER EMAIL -----------------`);
    console.log(`To: ${recipients.join(', ')}`);
    console.log(`Subject: ${subject}`);
    console.log(`Opportunity: ${oppName} | Remind Date: ${remindDate} | Owner: ${opportunity['Opportunity Owner']}`);
    console.log(`Status: DRY-RUN SIMULATION (No SMTP credentials in .env)`);
    console.log(`-----------------------------------------------------------\n`);
    return {
      success: true,
      simulated: true,
      recipients: recipients,
      subject: subject,
      message: 'Email alert simulated successfully (SMTP not configured in .env).'
    };
  }

  try {
    const info = await transporter.sendMail({
      from: `"Mobileum Reminders" <${process.env.SMTP_USER}>`,
      to: recipients.join(', '),
      subject: subject,
      html: html
    });

    console.log(`✅ Reminder email dispatched successfully to ${recipients.join(', ')}:`, info.messageId);
    return {
      success: true,
      simulated: false,
      messageId: info.messageId,
      recipients: recipients,
      subject: subject
    };
  } catch (err) {
    console.error(`❌ Failed to send reminder email to ${recipients.join(', ')}:`, err.message);
    return {
      success: false,
      error: err.message,
      recipients: recipients
    };
  }
}

async function sendChangeNotificationEmail({ recordName, recordData = {}, changes = null, action = 'Updated', recipients = [PRIMARY_OWNER_EMAIL, GLOBAL_OWNER_EMAIL] }) {
  const oppName = recordName || recordData['Opportunity Name'] || 'Opportunity';
  const subject = `[Change Alert] Opportunity ${action}: ${oppName}`;
  const html = buildChangeEmailHtml(recordName, recordData, changes, action);
  const transporter = createTransporter();

  if (!transporter) {
    console.log(`\n================= 📝 SIMULATED CHANGE EMAIL ALERT -----------------`);
    console.log(`To: ${recipients.join(', ')}`);
    console.log(`Subject: ${subject}`);
    console.log(`Action: ${action} | Record: ${oppName}`);
    console.log(`Changes:`, changes || 'New record created');
    console.log(`Status: DRY-RUN SIMULATION (No SMTP credentials in .env)`);
    console.log(`------------------------------------------------------------------\n`);
    return {
      success: true,
      simulated: true,
      recipients: recipients,
      subject: subject,
      changes: changes
    };
  }

  try {
    const info = await transporter.sendMail({
      from: `"Mobileum System Alerts" <${process.env.SMTP_USER}>`,
      to: recipients.join(', '),
      subject: subject,
      html: html
    });

    console.log(`✅ Change alert email dispatched to ${recipients.join(', ')}:`, info.messageId);
    return {
      success: true,
      simulated: false,
      messageId: info.messageId,
      recipients: recipients,
      subject: subject
    };
  } catch (err) {
    console.error(`❌ Failed to send change alert email to ${recipients.join(', ')}:`, err.message);
    return {
      success: false,
      error: err.message,
      recipients: recipients
    };
  }
}

module.exports = {
  sendReminderEmail,
  sendChangeNotificationEmail,
  PRIMARY_OWNER_EMAIL,
  GLOBAL_OWNER_EMAIL
};
