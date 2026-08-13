const { v4: uuidv4 } = require('uuid');

const jobs = new Map();

function createJob(videoKey) {
  const id = uuidv4();
  jobs.set(id, {
    id,
    videoKey,
    status: 'queued',
    progress: 0,
    clips: [],
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return id;
}

function updateJob(id, patch) {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
}

function getJob(id) {
  return jobs.get(id) || null;
}

function listJobs() {
  return Array.from(jobs.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

module.exports = { createJob, updateJob, getJob, listJobs };
