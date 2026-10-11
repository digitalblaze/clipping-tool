require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { getRows, getReadyRows } = require('./sheets');
const { listPrefix, getObject, presignGet, headObject, keyFromUrl, RAW_PREFIX } = require('./s3');
const { parseVtt } = require('./vtt');
const { processRow, processClipJob } = require('./processor');
const { createJob, getJob, listJobs } = require('./jobs');

const app = express();
app.use(cors());
// Express's JSON body parser defaults to a 100KB limit. step 3's payload now
// rides the full class transcript along as transcriptVtt (see processor.js's
// mirroring step) - a raw VTT for a multi-hour class comfortably exceeds
// that, so the request was rejected as 413 before ever reaching a route.
app.use(express.json({ limit: '15mb' }));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Diagnostic only — exposes no secrets, just which ffmpeg binary is
// actually running here, to compare against what works locally.
app.get('/health/ffmpeg', (req, res) => {
  const ffmpegPath = require('ffmpeg-static');
  const { execSync } = require('child_process');
  let versionOutput = null;
  try {
    versionOutput = execSync(`"${ffmpegPath}" -version`, { encoding: 'utf8', timeout: 5000 });
  } catch (err) {
    versionOutput = `exec failed: ${err.message}`;
  }
  res.json({
    nodePlatform: process.platform,
    nodeArch: process.arch,
    ffmpegPath,
    ffmpegVersionOutput: versionOutput,
  });
});

// TEMPORARY diagnostic — isolates whether the Render SIGSEGV is in decode
// (reading the remote source) or encode (libx264). Takes sourceUrl/startMs
// as query params and runs a 3-second cut two ways: -c copy (no encoding
// at all, just demux+remux) and a real libx264 re-encode. Not wired to any
// sheet row or S3 - a raw ffmpeg probe, nothing else. Remove once resolved.
app.get('/health/cuttest', async (req, res) => {
  const { execFile } = require('child_process');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const ffmpegPath = require('ffmpeg-static');
  const sourceUrl = req.query.sourceUrl;
  const startMs = Number(req.query.startMs || 0);
  if (!sourceUrl) return res.status(400).json({ error: 'sourceUrl query param required' });

  const startSec = startMs / 1000;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttest-'));

  function run(label, args) {
    return new Promise(resolve => {
      const proc = execFile(ffmpegPath, args, { timeout: 30000 }, (err, stdout, stderr) => {
        resolve({
          label,
          ok: !err,
          code: err?.code ?? 0,
          signal: err?.signal || null,
          stderrTail: String(stderr || '').split('\n').slice(-6).join('\n'),
        });
      });
    });
  }

  const copyOut = path.join(tmpDir, 'copy.mp4');
  const encodeOut = path.join(tmpDir, 'encode.mp4');

  let input = sourceUrl;
  let downloadMs = null;
  if (req.query.local === 'true') {
    const t0 = Date.now();
    const localPath = path.join(tmpDir, 'source.mp4');
    const https = require('https');
    await new Promise((resolve, reject) => {
      https.get(sourceUrl, r => {
        const file = fs.createWriteStream(localPath);
        r.pipe(file);
        file.on('finish', () => file.close(resolve));
      }).on('error', reject);
    });
    input = localPath;
    downloadMs = Date.now() - t0;
  }

  const copyResult = await run('decode-only (-c copy)', [
    '-y', '-ss', String(startSec), '-i', input, '-t', '3', '-c', 'copy', copyOut,
  ]);
  const encodeResult = await run('decode+encode (libx264)', [
    '-y', '-ss', String(startSec), '-i', input, '-t', '3',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-threads', '1',
    '-c:a', 'aac', '-pix_fmt', 'yuv420p', encodeOut,
  ]);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  res.json({ usedLocalFile: req.query.local === 'true', downloadMs, copyResult, encodeResult });
});

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

  const { row, classTitle, sourceUrl, clips, transcriptVtt } = req.body || {};

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

  processClipJob(jobId, { row, classTitle: title, sourceUrl, clips, transcriptVtt })
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
 * Clips are resolved from the sheet's own N/O/P columns, not by guessing a
 * filename — processClipJob is the only thing that ever writes those
 * columns, so whatever key it actually uploaded to is always recoverable
 * from there, regardless of what named it (our own slugify, or the Apps
 * Script step 3's outputKey, which uses a different, incompatible slug:
 * hyphens instead of underscores, and no date suffix). The stored URL's own
 * signature may be long expired; only its path (the object key) is reused,
 * then re-presigned fresh.
 *
 * The full recording and transcript aren't written by any automated step
 * yet (Apps Script step 1 saves those to Drive, which this service account
 * can't read), so those are still looked up in S3 by the row's slug — that
 * only ever matches a manual mirror uploaded under that same convention.
 */
app.get('/api/rows/:rowNum/assets', async (req, res) => {
  const rowNum = Number(req.params.rowNum);
  if (!Number.isInteger(rowNum)) return res.status(400).json({ error: 'bad rowNum' });

  try {
    const row = (await getRows()).find(r => r.rowNum === rowNum);
    if (!row) return res.status(404).json({ error: `Row ${rowNum} not found` });

    const raw = await listPrefix(`${RAW_PREFIX}${row.slug}`);

    const clipUrls = [row.clip1Url, row.clip2Url, row.clip3Url];
    const clips = (await Promise.all(
      clipUrls.map(async (storedUrl, i) => {
        if (!storedUrl) return null;
        const key = keyFromUrl(storedUrl);
        if (!key) return null;

        const [head, url] = await Promise.all([headObject(key), presignGet(key)]);
        if (!head) return null; // recorded but since deleted from S3

        return {
          key,
          name: key.split('/').pop(),
          bytes: head.bytes,
          url,
          moment: row.moments[i] || null,
        };
      })
    )).filter(Boolean);

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
