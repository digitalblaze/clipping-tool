import { useState, useEffect, useCallback } from 'react';
import { fetchFiles, fetchProcessed, startJob, fetchJob, fetchJobs } from './api';
import './App.css';

function statusColor(status) {
  return { queued: '#888', downloading: '#f0a500', processing: '#2196f3', done: '#4caf50', error: '#f44336' }[status] || '#888';
}

function JobRow({ job }) {
  return (
    <div className="job-row">
      <div className="job-meta">
        <span className="job-video">{job.videoKey.split('/').pop()}</span>
        <span className="job-status" style={{ color: statusColor(job.status) }}>{job.status}</span>
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
  const [files, setFiles] = useState([]);
  const [processed, setProcessed] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [activeJobs, setActiveJobs] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('files');

  const loadAll = useCallback(async () => {
    try {
      const [{ files }, { clips }, { jobs: jobList }] = await Promise.all([
        fetchFiles(), fetchProcessed(), fetchJobs(),
      ]);
      setFiles(files);
      setProcessed(clips);
      setJobs(jobList);
      const running = new Set(
        jobList.filter(j => j.status !== 'done' && j.status !== 'error').map(j => j.id)
      );
      setActiveJobs(running);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
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
      const stillRunning = new Set(
        updates.filter(u => u && u.status !== 'done' && u.status !== 'error').map(u => u.id)
      );
      setActiveJobs(stillRunning);
      if (stillRunning.size === 0) loadAll();
    }, 2000);
    return () => clearInterval(interval);
  }, [activeJobs, loadAll]);

  async function handleProcess(file) {
    try {
      const { jobId } = await startJob(file.videoKey, file.csvKey);
      const job = await fetchJob(jobId);
      setJobs(prev => [job, ...prev]);
      setActiveJobs(prev => new Set([...prev, jobId]));
      setTab('jobs');
    } catch (e) {
      alert(`Failed to start job: ${e.message}`);
    }
  }

  if (loading) return <div className="loading">Connecting to S3…</div>;
  if (error) return <div className="error">Error: {error}</div>;

  return (
    <div className="app">
      <header>
        <h1>Clipping Tool</h1>
        <p className="subtitle">SAT video processor — cuts clips from transcript timestamps</p>
      </header>

      <nav className="tabs">
        <button className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}>
          RAW Files ({files.length})
        </button>
        <button className={tab === 'jobs' ? 'active' : ''} onClick={() => setTab('jobs')}>
          Jobs {activeJobs.size > 0 ? `(${activeJobs.size} running)` : `(${jobs.length})`}
        </button>
        <button className={tab === 'processed' ? 'active' : ''} onClick={() => setTab('processed')}>
          Processed ({processed.length})
        </button>
      </nav>

      {tab === 'files' && (
        <section>
          {files.length === 0 ? (
            <div className="empty">No videos found in SAT/RAW/. Upload a video and its matching CSV transcript.</div>
          ) : (
            <table>
              <thead>
                <tr><th>Video</th><th>Transcript</th><th></th></tr>
              </thead>
              <tbody>
                {files.map(f => (
                  <tr key={f.videoKey}>
                    <td>{f.videoKey.replace('SAT/RAW/', '')}</td>
                    <td className={f.hasTranscript ? 'has-csv' : 'no-csv'}>
                      {f.hasTranscript ? f.csvKey.replace('SAT/RAW/', '') : '— missing'}
                    </td>
                    <td>
                      <button
                        disabled={!f.hasTranscript}
                        onClick={() => handleProcess(f)}
                        title={f.hasTranscript ? 'Process this video' : 'No matching CSV found'}
                      >
                        Process
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {tab === 'jobs' && (
        <section>
          {jobs.length === 0 ? (
            <div className="empty">No jobs yet. Go to RAW Files and click Process.</div>
          ) : (
            <div className="job-list">
              {jobs.map(j => <JobRow key={j.id} job={j} />)}
            </div>
          )}
        </section>
      )}

      {tab === 'processed' && (
        <section>
          {processed.length === 0 ? (
            <div className="empty">No processed clips yet.</div>
          ) : (
            <table>
              <thead>
                <tr><th>Clip</th></tr>
              </thead>
              <tbody>
                {processed.map(c => (
                  <tr key={c}><td>{c.replace('SAT/PROCESSED/', '')}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}
