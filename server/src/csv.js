const { parse } = require('csv-parse/sync');

// Parses a CSV transcript file into an array of clip definitions.
// Expected columns (flexible header matching):
//   start, end, caption  — or any variation like start_time/end_time
function parseTranscript(csvText) {
  const records = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  return records.map((row, i) => {
    const keys = Object.keys(row).map(k => k.toLowerCase().trim());
    const startKey = Object.keys(row).find(k => /start/i.test(k));
    const endKey = Object.keys(row).find(k => /end/i.test(k));
    const captionKey = Object.keys(row).find(k => /caption|text|label|title/i.test(k));

    if (!startKey || !endKey) {
      throw new Error(`Row ${i + 1}: cannot find start/end columns. Got: ${Object.keys(row).join(', ')}`);
    }

    return {
      index: i + 1,
      start: row[startKey].trim(),
      end: row[endKey].trim(),
      caption: captionKey ? row[captionKey].trim() : `clip_${i + 1}`,
    };
  });
}

// Converts HH:MM:SS or MM:SS or raw seconds to seconds (float)
function toSeconds(ts) {
  if (!isNaN(ts)) return parseFloat(ts);
  const parts = String(ts).split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  throw new Error(`Unrecognized timestamp format: ${ts}`);
}

module.exports = { parseTranscript, toSeconds };
