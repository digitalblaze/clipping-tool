require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { getRows, getReadyRows } = require('./sheets');
const { listPrefix, getObject, presignGet, PROCESSED_PREFIX, RAW_PREFIX } = require('./s3');
const { parseVtt } = require('./vtt');
const { processRow, processClipJob } = require('./processor');
const { createJob, getJob, listJobs } = require('./jobs');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Shared secret with the sheet's Apps Script (its CLIP_SERVICE_TOKEN).
const CLIP_SERVICE_TOKEN = process.env.CLIP_SERVICE_TOKEN;

function authorizeClipService(req, res) {
  if (!CLIP_SERVICE_TOKEN) {
    res.status(503).json({ error: 'CLIP_SERVICE_TOKEN is not configured on the server' });
    return false;
  }
  if (req.get('X-Clip-Token') !== CLIP_SERVICE_TOKEN) {
    res.status(401).json({ error: 'Invalid or missing X-Clip-Token' });
    return false;
  }
  return true;
}

/**
 * Clip service webhook called by step 3 of the sheet's Apps Script pipeline.
 * Accepts that script's payload verbatim and answers with { jobId }, which it
 * writes into the sheet's Clip Job ID column.
 */
app.post('/api/clip-jobs', (req, res) => {
  if (!authorizeClipService(req, res)) return;

  const { row, classTitle, sourceUrl, clips } = req.body || {};

  if (!Number.isInteger(row) || row < 2) {
    return res.status(400).json({ error: 'row must be an integer >= 2' });
  }
  if (!sourceUrl) return res.status(400).json({ error: 'sourceUrl is required' });
  if (!Array.isArray(clips) || clips.length === 0) {
    return res.status(400).json({ error: 'clips must be a non-empty array' });
  }
  const badClip = clips.findIndex(c =>
    !Number.isFinite(c?.startMs) || !Number.isFinite(c?.endMs) || c.endMs <= c.startMs);
  if (badClip !== -1) {
    return res.status(400).json({ error: `clips[${badClip}] has an invalid startMs/endMs range` });
  }

  const title = classTitle || `Row ${row}`;
  const jobId = createJob(title);
  res.json({ jobId });

  processClipJob(jobId, { row, classTitle: title, sourceUrl, clips })
    .catch(err => console.error(`Clip job ${jobId} (row ${row}) failed:`, err.message));
});

// All rows from the sheet
app.get('/api/rows', async (req, res) => {
  try {
    const rows = await getRows();
    res.json({ rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Everything the UI needs to show one class: the finished clips, the full
 * recording, and the transcript.
 *
 * Assets are looked up in S3 by the row's slug rather than from the sheet's
 * Drive links — the service account cannot read those Drive files, and the
 * bucket is private, so each asset is handed back as a presigned URL the
 * browser can play directly.
 */
app.get('/api/rows/:rowNum/assets', async (req, res) => {
  const rowNum = Number(req.params.rowNum);
  if (!Number.isInteger(rowNum)) return res.status(400).json({ error: 'bad rowNum' });

  try {
    const row = (await getRows()).find(r => r.rowNum === rowNum);
    if (!row) return res.status(404).json({ error: `Row ${rowNum} not found` });

    const [processed, raw] = await Promise.all([
      listPrefix(`${PROCESSED_PREFIX}${row.slug}`),
      listPrefix(`${RAW_PREFIX}${row.slug}`),
    ]);

    const clips = await Promise.all(
      processed
        .filter(o => o.Key.endsWith('.mp4'))
        .sort((a, b) => a.Key.localeCompare(b.Key))
        .map(async (o, i) => ({
          key: o.Key,
          name: o.Key.split('/').pop(),
          bytes: o.Size,
          url: await presignGet(o.Key),
          moment: row.moments[i] || null,
        })));

    const sourceObj = raw.find(o => o.Key.endsWith('-source.mp4'));
    const vttObj = raw.find(o => o.Key.endsWith('.vtt'));

    let transcript = null;
    if (vttObj) {
      const body = await getObject(vttObj.Key);
      transcript = { cues: parseVtt(await body.transformToString('utf-8')) };
    }

    res.json({
      row: {
        rowNum: row.rowNum, title: row.title, date: row.date, status: row.status,
        duration: row.duration, meetingId: row.meetingId, moments: row.moments,
        brightcove: row.brightcove, error: row.error, slug: row.slug,
      },
      clips,
      source: sourceObj
        ? { key: sourceObj.Key, bytes: sourceObj.Size, url: await presignGet(sourceObj.Key) }
        : null,
      transcript,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Only rows ready to clip
app.get('/api/rows/ready', async (req, res) => {
  try {
    const rows = await getReadyRows();
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start a clip job for a sheet row
app.post('/api/process', async (req, res) => {
  const { rowNum } = req.body;
  if (!rowNum) return res.status(400).json({ error: 'rowNum is required' });

  try {
    const rows = await getRows();
    const row = rows.find(r => r.rowNum === rowNum);
    if (!row) return res.status(404).json({ error: `Row ${rowNum} not found` });
    if (!row.zoomUrl) return res.status(400).json({ error: 'Row has no Zoom Source URL' });
    if (!row.moments?.length) return res.status(400).json({ error: 'Row has no moments' });

    const jobId = createJob(row.title);
    res.json({ jobId });

    processRow(jobId, row).catch(err =>
      console.error(`Job ${jobId} failed:`, err.message)
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Job status
app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

app.get('/api/jobs', (req, res) => res.json({ jobs: listJobs() }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
