require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;

// Increase payload limit for Excel base64 uploads
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Supabase setup (with local Excel fallback if missing)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

let supabase = null;
if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey);
} else {
  console.warn("⚠️  SUPABASE_URL or SUPABASE_KEY not found in environment variables.");
  console.warn("📁 Running in Local Multi-Dataset Fallback Mode.");
}

const PUBLIC_DIR = path.join(__dirname, "public");
const EXCEL_FILE = path.join(__dirname, "Renewal_Opportunity_1000_Realistic.xlsx");
const DATASETS_FILE = path.join(__dirname, "local_datasets.json");

// In-memory cache & fallback logs for Local Excel mode
let localLogs = [];

// Schema Inference Algorithm
function inferSchema(rows, requestedPrimaryKey) {
  if (!rows || rows.length === 0) {
    return {
      primaryKey: "ID",
      columns: [{ column_name: "ID", data_type: "text", is_primary_key: true, display_order: 0 }]
    };
  }

  const rawHeaders = Object.keys(rows[0]);
  const cleanColumns = rawHeaders.map((h, i) => {
    const trimmed = String(h || "").trim();
    return trimmed.length > 0 ? trimmed : `Column_${i + 1}`;
  });

  const columns = [];
  const typeMap = {};

  cleanColumns.forEach((col, colIdx) => {
    const nonEmptyVals = rows
      .map(r => r[col])
      .filter(v => v !== null && v !== undefined && String(v).trim() !== "");

    let dataType = "text";

    if (nonEmptyVals.length > 0) {
      const isDate = nonEmptyVals.every(v => {
        if (v instanceof Date) return !isNaN(v.getTime());
        const str = String(v).trim();
        if (str.length < 6) return false;
        if (/^\d{4}-\d{2}-\d{2}/.test(str) || /^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(str)) return true;
        const parsed = Date.parse(str);
        return !isNaN(parsed);
      });

      if (isDate) {
        dataType = "date";
      } else {
        const isNumeric = nonEmptyVals.every(v => {
          const cleanStr = String(v).replace(/[$€£₹,]/g, "").trim();
          return cleanStr !== "" && !isNaN(Number(cleanStr));
        });

        if (isNumeric) {
          const colLower = col.toLowerCase();
          const isCurrencyName = /amount|tcv|acv|revenue|price|cost|val|fee|budget|\(\$\)/i.test(colLower);
          const hasCurrencySymbol = nonEmptyVals.some(v => /[$€£₹]/.test(String(v)));
          dataType = (isCurrencyName || hasCurrencySymbol) ? "currency" : "number";
        } else {
          const uniqueVals = new Set(nonEmptyVals.map(v => String(v).trim()));
          if (uniqueVals.size <= 15 && uniqueVals.size > 0) {
            dataType = "category";
          } else {
            dataType = "text";
          }
        }
      }
    }

    typeMap[col] = dataType;
  });

  let primaryKey = null;

  if (requestedPrimaryKey && cleanColumns.includes(requestedPrimaryKey)) {
    primaryKey = requestedPrimaryKey;
  } else {
    for (const col of cleanColumns) {
      const type = typeMap[col];
      if (type === "text" || type === "category") {
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

function getInitialExcelData() {
  if (!fs.existsSync(EXCEL_FILE)) {
    const fallbackFile = path.join(__dirname, "Renewal_Opportunity_Expanded.xlsx");
    if (fs.existsSync(fallbackFile)) {
      const workbook = XLSX.readFile(fallbackFile, { cellDates: true });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      return XLSX.utils.sheet_to_json(sheet, { defval: "" });
    }
    return [];
  }
  const workbook = XLSX.readFile(EXCEL_FILE, { cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: "" });
}

function getLocalDatasets() {
  if (fs.existsSync(DATASETS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(DATASETS_FILE, "utf-8"));
      if (Array.isArray(data) && data.length > 0) return data;
    } catch (e) {
      console.error("Error reading local_datasets.json:", e);
    }
  }

  // Create default dataset #1 from Renewal_Opportunity_1000_Realistic.xlsx
  const defaultRows = getInitialExcelData();
  const defaultSchema = inferSchema(defaultRows);
  const defaultDataset = {
    id: "ds_default_1000",
    name: "Renewal_Opportunity_1000_Realistic.xlsx",
    uploaded_at: new Date().toISOString(),
    row_count: defaultRows.length,
    column_count: defaultSchema.columns.length,
    primary_key: defaultSchema.primaryKey,
    is_active: true,
    schema: defaultSchema,
    rows: defaultRows
  };

  const datasets = [defaultDataset];
  saveLocalDatasets(datasets);
  return datasets;
}

function saveLocalDatasets(datasets) {
  try {
    fs.writeFileSync(DATASETS_FILE, JSON.stringify(datasets, null, 2), "utf-8");
  } catch (e) {
    console.error("Error writing local_datasets.json:", e);
  }
}

async function getActiveDatasetInfo() {
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("datasets")
        .select("*")
        .eq("is_active", true)
        .limit(1);

      if (!error && data && data.length > 0) {
        return data[0];
      }
    } catch (e) {
      console.warn("Supabase active dataset query warning:", e.message);
    }
  }

  const datasets = getLocalDatasets();
  return datasets.find(d => d.is_active) || datasets[0] || null;
}

async function getActiveSchema() {
  if (supabase) {
    try {
      const activeDs = await getActiveDatasetInfo();
      if (activeDs) {
        const { data, error } = await supabase
          .from("dataset_schema")
          .select("*")
          .eq("dataset_id", activeDs.id)
          .order("display_order", { ascending: true });

        if (!error && data && data.length > 0) {
          const pkCol = data.find(c => c.is_primary_key)?.column_name || data[0].column_name;
          return {
            primaryKey: pkCol,
            columns: data.map(c => ({
              column_name: c.column_name,
              data_type: c.data_type,
              is_primary_key: c.is_primary_key,
              display_order: c.display_order
            }))
          };
        }
      }
    } catch (err) {
      console.warn("Supabase dataset_schema fetch error:", err.message);
    }
  }

  const activeDs = getLocalDatasets().find(d => d.is_active);
  return activeDs ? activeDs.schema : { primaryKey: "", columns: [] };
}

app.use(express.static(PUBLIC_DIR));

// SSE Clients array
let sseClients = [];

function broadcastEvent(data) {
  sseClients.forEach(client => client.res.write(`data: ${JSON.stringify(data)}\n\n`));
}

// SSE Endpoint for real-time notifications
app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const clientId = Date.now();
  const newClient = { id: clientId, res };
  sseClients.push(newClient);

  req.on("close", () => {
    sseClients = sseClients.filter(client => client.id !== clientId);
  });
});

// Endpoint to fetch activity logs
app.get("/api/logs", async (req, res) => {
  try {
    if (supabase) {
      const { data, error } = await supabase
        .from("activity_logs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(100);

      if (!error && data && data.length > 0) {
        const combined = [...data, ...localLogs].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        return res.json({ success: true, logs: combined });
      }
    }

    res.json({ success: true, logs: localLogs });
  } catch (error) {
    console.error("Error fetching logs:", error);
    res.json({ success: true, logs: localLogs });
  }
});

// GET /api/datasets - List all datasets in history
app.get("/api/datasets", async (req, res) => {
  try {
    if (supabase) {
      const { data, error } = await supabase
        .from("datasets")
        .select("*")
        .order("uploaded_at", { ascending: false });

      if (!error && data) {
        return res.json({ success: true, datasets: data });
      }
    }

    const datasets = getLocalDatasets();
    const list = datasets.map(d => ({
      id: d.id,
      name: d.name,
      uploaded_at: d.uploaded_at,
      row_count: d.row_count,
      column_count: d.column_count,
      primary_key: d.primary_key,
      is_active: !!d.is_active
    })).sort((a, b) => new Date(b.uploaded_at) - new Date(a.uploaded_at));

    res.json({ success: true, datasets: list });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/datasets/:id/activate - Switch active dataset
app.post("/api/datasets/:id/activate", async (req, res) => {
  try {
    const datasetId = req.params.id;

    if (supabase) {
      await supabase.from("datasets").update({ is_active: false }).neq("id", "00000000-0000-0000-0000-000000000000");
      const { data, error } = await supabase
        .from("datasets")
        .update({ is_active: true })
        .eq("id", datasetId)
        .select();

      if (error) throw error;
      const activeName = data && data[0] ? data[0].name : "Dataset";

      broadcastEvent({ action: "DatasetSwitched", message: `Switched active dataset to '${activeName}'` });
      return res.json({ success: true, message: `Switched active dataset to '${activeName}'` });
    }

    const datasets = getLocalDatasets();
    let targetName = "Dataset";
    datasets.forEach(d => {
      if (d.id === datasetId) {
        d.is_active = true;
        targetName = d.name;
      } else {
        d.is_active = false;
      }
    });

    saveLocalDatasets(datasets);

    localLogs.unshift({
      id: Date.now(),
      action: "Switched",
      record_name: targetName,
      details: `Switched active dataset to '${targetName}'`,
      changes: null,
      created_at: new Date().toISOString()
    });

    broadcastEvent({ action: "DatasetSwitched", message: `Switched active dataset to '${targetName}'` });
    res.json({ success: true, message: `Switched active dataset to '${targetName}'` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE /api/datasets/:id - Delete a dataset from history
app.delete("/api/datasets/:id", async (req, res) => {
  try {
    const datasetId = req.params.id;

    if (supabase) {
      // Check if dataset is active
      const { data: targetDs } = await supabase.from("datasets").select("*").eq("id", datasetId).single();
      const wasActive = targetDs && targetDs.is_active;

      await supabase.from("renewals").delete().eq("dataset_id", datasetId);
      await supabase.from("dataset_schema").delete().eq("dataset_id", datasetId);
      await supabase.from("datasets").delete().eq("id", datasetId);

      if (wasActive) {
        // Activate next available dataset if exists
        const { data: remaining } = await supabase.from("datasets").select("*").order("uploaded_at", { ascending: false }).limit(1);
        if (remaining && remaining.length > 0) {
          await supabase.from("datasets").update({ is_active: true }).eq("id", remaining[0].id);
        }
      }

      broadcastEvent({ action: "DatasetDeleted", message: `Dataset deleted successfully.` });
      return res.json({ success: true, message: "Dataset deleted successfully." });
    }

    let datasets = getLocalDatasets();
    const targetIndex = datasets.findIndex(d => d.id === datasetId);
    if (targetIndex === -1) {
      return res.status(404).json({ success: false, message: "Dataset not found" });
    }

    const wasActive = datasets[targetIndex].is_active;
    const dsName = datasets[targetIndex].name;
    datasets.splice(targetIndex, 1);

    if (wasActive && datasets.length > 0) {
      datasets[0].is_active = true;
    }

    saveLocalDatasets(datasets);

    localLogs.unshift({
      id: Date.now(),
      action: "Deleted",
      record_name: dsName,
      details: `Deleted dataset '${dsName}' from history`,
      changes: null,
      created_at: new Date().toISOString()
    });

    broadcastEvent({ action: "DatasetDeleted", message: `Deleted dataset '${dsName}'.` });
    res.json({ success: true, message: `Deleted dataset '${dsName}'.` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Endpoint to fetch active dataset schema
app.get("/api/schema", async (req, res) => {
  try {
    const schema = await getActiveSchema();
    res.json({ success: true, schema });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Endpoint to clear current active dataset
app.post("/api/dataset/clear", async (req, res) => {
  try {
    const activeDs = await getActiveDatasetInfo();
    if (!activeDs) {
      return res.json({ success: true, message: "No active dataset to clear." });
    }

    if (supabase) {
      await supabase.from("renewals").delete().eq("dataset_id", activeDs.id);
      await supabase.from("dataset_schema").delete().eq("dataset_id", activeDs.id);
      await supabase.from("datasets").delete().eq("id", activeDs.id);

      const { data: remaining } = await supabase.from("datasets").select("*").order("uploaded_at", { ascending: false }).limit(1);
      if (remaining && remaining.length > 0) {
        await supabase.from("datasets").update({ is_active: true }).eq("id", remaining[0].id);
      }

      await supabase.from("activity_logs").insert([{
        action: "Cleared",
        record_name: activeDs.name || "Dataset",
        details: `Cleared active dataset '${activeDs.name || "Dataset"}'`,
        changes: null
      }]);
    } else {
      let datasets = getLocalDatasets();
      const idx = datasets.findIndex(d => d.id === activeDs.id);
      if (idx !== -1) {
        const name = datasets[idx].name;
        datasets.splice(idx, 1);
        if (datasets.length > 0) datasets[0].is_active = true;
        saveLocalDatasets(datasets);

        localLogs.unshift({
          id: Date.now(),
          action: "Cleared",
          record_name: name,
          details: `Cleared active dataset '${name}'`,
          changes: null,
          created_at: new Date().toISOString()
        });
      }
    }

    broadcastEvent({
      action: "DatasetCleared",
      recordName: "Dataset",
      message: "Active dataset cleared successfully.",
      timestamp: new Date().toISOString()
    });

    res.json({
      success: true,
      message: "Active dataset cleared successfully."
    });
  } catch (error) {
    console.error("Error clearing dataset:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Endpoint to upload a new Excel or CSV file
app.post("/api/upload", async (req, res) => {
  try {
    const { fileData, filename, primaryKey } = req.body;
    if (!fileData) {
      return res.status(400).json({ success: false, message: "File data (base64) is required" });
    }

    const buffer = Buffer.from(fileData, "base64");
    const workbook = XLSX.read(buffer, { cellDates: true, raw: false });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

    if (!rows || rows.length === 0) {
      return res.status(400).json({ success: false, message: "Uploaded file contains no data rows" });
    }

    const inferred = inferSchema(rows, primaryKey);
    const pkField = inferred.primaryKey;

    const cleanedRows = rows.map((r, idx) => {
      const cleanObj = {};
      Object.keys(r).forEach(k => {
        cleanObj[String(k).trim()] = r[k];
      });
      if (!cleanObj[pkField]) {
        cleanObj[pkField] = `Record_${idx + 1}`;
      } else {
        cleanObj[pkField] = String(cleanObj[pkField]).trim();
      }
      return cleanObj;
    });

    const datasetId = "ds_" + Date.now();
    const datasetName = filename || `Upload_${new Date().toISOString().split("T")[0]}.xlsx`;

    if (supabase) {
      // Deactivate existing datasets
      await supabase.from("datasets").update({ is_active: false }).neq("id", "00000000-0000-0000-0000-000000000000");

      // Insert dataset record
      await supabase.from("datasets").insert([{
        id: datasetId,
        name: datasetName,
        uploaded_at: new Date().toISOString(),
        row_count: cleanedRows.length,
        column_count: inferred.columns.length,
        primary_key: pkField,
        is_active: true
      }]);

      // Insert schema
      const schemaRecords = inferred.columns.map(c => ({
        dataset_id: datasetId,
        column_name: c.column_name,
        data_type: c.data_type,
        is_primary_key: c.is_primary_key,
        display_order: c.display_order
      }));
      await supabase.from("dataset_schema").insert(schemaRecords);

      // Insert rows
      const records = cleanedRows.map(row => ({
        dataset_id: datasetId,
        data: row
      }));

      const batchSize = 100;
      for (let i = 0; i < records.length; i += batchSize) {
        const batch = records.slice(i, i + batchSize);
        const { error: batchErr } = await supabase.from("renewals").insert(batch);
        if (batchErr) {
          console.error("Batch upload error:", batchErr.message);
          throw batchErr;
        }
      }
    } else {
      let datasets = getLocalDatasets();
      datasets.forEach(d => d.is_active = false);

      const newDataset = {
        id: datasetId,
        name: datasetName,
        uploaded_at: new Date().toISOString(),
        row_count: cleanedRows.length,
        column_count: inferred.columns.length,
        primary_key: pkField,
        is_active: true,
        schema: inferred,
        rows: cleanedRows
      };

      datasets.unshift(newDataset);
      saveLocalDatasets(datasets);
    }

    localLogs.unshift({
      id: Date.now(),
      action: "Uploaded",
      record_name: datasetName,
      details: `Uploaded '${datasetName}' with ${cleanedRows.length} rows. Primary Key: ${pkField}`,
      changes: null,
      created_at: new Date().toISOString()
    });

    broadcastEvent({
      action: "Uploaded",
      recordName: datasetName,
      message: `Uploaded '${datasetName}' with ${cleanedRows.length} rows (Primary Key: ${pkField})`,
      timestamp: new Date().toISOString()
    });

    res.json({
      success: true,
      count: cleanedRows.length,
      schema: inferred,
      message: `Successfully loaded ${cleanedRows.length} records.`
    });
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/search?q=query - Server-side search endpoint across active dataset
app.get("/api/search", async (req, res) => {
  try {
    const query = String(req.query.q || "").trim().toLowerCase();
    const schema = await getActiveSchema();
    const activeDs = await getActiveDatasetInfo();

    if (!activeDs) {
      return res.json({ success: true, count: 0, rows: [], schema });
    }

    let rows = [];
    if (supabase) {
      const { data, error } = await supabase
        .from("renewals")
        .select("data")
        .eq("dataset_id", activeDs.id);

      if (!error && data) {
        rows = data.map(r => r.data);
      }
    } else {
      const datasets = getLocalDatasets();
      const target = datasets.find(d => d.id === activeDs.id);
      if (target) rows = target.rows || [];
    }

    if (!query) {
      return res.json({ success: true, count: rows.length, rows: rows, schema });
    }

    const filtered = rows.filter(r => {
      return Object.values(r).some(val => String(val ?? "").toLowerCase().includes(query));
    });

    res.json({
      success: true,
      count: filtered.length,
      rows: filtered,
      schema: schema
    });
  } catch (error) {
    console.error("Search error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/api/data", async (req, res) => {
  try {
    const activeDs = await getActiveDatasetInfo();
    const schema = await getActiveSchema();

    if (!activeDs) {
      return res.json({
        success: true,
        source: "No Active Dataset",
        sheet: "Renewals",
        lastModified: new Date().toISOString(),
        count: 0,
        rows: [],
        schema: { primaryKey: "", columns: [] }
      });
    }

    if (supabase) {
      let allData = [];
      let from = 0;
      const step = 1000;
      let hasMore = true;
      let totalCount = 0;

      while (hasMore) {
        const { data, error, count } = await supabase
          .from("renewals")
          .select("data", { count: "exact" })
          .eq("dataset_id", activeDs.id)
          .range(from, from + step - 1);

        if (error) throw error;
        if (from === 0) totalCount = count;

        allData = allData.concat(data);

        if (data.length < step) {
          hasMore = false;
        } else {
          from += step;
        }
      }

      const rows = allData.map((row) => row.data);

      return res.json({
        success: true,
        source: `Supabase DB (${activeDs.name})`,
        sheet: "Renewals",
        lastModified: activeDs.uploaded_at || new Date().toISOString(),
        count: totalCount || rows.length,
        rows: rows,
        schema: schema
      });
    }

    const datasets = getLocalDatasets();
    const target = datasets.find(d => d.id === activeDs.id) || datasets[0];

    res.json({
      success: true,
      source: `Local File (${target ? target.name : 'Dataset'})`,
      sheet: "Renewals",
      lastModified: target ? target.uploaded_at : new Date().toISOString(),
      count: target ? target.rows.length : 0,
      rows: target ? target.rows : [],
      schema: schema
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post("/api/data", async (req, res) => {
  try {
    const newData = req.body;
    const schema = await getActiveSchema();
    const activeDs = await getActiveDatasetInfo();
    const pkField = schema.primaryKey || "ID";

    if (!newData || !newData[pkField]) {
      return res.status(400).json({ success: false, message: `${pkField} (Primary Key) is required` });
    }

    const primaryKeyValue = String(newData[pkField]).trim();

    if (supabase && activeDs) {
      let allRecords = [];
      let from = 0;
      const step = 1000;
      let hasMore = true;

      while (hasMore) {
        const { data, error } = await supabase
          .from("renewals")
          .select("id, data")
          .eq("dataset_id", activeDs.id)
          .range(from, from + step - 1);

        if (error) throw error;
        allRecords = allRecords.concat(data || []);
        if ((data || []).length < step) hasMore = false;
        else from += step;
      }

      const existingRecord = allRecords.find(r => 
        r.data && String(r.data[pkField] || '').trim().toLowerCase() === primaryKeyValue.toLowerCase()
      );

      let mergedData = newData;
      let isUpdate = false;
      let changes = null;

      if (existingRecord) {
        const oldData = existingRecord.data;
        mergedData = { ...oldData, ...newData };
        isUpdate = true;

        changes = {};
        for (const key in newData) {
          if (String(newData[key] ?? '') !== String(oldData[key] ?? '') && key !== pkField) {
            changes[key] = { old: oldData[key] || "—", new: newData[key] || "—" };
          }
        }
        if (Object.keys(changes).length === 0) changes = null;

        const { error: updateError } = await supabase
          .from("renewals")
          .update({ data: mergedData })
          .eq("id", existingRecord.id);

        if (updateError) throw updateError;
      } else {
        const { error: insertError } = await supabase
          .from("renewals")
          .insert([{ dataset_id: activeDs.id, data: newData }]);

        if (insertError) throw insertError;
      }

      const action = isUpdate ? "Updated" : "Added";
      const logMessage = `${action} record: ${primaryKeyValue}`;
      
      const logItem = {
        id: Date.now(),
        action: action,
        record_name: primaryKeyValue,
        details: logMessage,
        changes: changes,
        created_at: new Date().toISOString()
      };
      localLogs.unshift(logItem);

      try {
        await supabase.from("activity_logs").insert([{
          action: action,
          record_name: primaryKeyValue,
          details: logMessage,
          changes: changes
        }]);
      } catch (logErr) {
        // Log saved in localLogs array
      }

      broadcastEvent({
        action: action,
        recordName: primaryKeyValue,
        message: logMessage,
        timestamp: new Date().toISOString()
      });

      return res.json({ success: true, message: `Record ${isUpdate ? 'updated' : 'added'} successfully` });
    }

    let datasets = getLocalDatasets();
    const target = datasets.find(d => d.id === (activeDs ? activeDs.id : ''));
    if (target) {
      const existingIndex = target.rows.findIndex(
        (r) => String(r[pkField]).trim() === primaryKeyValue
      );
      let isUpdate = false;
      let changes = null;

      if (existingIndex >= 0) {
        const oldData = target.rows[existingIndex];
        target.rows[existingIndex] = { ...oldData, ...newData };
        isUpdate = true;
        changes = {};
        for (const key in newData) {
          if (newData[key] !== oldData[key] && key !== pkField) {
            if (!oldData[key] && !newData[key]) continue;
            changes[key] = { old: oldData[key] || "—", new: newData[key] || "—" };
          }
        }
        if (Object.keys(changes).length === 0) changes = null;
      } else {
        target.rows.unshift(newData);
        target.row_count = target.rows.length;
      }

      saveLocalDatasets(datasets);

      const action = isUpdate ? "Updated" : "Added";
      const logMessage = `${action} record: ${primaryKeyValue}`;

      localLogs.unshift({
        id: Date.now(),
        action: action,
        record_name: primaryKeyValue,
        details: logMessage,
        changes: changes,
        created_at: new Date().toISOString()
      });

      broadcastEvent({
        action: action,
        recordName: primaryKeyValue,
        message: logMessage,
        timestamp: new Date().toISOString()
      });
    }

    res.json({ success: true, message: "Data saved successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", mode: supabase ? "supabase" : "local_excel", time: new Date().toISOString() });
});

if (process.env.NODE_ENV !== "production") {
  app.listen(PORT, () => {
    console.log(`Renewal Dashboard running at http://localhost:${PORT}`);
    console.log(`Data Source: ${supabase ? `Supabase (${supabaseUrl})` : "Local Multi-Dataset Mode"}`);
  });
}

module.exports = app;
