require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { listRawFiles, RAW_PREFIX, PROCESSED_PREFIX } = require('./s3');
const { processVideo } = require('./processor');
const { createJob, getJob, listJobs } = require('./jobs');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// List files in RAW — groups videos with their matching CSV transcripts
app.get('/api/files', async (req, res) => {
  try {
    const keys = await listRawFiles();
    const files = keys.filter(k => k !== RAW_PREFIX);

    const videos = files.filter(k => /\.(mp4|mov|avi|mkv|webm)$/i.test(k));
    const csvs = files.filter(k => /\.csv$/i.test(k));

    const grouped = videos.map(videoKey => {
      const base = videoKey.replace(/\.[^.]+$/, '');
      const csvKey = csvs.find(c => c.startsWith(base)) || null;
      return { videoKey, csvKey, hasTranscript: !!csvKey };
    });

    res.json({ files: grouped });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// List processed clips
app.get('/api/processed', async (req, res) => {
  try {
    const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
    const { s3, BUCKET } = require('./s3');
    const cmd = new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PROCESSED_PREFIX });
    const result = await s3.send(cmd);
    const clips = (result.Contents || [])
      .map(o => o.Key)
      .filter(k => k !== PROCESSED_PREFIX);
    res.json({ clips });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start a processing job
app.post('/api/process', async (req, res) => {
  const { videoKey, csvKey } = req.body;
  if (!videoKey || !csvKey) {
    return res.status(400).json({ error: 'videoKey and csvKey are required' });
  }

  const jobId = createJob(videoKey);
  res.json({ jobId });

  // Run async — don't await
  processVideo(jobId, videoKey, csvKey).catch(err =>
    console.error(`Job ${jobId} failed:`, err.message)
  );
});

// Job status
app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// All jobs
app.get('/api/jobs', (req, res) => {
  res.json({ jobs: listJobs() });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
