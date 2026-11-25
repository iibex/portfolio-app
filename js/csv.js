// Small, dependency-free CSV helpers used by the broker importers.

/** Parse CSV text into an array of rows (arrays of strings). Detects , ; or tab. */
export function parseCSV(text) {
  text = text.replace(/^﻿/, ''); // strip BOM
  const delimiter = detectDelimiter(text);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delimiter) {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (const c of firstLine) {
    if (c === '"') inQuotes = !inQuotes;
    else if (!inQuotes && c in counts) counts[c]++;
  }
  const [best, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return count > 0 ? best : ',';
}

/** Parse numbers written as 1234.56, 1.234,56, 1,234.56, "-12,5", "€ 10" ... */
export function parseNum(value) {
  if (value == null) return null;
  let s = String(value).trim().replace(/[€$£\s ]/g, '');
  if (s === '' || s === '-') return null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot !== -1 && lastComma !== -1) {
    // the separator that appears last is the decimal separator
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma !== -1) {
    s = s.replace(',', '.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Parse a date (+ optional time) into a sortable local ISO string 'YYYY-MM-DDTHH:MM:SS'. */
export function parseDate(dateStr, timeStr = '') {
  if (!dateStr) return null;
  let d = String(dateStr).trim();
  let t = String(timeStr || '').trim();
  // date and time in one field, e.g. "2024-01-15 12:30:00" or "2024-01-15T12:30:00Z"
  const combo = d.match(/^(\S+)[ T](\d{1,2}:\d{2}(?::\d{2})?)/);
  if (combo) { d = combo[1]; t = t || combo[2]; }

  let y, m, day;
  let mm;
  if ((mm = d.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) [, y, m, day] = mm;
  else if ((mm = d.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/))) [, day, m, y] = mm;
  else {
    const parsed = new Date(d);
    if (Number.isNaN(parsed.getTime())) return null;
    y = parsed.getFullYear(); m = parsed.getMonth() + 1; day = parsed.getDate();
  }
  const tm = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  const pad = (n) => String(n).padStart(2, '0');
  const time = tm ? `${pad(tm[1])}:${tm[2]}:${pad(tm[3] || 0)}` : '00:00:00';
  return `${y}-${pad(m)}-${pad(day)}T${time}`;
}

/** Normalise a header name for matching. */
export const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Find the column index for the first alias that matches (exact first, then "starts with"). */
export function col(headers, ...aliases) {
  const h = headers.map(norm);
  for (const a of aliases) {
    const i = h.indexOf(a);
    if (i !== -1) return i;
  }
  for (const a of aliases) {
    const i = h.findIndex((x) => x && x.startsWith(a));
    if (i !== -1) return i;
  }
  return -1;
}

/** Stable short hash (FNV-1a) used for de-duplicating imported rows. */
export function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
