require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { getRows, getReadyRows } = require('./sheets');
const { processRow } = require('./processor');
const { createJob, getJob, listJobs } = require('./jobs');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok' }));

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
