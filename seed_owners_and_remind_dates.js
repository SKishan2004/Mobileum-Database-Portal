require('dotenv').config();
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { createClient } = require('@supabase/supabase-js');

const OPPORTUNITY_OWNERS = [
  "Alexander Wright", "Sarah Jenkins", "Michael Chang", "Emily Davis",
  "David Miller", "Rachel Adams", "James Wilson", "Sophia Martinez",
  "Daniel Taylor", "Olivia Thomas", "Robert Anderson", "Emma Jackson",
  "William White", "Ava Harris", "Benjamin Martin", "Mia Thompson",
  "Lucas Garcia", "Charlotte Martinez", "Henry Robinson", "Amelia Clark",
  "Ethan Rodriguez", "Harper Lewis", "Alexander Lee", "Evelyn Walker",
  "Sebastian Hall", "Abigail Allen", "Jack Young", "Ella Hernandez",
  "Owen King", "Chloe Wright"
];

function getRandomDate(startYear = 2025, endYear = 2026) {
  const start = new Date(startYear, 0, 1).getTime();
  const end = new Date(endYear, 11, 31).getTime();
  const randomTimestamp = start + Math.random() * (end - start);
  const date = new Date(randomTimestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const excelFile = path.join(__dirname, 'Renewal_Opportunity_1000_Realistic.xlsx');
if (!fs.existsSync(excelFile)) {
  console.error('File not found:', excelFile);
  process.exit(1);
}

console.log('Loading Excel workbook:', excelFile);
const workbook = XLSX.readFile(excelFile, { cellDates: true });
const sheetName = workbook.SheetNames[0];
const sheet = workbook.Sheets[sheetName];
const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

console.log(`Processing ${rows.length} rows...`);

const updatedRows = rows.map((row, index) => {
  // Assign owner evenly / randomly from 30 owners
  const owner = OPPORTUNITY_OWNERS[index % OPPORTUNITY_OWNERS.length];
  
  // Calculate or generate Customer Remind Date
  let remindDate = '';
  const refDateStr = row['Close Date'] || row['Service End Date'] || row['Service Expiry date'];
  if (refDateStr) {
    const refDate = new Date(refDateStr);
    if (!isNaN(refDate.getTime())) {
      const offsetDays = Math.floor(Math.random() * 30) + 15; // 15 to 45 days prior
      const rDate = new Date(refDate.getTime() - offsetDays * 24 * 60 * 60 * 1000);
      const y = rDate.getFullYear();
      const m = String(rDate.getMonth() + 1).padStart(2, '0');
      const d = String(rDate.getDate()).padStart(2, '0');
      remindDate = `${y}-${m}-${d}`;
    }
  }
  if (!remindDate) {
    remindDate = getRandomDate(2025, 2026);
  }

  const newRow = {
    'Opportunity Owner': owner,
    'Customer Remind Date': remindDate
  };
  Object.keys(row).forEach(k => {
    if (k !== 'Opportunity Owner' && k !== 'Customer Remind Date') {
      newRow[k] = row[k];
    }
  });
  return newRow;
});

console.log('Sample updated row:');
console.log({
  'Opportunity Name': updatedRows[0]['Opportunity Name'],
  'Opportunity Owner': updatedRows[0]['Opportunity Owner'],
  'Customer Remind Date': updatedRows[0]['Customer Remind Date']
});

// 1. Save to Excel
const newSheet = XLSX.utils.json_to_sheet(updatedRows);
const newWorkbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(newWorkbook, newSheet, sheetName);
XLSX.writeFile(newWorkbook, excelFile);
console.log('Successfully updated Excel file:', excelFile);

// Also update Renewal_Opportunity_Expanded.xlsx if present
const expandedFile = path.join(__dirname, 'Renewal_Opportunity_Expanded.xlsx');
if (fs.existsSync(expandedFile)) {
  XLSX.writeFile(newWorkbook, expandedFile);
  console.log('Updated expanded file:', expandedFile);
}

// 2. Update local_datasets.json if present
const datasetsFile = path.join(__dirname, 'local_datasets.json');
if (fs.existsSync(datasetsFile)) {
  try {
    const localData = JSON.parse(fs.readFileSync(datasetsFile, 'utf-8'));
    if (Array.isArray(localData) && localData.length > 0) {
      localData[0].rows = updatedRows;
      fs.writeFileSync(datasetsFile, JSON.stringify(localData, null, 2));
      console.log('Updated local_datasets.json');
    }
  } catch (e) {
    console.error('Error updating local_datasets.json:', e);
  }
}

// 3. Update Supabase if credentials present
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (supabaseUrl && supabaseKey) {
  const supabase = createClient(supabaseUrl, supabaseKey);
  
  async function syncSupabase() {
    const { error: probeErr } = await supabase.from('datasets').select('id').limit(1);
    if (probeErr && (probeErr.message.includes('Unregistered API key') || probeErr.status === 401)) {
      console.warn('⚠️  Supabase API key is unregistered or invalid. Skipping Supabase sync (local Excel & JSON updated successfully).');
      return;
    }
    console.log('Syncing updated data to Supabase...');
    const { data: activeDsList } = await supabase.from('datasets').select('id');
    const targetDatasetIds = (activeDsList && activeDsList.length > 0) ? activeDsList.map(d => d.id) : ['ds_default_1000'];
    
    for (const datasetId of targetDatasetIds) {
      console.log(`Syncing dataset ${datasetId} in Supabase...`);
      // Delete existing renewals for datasetId
      await supabase.from('renewals').delete().eq('dataset_id', datasetId);

      const records = updatedRows.map(row => ({
        dataset_id: datasetId,
        data: row
      }));

      const batchSize = 200;
      for (let i = 0; i < records.length; i += batchSize) {
        const batch = records.slice(i, i + batchSize);
        const { error: insErr } = await supabase.from('renewals').insert(batch);
        if (insErr) {
          console.error(`Error inserting batch into ${datasetId}:`, insErr.message);
        }
      }

      // Infer updated schema
      const rawHeaders = Object.keys(updatedRows[0]);
      const cleanColumns = rawHeaders.map((h, i) => String(h || '').trim() || `Column_${i + 1}`);
      const columns = [];
      cleanColumns.forEach((col, idx) => {
        const nonEmptyVals = updatedRows.map(r => r[col]).filter(v => v !== null && v !== undefined && String(v).trim() !== '');
        let dataType = 'text';
        if (nonEmptyVals.length > 0) {
          const isDate = nonEmptyVals.every(v => {
            if (v instanceof Date) return !isNaN(v.getTime());
            const str = String(v).trim();
            if (str.length < 6) return false;
            if (/^\d{4}-\d{2}-\d{2}/.test(str) || /^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(str)) return true;
            return !isNaN(Date.parse(str));
          });
          if (isDate) {
            dataType = 'date';
          } else {
            const isNumeric = nonEmptyVals.every(v => {
              const cleanStr = String(v).replace(/[$€£₹,]/g, '').trim();
              return cleanStr !== '' && !isNaN(Number(cleanStr));
            });
            if (isNumeric) {
              const colLower = col.toLowerCase();
              const isCurrencyName = /amount|tcv|acv|revenue|price|cost|val|fee|budget|\(\$\)/i.test(colLower);
              const hasCurrencySymbol = nonEmptyVals.some(v => /[$€£₹]/.test(String(v)));
              dataType = (isCurrencyName || hasCurrencySymbol) ? 'currency' : 'number';
            } else {
              const uniqueVals = new Set(nonEmptyVals.map(v => String(v).trim()));
              if (uniqueVals.size <= 35 && uniqueVals.size > 0) {
                dataType = 'category';
              } else {
                dataType = 'text';
              }
            }
          }
        }
        columns.push({
          dataset_id: datasetId,
          column_name: col,
          data_type: dataType,
          is_primary_key: col === 'Opportunity Name',
          display_order: idx
        });
      });

      await supabase.from('dataset_schema').delete().eq('dataset_id', datasetId);
      await supabase.from('dataset_schema').insert(columns);
      await supabase.from('datasets').update({ column_count: columns.length }).eq('id', datasetId);
      console.log(`Supabase dataset ${datasetId} schema updated successfully.`);
    }
  }

  syncSupabase().catch(err => console.error('Supabase sync error:', err));
}
