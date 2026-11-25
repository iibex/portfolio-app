// Minimal .xlsx reader (no libraries): unzips with the browser's built-in DecompressionStream
// (iOS Safari 16.4+) and reads the first worksheet into rows of strings, like parseCSV.

/** @param {ArrayBuffer|Uint8Array} buffer @returns {Promise<string[][]>} */
export async function readXlsx(buffer) {
  const files = await unzip(new Uint8Array(buffer));
  const text = (name) => (files[name] ? new TextDecoder().decode(files[name]) : '');

  const shared = [...text('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    [...m[1].replace(/<rPh[\s\S]*?<\/rPh>/g, '').matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decode(t[1])).join(''));

  const sheetXml = text(firstSheetPath(text('xl/workbook.xml'), text('xl/_rels/workbook.xml.rels'), files));
  if (!sheetXml) throw new Error('No worksheet found in this Excel file.');

  const rows = [];
  for (const rowMatch of sheetXml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowNum = Number(attr(rowMatch[1], 'r')) || rows.length + 1;
    const row = [];
    for (const c of rowMatch[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(c[1], 'r');
      const type = attr(c[1], 't');
      const body = c[2] || '';
      let value = '';
      if (type === 'inlineStr') value = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decode(t[1])).join('');
      else {
        const v = body.match(/<v>([\s\S]*?)<\/v>/);
        value = v ? decode(v[1]) : '';
        if (type === 's') value = shared[Number(value)] ?? '';
      }
      const colIdx = ref ? colIndex(ref) : row.length;
      row[colIdx] = value;
    }
    for (let i = 0; i < row.length; i++) row[i] ??= '';
    rows[rowNum - 1] = row;
  }
  for (let i = 0; i < rows.length; i++) rows[i] ??= [];
  return rows;
}

/** Excel date serial (days since 1899-12-30) → 'YYYY-MM-DDTHH:MM:SS'. */
export function excelDate(serial) {
  const n = Number(serial);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(Math.round((n - 25569) * 86400) * 1000);
  return d.toISOString().slice(0, 19);
}

function firstSheetPath(workbook, rels, files) {
  const rid = workbook.match(/<sheet\b[^>]*\br:id="([^"]+)"/)?.[1];
  const target = rid && [...rels.matchAll(/<Relationship\b([^>]*)\/?>/g)]
    .map((m) => m[1]).find((a) => attr(a, 'Id') === rid);
  if (target) {
    const t = attr(target, 'Target').replace(/^\//, '');
    const path = t.startsWith('xl/') ? t : `xl/${t}`;
    if (files[path]) return path;
  }
  return Object.keys(files).filter((f) => /^xl\/worksheets\/[^/]+\.xml$/.test(f)).sort()[0];
}

const attr = (attrs, name) => attrs.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? '';

function colIndex(ref) {
  const letters = ref.match(/^[A-Z]+/)[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function decode(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// ---------------------------------------------------------------- zip
async function unzip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This is not a valid .xlsx file.');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const files = {};
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!name.endsWith('.xml') && !name.endsWith('.rels')) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    if (method === 0) files[name] = data;
    else if (method === 8) files[name] = await inflateRaw(data);
  }
  return files;
}

async function inflateRaw(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
