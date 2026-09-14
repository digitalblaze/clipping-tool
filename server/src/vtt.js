/**
 * Minimal WebVTT parser for the transcript viewer.
 *
 * Zoom writes cue text as "*Teacher Steve C*: ..." and uses CRLF line endings,
 * so both are handled here rather than in the UI.
 */
function parseVtt(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const cues = [];

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(
      /^\s*((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{3})\s*-->\s*((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{3})/);
    if (!m) continue;

    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j].trim() || lines[j].includes('-->')) break;
      body.push(lines[j].trim());
    }

    const joined = body.join(' ');
    const speaker = joined.match(/^\*([^*]+)\*:\s*(.*)$/);

    cues.push({
      startMs: toMs(m[1]),
      endMs: toMs(m[2]),
      speaker: speaker ? speaker[1].trim() : '',
      text: speaker ? speaker[2] : joined,
    });
  }
  return cues;
}

function toMs(stamp) {
  const parts = stamp.replace(',', '.').split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  return Math.round((parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000);
}

module.exports = { parseVtt };
