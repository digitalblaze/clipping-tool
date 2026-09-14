import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { fetchRows, fetchAssets, startJob } from './api';
import './App.css';

/* ------------------------------------------------------------------ *
 * Status vocabulary is owned by the Apps Script pipeline on the sheet.
 * Anything unrecognised falls through to a neutral pill.
 * ------------------------------------------------------------------ */
const STATUS_KIND = [
  [/^Published/, 'done'],
  [/^Clips: done/, 'done'],
  [/^Clips: error/, 'error'],
  [/^Clips/, 'busy'],
  [/^Moments Found/, 'ready'],
  [/^Assets Ready/, 'ready'],
  [/^Error/, 'error'],
  [/^Waiting|^Pulling|^Finding/, 'busy'],
];
const statusKind = s => (STATUS_KIND.find(([re]) => re.test(String(s)))?.[1]) || 'idle';

const fmtClock = ms => {
  if (!Number.isFinite(ms)) return '—';
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600);
  const m = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
  const s = String(t % 60).padStart(2, '0');
  return h ? `${h}:${m}:${s}` : `${m}:${s}`;
};
const fmtMB = b => `${(b / 1048576).toFixed(1)} MB`;

function Pill({ status }) {
  return <span className={`pill pill-${statusKind(status)}`}>{status || 'No status'}</span>;
}

/* ------------------------------------------------------------------ *
 * Clip repository
 * ------------------------------------------------------------------ */
function ClipCard({ clip, index, onJumpToSource }) {
  const m = clip.moment;
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(clip.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <article className="clip-card">
      <div className="clip-video">
        <video src={clip.url} controls preload="metadata" playsInline />
        <span className="clip-rank">{index + 1}</span>
      </div>

      <div className="clip-body">
        <h3>{m?.title || clip.name}</h3>
        {m?.hook && <p className="clip-hook">“{m.hook}”</p>}

        <dl className="clip-meta">
          <div><dt>Length</dt><dd>{m ? `${Math.round((m.endMs - m.startMs) / 1000)}s` : '—'}</dd></div>
          <div><dt>Source range</dt><dd>{m ? `${m.startTimecode} → ${m.endTimecode}` : '—'}</dd></div>
          <div><dt>File</dt><dd>{fmtMB(clip.bytes)}</dd></div>
        </dl>

        {m?.whyItWorks && <p className="clip-why"><strong>Why it works.</strong> {m.whyItWorks}</p>}

        <div className="clip-actions">
          {m && (
            <button onClick={() => onJumpToSource(m.startMs)}>
              Find in recording
            </button>
          )}
          <a href={clip.url} target="_blank" rel="noreferrer">Open</a>
          <button onClick={copy}>{copied ? 'Link copied' : 'Copy link'}</button>
        </div>
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------ *
 * Transcript, with the clipped ranges called out inline
 * ------------------------------------------------------------------ */
function Transcript({ cues, moments, onSeek }) {
  const [query, setQuery] = useState('');

  const momentOf = useCallback(ms => {
    const i = moments.findIndex(m => ms >= m.startMs && ms < m.endMs);
    return i === -1 ? null : i;
  }, [moments]);

  const filtered = useMemo(() => {
    if (!query.trim()) return cues;
    const q = query.toLowerCase();
    return cues.filter(c => c.text.toLowerCase().includes(q));
  }, [cues, query]);

  return (
    <div className="transcript">
      <div className="transcript-bar">
        <input
          type="search"
          placeholder="Search the transcript…"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        <span className="transcript-count">
          {filtered.length === cues.length
            ? `${cues.length} lines`
            : `${filtered.length} of ${cues.length} lines`}
        </span>
      </div>

      <ol className="cue-list">
        {filtered.map((c, i) => {
          const mi = momentOf(c.startMs);
          return (
            <li key={`${c.startMs}-${i}`} className={mi !== null ? `cue in-clip clip-${mi + 1}` : 'cue'}>
              <button className="cue-time" onClick={() => onSeek(c.startMs)} title="Play from here">
                {fmtClock(c.startMs)}
              </button>
              <p>
                {mi !== null && <span className="cue-tag">Clip {mi + 1}</span>}
                {c.text}
              </p>
            </li>
          );
        })}
      </ol>
      {!filtered.length && <p className="empty">No lines match “{query}”.</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Full recording, with the clipped moments marked on the timeline
 * ------------------------------------------------------------------ */
function SourcePlayer({ source, moments, duration, videoRef }) {
  if (!source) {
    return (
      <p className="empty">
        The full recording has not been uploaded for this class yet. Clips and
        transcript are unaffected.
      </p>
    );
  }

  const totalMs = moments.length
    ? Math.max(...moments.map(m => m.endMs)) * 1.02
    : 0;

  return (
    <div className="source">
      <video ref={videoRef} src={source.url} controls preload="metadata" playsInline />

      <div className="source-meta">
        <span>{fmtMB(source.bytes)}</span>
        <span>{duration || '—'}</span>
        <a href={source.url} target="_blank" rel="noreferrer">Open original</a>
      </div>

      {moments.length > 0 && (
        <>
          <p className="source-hint">Clipped moments — click to jump</p>
          <div className="timeline">
            {moments.map((m, i) => (
              <button
                key={m.rank ?? i}
                className={`marker clip-${i + 1}`}
                style={{ left: `${(m.startMs / (totalMs || 1)) * 100}%` }}
                title={`${m.startTimecode} — ${m.title}`}
                onClick={() => {
                  if (videoRef.current) {
                    videoRef.current.currentTime = m.startMs / 1000;
                    videoRef.current.play();
                  }
                }}
              >{i + 1}</button>
            ))}
          </div>
          <ul className="jump-list">
            {moments.map((m, i) => (
              <li key={m.rank ?? i}>
                <button onClick={() => {
                  if (videoRef.current) {
                    videoRef.current.currentTime = m.startMs / 1000;
                    videoRef.current.play();
                  }
                }}>
                  <span className={`dot clip-${i + 1}`} />
                  <code>{m.startTimecode}</code>
                  {m.title}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * App
 * ------------------------------------------------------------------ */
export default function App() {
  const [rows, setRows] = useState([]);
  const [selected, setSelected] = useState(null);
  const [assets, setAssets] = useState(null);
  const [tab, setTab] = useState('clips');
  const [loading, setLoading] = useState(true);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [error, setError] = useState(null);
  const videoRef = useRef(null);

  useEffect(() => {
    fetchRows()
      .then(({ rows }) => {
        setRows(rows);
        if (rows.length) setSelected(rows[0].rowNum);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (selected == null) return;
    setAssetsLoading(true);
    setAssets(null);
    fetchAssets(selected)
      .then(setAssets)
      .catch(e => setError(e.message))
      .finally(() => setAssetsLoading(false));
  }, [selected]);

  const jumpToSource = useCallback(ms => {
    setTab('recording');
    // Let the player mount before seeking into it.
    requestAnimationFrame(() => {
      if (videoRef.current) {
        videoRef.current.currentTime = ms / 1000;
        videoRef.current.play().catch(() => {});
      }
    });
  }, []);

  const run = async rowNum => {
    try {
      await startJob(rowNum);
      alert('Clip job started. The sheet will update as it runs.');
    } catch (e) {
      alert(`Could not start: ${e.message}`);
    }
  };

  const moments = assets?.row?.moments || [];
  const clipCount = assets?.clips?.length || 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">▶</span>
          <div>
            <h1>Clipping Tool</h1>
            <p>Class recordings → social-ready clips</p>
          </div>
        </div>
        <div className="topbar-meta">
          <span><strong>{rows.length}</strong> {rows.length === 1 ? 'class' : 'classes'}</span>
          <span><strong>{rows.filter(r => statusKind(r.status) === 'done').length}</strong> clipped</span>
        </div>
      </header>

      {error && <div className="banner error">{error}</div>}

      <div className="layout">
        <aside className="sidebar">
          <h2>Classes</h2>
          {loading && <p className="empty">Loading…</p>}
          {!loading && !rows.length && <p className="empty">No rows in the sheet yet.</p>}
          <ul className="row-list">
            {rows.map(r => (
              <li key={r.rowNum}>
                <button
                  className={r.rowNum === selected ? 'row-item active' : 'row-item'}
                  onClick={() => { setSelected(r.rowNum); setTab('clips'); }}
                >
                  <span className="row-title">{r.title || `Row ${r.rowNum}`}</span>
                  <span className="row-sub">{r.date || '—'} · {r.duration || '—'}</span>
                  <Pill status={r.status} />
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <main className="detail">
          {assetsLoading && <p className="empty">Loading clips, transcript, and recording…</p>}

          {assets && (
            <>
              <div className="detail-head">
                <div>
                  <h2>{assets.row.title}</h2>
                  <p className="detail-sub">
                    {assets.row.date} · {assets.row.duration} · Zoom {assets.row.meetingId}
                  </p>
                </div>
                <div className="detail-head-right">
                  <Pill status={assets.row.status} />
                  {statusKind(assets.row.status) === 'ready' && (
                    <button className="primary" onClick={() => run(assets.row.rowNum)}>
                      Run clip job
                    </button>
                  )}
                </div>
              </div>

              {assets.row.error && <div className="banner error">{assets.row.error}</div>}
              {assets.row.brightcove && (
                <div className="banner info">Brightcove: {assets.row.brightcove}</div>
              )}

              <nav className="tabs">
                {[
                  ['clips', `Clips (${clipCount})`],
                  ['transcript', `Transcript${assets.transcript ? ` (${assets.transcript.cues.length})` : ''}`],
                  ['recording', 'Full recording'],
                ].map(([id, label]) => (
                  <button
                    key={id}
                    className={tab === id ? 'tab active' : 'tab'}
                    onClick={() => setTab(id)}
                  >{label}</button>
                ))}
              </nav>

              {tab === 'clips' && (
                clipCount ? (
                  <div className="clip-grid">
                    {assets.clips.map((c, i) => (
                      <ClipCard key={c.key} clip={c} index={i} onJumpToSource={jumpToSource} />
                    ))}
                  </div>
                ) : (
                  <p className="empty">
                    No clips in S3 for this class yet. Moments are
                    {moments.length ? ` ready (${moments.length} found)` : ' not generated yet'}.
                  </p>
                )
              )}

              {tab === 'transcript' && (
                assets.transcript
                  ? <Transcript cues={assets.transcript.cues} moments={moments} onSeek={jumpToSource} />
                  : <p className="empty">No transcript uploaded for this class.</p>
              )}

              {tab === 'recording' && (
                <SourcePlayer
                  source={assets.source}
                  moments={moments}
                  duration={assets.row.duration}
                  videoRef={videoRef}
                />
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
