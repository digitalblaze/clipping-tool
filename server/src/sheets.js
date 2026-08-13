const { google } = require('googleapis');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = 'Sheet1';

// Column indexes (0-based)
const COL = {
  MEETING_ID:   0,  // A
  TITLE:        1,  // B
  DATE:         2,  // C
  STATUS:       3,  // D
  VTT_LINK:     4,  // E
  TRANSCRIPT:   5,  // F
  ZOOM_URL:     6,  // G
  DURATION:     7,  // H
  MOMENTS_JSON: 8,  // I
  MOMENT_1:     9,  // J
  MOMENT_2:    10,  // K
  MOMENT_3:    11,  // L
  JOB_ID:      12,  // M
  CLIP_1_URL:  13,  // N
  CLIP_2_URL:  14,  // O
  CLIP_3_URL:  15,  // P
  BRIGHTCOVE:  16,  // Q
  ERROR:       17,  // R
};

function getAuth() {
  return new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

function getSheets() {
  return google.sheets({ version: 'v4', auth: getAuth() });
}

async function getRows() {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A2:R`,
  });
  const rows = res.data.values || [];
  return rows.map((row, i) => rowToObject(row, i + 2));
}

async function getReadyRows() {
  const rows = await getRows();
  return rows.filter(r => r.status === 'Moments Found');
}

function rowToObject(row, rowNum) {
  let moments = [];
  try {
    moments = JSON.parse(row[COL.MOMENTS_JSON] || '[]');
  } catch (_) {}

  return {
    rowNum,
    meetingId:   row[COL.MEETING_ID]   || '',
    title:       row[COL.TITLE]        || '',
    date:        row[COL.DATE]         || '',
    status:      row[COL.STATUS]       || '',
    zoomUrl:     row[COL.ZOOM_URL]     || '',
    duration:    row[COL.DURATION]     || '',
    moments,
    jobId:       row[COL.JOB_ID]       || '',
    clip1Url:    row[COL.CLIP_1_URL]   || '',
    clip2Url:    row[COL.CLIP_2_URL]   || '',
    clip3Url:    row[COL.CLIP_3_URL]   || '',
    error:       row[COL.ERROR]        || '',
  };
}

async function updateRow(rowNum, patch) {
  const sheets = getSheets();

  const updates = [];

  if (patch.status !== undefined)
    updates.push({ range: `${SHEET_NAME}!D${rowNum}`, values: [[patch.status]] });
  if (patch.jobId !== undefined)
    updates.push({ range: `${SHEET_NAME}!M${rowNum}`, values: [[patch.jobId]] });
  if (patch.clip1Url !== undefined)
    updates.push({ range: `${SHEET_NAME}!N${rowNum}`, values: [[patch.clip1Url]] });
  if (patch.clip2Url !== undefined)
    updates.push({ range: `${SHEET_NAME}!O${rowNum}`, values: [[patch.clip2Url]] });
  if (patch.clip3Url !== undefined)
    updates.push({ range: `${SHEET_NAME}!P${rowNum}`, values: [[patch.clip3Url]] });
  if (patch.error !== undefined)
    updates.push({ range: `${SHEET_NAME}!R${rowNum}`, values: [[patch.error]] });

  if (updates.length === 0) return;

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: updates,
    },
  });
}

module.exports = { getRows, getReadyRows, updateRow };
