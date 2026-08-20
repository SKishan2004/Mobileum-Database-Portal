# Renewal Management Dashboard

## Architecture

Excel -> Node.js / Express -> `/api/data` -> HTML/JavaScript dashboard

The HTML does **not** contain the opportunity data. Node.js reads the Excel workbook and returns the current rows through the API.

## Run

1. Install Node.js.
2. Open a terminal in this folder.
3. Run:

```bash
npm install
npm start
```

4. Open:

http://localhost:3000

## Updating the Excel

Replace/edit `Renewal_Opportunity_Test_Data.xlsx` while the server is running.

The dashboard calls `/api/data` every 60 seconds and the API reads the workbook again, so saved Excel changes are reflected without rebuilding the HTML.

For production, you can later point `EXCEL_FILE` to a SharePoint-synced/local workbook or replace the Excel-reading layer with Microsoft Graph/SharePoint APIs.
