const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

export async function fetchRows() {
  const res = await fetch(`${BASE}/api/rows`);
  if (!res.ok) throw new Error('Failed to fetch sheet rows');
  return res.json();
}

export async function startJob(rowNum) {
  const res = await fetch(`${BASE}/api/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rowNum }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to start job');
  }
  return res.json();
}

export async function fetchJob(jobId) {
  const res = await fetch(`${BASE}/api/jobs/${jobId}`);
  if (!res.ok) throw new Error('Job not found');
  return res.json();
}

export async function fetchJobs() {
  const res = await fetch(`${BASE}/api/jobs`);
  if (!res.ok) throw new Error('Failed to fetch jobs');
  return res.json();
}
