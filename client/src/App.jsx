import { useState, useEffect, useCallback } from 'react';
import { fetchRows, startJob, fetchJob, fetchJobs } from './api';
import './App.css';

const STATUS_COLOR = {
  'Moments Found': '#f0a500',
  'Processing':    '#2196f3',
  'Clipped':       '#4caf50',
  'Error':         '#f44336',
};

function statusColor(s) {
  return STATUS_COLOR[s] || '#888';
}

function jobStatusColor(s) {
  return { queued: '#888', downloading: '#f0a500', processing: '#2196f3', done: '#4caf50', error: '#f44336' }[s] || '#888';
}

function MomentPill({ moment, index }) {
  const dur = Math.round((moment.endMs - moment.startMs) / 1000);
  return (
    <div className="moment-pill">
      <span className="moment-num">{index + 1}</span>
      <span className="moment-title">{moment.title}</span>
      <span className="moment-dur">{dur}s</span>
    </div>
  );
}

function JobRow({ job }) {
  return (
    <div className="job-row">
      <div className="job-meta">
        <span className="job-video">{job.videoKey}</span>
        <span className="job-status" style={{ color: jobStatusColor(job.status) }}>{job.status}</span>
        {job.totalClips && <span className="job-clips">{job.clipsProcessed || 0}/{job.totalClips} clips</span>}
      </div>
      {(job.status === 'processing' || job.status === 'downloading') && (
        <div className="progress-bar">
          <div className="progress-fill" style={{ width: `${job.progress}%` }} />
        </div>
      )}
      {job.status === 'done' && (
        <div className="job-output">
          {job.clips.map(c => <div key={c} className="clip-key">{c.split('/').pop()}</div>)}
        </div>
      )}
      {job.error && <div className="job-error">{job.error}</div>}
    </div>
  );
}

export default function App() {
  const [rows, setRows] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [activeJobs, setActiveJobs] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('sheet');

  const loadAll = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    try {
      const [{ rows }, { jobs: jobList }] = await Promise.all([fetchRows(), fetchJobs()]);
      setRows(rows);
      setJobs(jobList);
      const running = new Set(jobList.filter(j => j.status !== 'done' && j.status !== 'error').map(j => j.id));
      setActiveJobs(running);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Poll active jobs every 2s
  useEffect(() => {
    if (activeJobs.size === 0) return;
    const interval = setInterval(async () => {
      const updates = await Promise.all([...activeJobs].map(id => fetchJob(id).catch(() => null)));
      setJobs(prev => {
        const map = new Map(prev.map(j => [j.id, j]));
        updates.forEach(u => u && map.set(u.id, u));
        return Array.from(map.values());
      });
      const stillRunning = new Set(updates.filter(u => u && u.status !== 'done' && u.status !== 'error').map(u => u.id));
      setActiveJobs(stillRunning);
      if (stillRunning.size === 0) loadAll(true);
    }, 2000);
    return () => clearInterval(interval);
  }, [activeJobs, loadAll]);

  async function handleProcess(row) {
    try {
      const { jobId } = await startJob(row.rowNum);
      const job = await fetchJob(jobId);
      setJobs(prev => [job, ...prev]);
      setActiveJobs(prev => new Set([...prev, jobId]));
      // Optimistically mark row as Processing
      setRows(prev => prev.map(r => r.rowNum === row.rowNum ? { ...r, status: 'Processing' } : r));
      setTab('jobs');
    } catch (e) {
      alert(`Failed to start job: ${e.message}`);
    }
  }

  const readyCount = rows.filter(r => r.status === 'Moments Found').length;
  const runningCount = activeJobs.size;

  if (loading) return <div className="loading">Loading sheet data…</div>;
  if (error) return <div className="error">Error: {error}<br /><small>Check that the server is running and Google Sheets credentials are configured.</small></div>;

  return (
    <div className="app">
      <header>
        <div className="header-row">
          <div>
            <h1>Clipping Tool</h1>
            <p className="subtitle">SAT video processor — cuts clips from Google Sheets moments</p>
          </div>
          <button className="refresh-btn" onClick={() => loadAll(true)} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>

      <nav className="tabs">
        <button className={tab === 'sheet' ? 'active' : ''} onClick={() => setTab('sheet')}>
          Sheet Rows ({rows.length}) {readyCount > 0 && <span className="badge">{readyCount} ready</span>}
        </button>
        <button className={tab === 'jobs' ? 'active' : ''} onClick={() => setTab('jobs')}>
          Jobs {runningCount > 0 ? <span className="badge running">{runningCount} running</span> : `(${jobs.length})`}
        </button>
      </nav>

      {tab === 'sheet' && (
        <section>
          {rows.length === 0 ? (
            <div className="empty">No rows found in the sheet.</div>
          ) : (
            <div className="row-list">
              {rows.map(row => (
                <div key={row.rowNum} className="sheet-row">
                  <div className="sheet-row-header">
                    <div className="sheet-row-title">
                      <span className="row-title">{row.title || '(untitled)'}</span>
                      <span className="row-date">{row.date}</span>
                    </div>
                    <div className="sheet-row-actions">
                      <span className="row-status" style={{ color: statusColor(row.status) }}>{row.status}</span>
                      <button
                        disabled={row.status !== 'Moments Found'}
                        onClick={() => handleProcess(row)}
                        title={row.status !== 'Moments Found' ? `Status: ${row.status}` : 'Clip this video'}
                      >
                        Clip
                      </button>
                    </div>
                  </div>
                  {row.moments?.length > 0 && (
                    <div className="moments">
                      {row.moments.map((m, i) => <MomentPill key={i} moment={m} index={i} />)}
                    </div>
                  )}
                  {row.clip1Url && (
                    <div className="clips-done">
                      {[row.clip1Url, row.clip2Url, row.clip3Url].filter(Boolean).map(url => (
                        <a key={url} href={url} target="_blank" rel="noreferrer" className="clip-link">
                          {url.split('/').pop()}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {tab === 'jobs' && (
        <section>
          {jobs.length === 0 ? (
            <div className="empty">No jobs yet. Go to Sheet Rows and click Clip.</div>
          ) : (
            <div className="job-list">
              {jobs.map(j => <JobRow key={j.id} job={j} />)}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
