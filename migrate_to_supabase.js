require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("SUPABASE_URL and SUPABASE_KEY environment variables are required.");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Accept file path from command line arguments or fallback to default
const inputFilePath = process.argv[2] || path.join(__dirname, 'Renewal_Opportunity_1000_Realistic.xlsx');

function inferSchema(rows, requestedPrimaryKey) {
  if (!rows || rows.length === 0) return { primaryKey: "ID", columns: [] };

  const rawHeaders = Object.keys(rows[0]);
  const cleanColumns = rawHeaders.map((h, i) => String(h || '').trim() || `Column_${i + 1}`);
  const columns = [];
  const typeMap = {};

  cleanColumns.forEach((col) => {
    const nonEmptyVals = rows
      .map(r => r[col])
      .filter(v => v !== null && v !== undefined && String(v).trim() !== '');

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
          if (uniqueVals.size <= 15 && uniqueVals.size > 0) {
            dataType = 'category';
          } else {
            dataType = 'text';
          }
        }
      }
    }
    typeMap[col] = dataType;
  });

  let primaryKey = requestedPrimaryKey;
  if (!primaryKey || !cleanColumns.includes(primaryKey)) {
    for (const col of cleanColumns) {
      if (typeMap[col] === 'text' || typeMap[col] === 'category') {
        primaryKey = col;
        break;
      }
    }
    if (!primaryKey) primaryKey = cleanColumns[0];
  }

  cleanColumns.forEach((col, idx) => {
    columns.push({
      column_name: col,
      data_type: typeMap[col],
      is_primary_key: col === primaryKey,
      display_order: idx
    });
  });

  return { primaryKey, columns };
}

async function migrateData() {
  console.log(`Reading dataset file: ${inputFilePath}`);
  if (!fs.existsSync(inputFilePath)) {
    console.error(`File not found: ${inputFilePath}`);
    process.exit(1);
  }

  const workbook = XLSX.readFile(inputFilePath, { cellDates: true });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  console.log(`Found ${rows.length} rows. Inferring schema...`);

  const inferredSchema = inferSchema(rows);
  const pkField = inferredSchema.primaryKey;
  console.log(`Inferred Primary Key: "${pkField}"`);
  console.log(`Inferred Columns:`, inferredSchema.columns.map(c => `${c.column_name} (${c.data_type})`).join(', '));

  const datasetId = 'ds_default_1000';
  const datasetName = path.basename(inputFilePath);

  // 1. Deactivate existing datasets & insert active dataset record
  console.log('Registering dataset in Supabase...');
  try {
    await supabase.from('datasets').update({ is_active: false }).neq('id', '00000000-0000-0000-0000-000000000000');
    await supabase.from('datasets').upsert([{
      id: datasetId,
      name: datasetName,
      uploaded_at: new Date().toISOString(),
      row_count: rows.length,
      column_count: inferredSchema.columns.length,
      primary_key: pkField,
      is_active: true
    }]);
  } catch (dsErr) {
    console.warn('Warning: datasets table error:', dsErr.message);
  }

  // 2. Save schema to dataset_schema
  console.log('Saving schema to Supabase...');
  try {
    await supabase.from('dataset_schema').delete().eq('dataset_id', datasetId);
    const schemaRecords = inferredSchema.columns.map(c => ({
      dataset_id: datasetId,
      column_name: c.column_name,
      data_type: c.data_type,
      is_primary_key: c.is_primary_key,
      display_order: c.display_order
    }));
    await supabase.from('dataset_schema').insert(schemaRecords);
  } catch (schemaErr) {
    console.warn('Warning: dataset_schema insert error:', schemaErr.message);
  }

  // 3. Upload rows
  const cleanedRows = rows.map((r, idx) => {
    const cleanObj = {};
    Object.keys(r).forEach(k => cleanObj[String(k).trim()] = r[k]);
    if (!cleanObj[pkField]) cleanObj[pkField] = `Record_${idx + 1}`;
    return cleanObj;
  });

  const records = cleanedRows.map((row) => ({
    dataset_id: datasetId,
    data: row,
  }));

  console.log(`Uploading ${records.length} records to Supabase renewals table...`);
  try {
    await supabase.from('renewals').delete().eq('dataset_id', datasetId);
  } catch (delErr) {
    console.warn('Warning: renewals cleanup error:', delErr.message);
  }

  const batchSize = 100;
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    const { error } = await supabase
      .from('renewals')
      .insert(batch);

    if (error) {
      console.error(`Error uploading batch ${i} to ${i + batchSize}:`, error.message);
    } else {
      console.log(`Successfully uploaded batch ${i} to ${Math.min(i + batchSize, records.length)}`);
    }
  }

  console.log('Migration complete!');
}

migrateData().catch(console.error);
