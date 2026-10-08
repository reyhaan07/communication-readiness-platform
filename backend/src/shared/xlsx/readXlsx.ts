/**
 * Minimal .xlsx reader: every sheet's cell values as text, by sheet name.
 * An .xlsx is a zip of XML parts; this reads the workbook, its relationships, the
 * shared strings and each worksheet. It accepts namespace-prefixed XML (<x:c>, as
 * written by .NET tools) as well as the default namespace, and shared, inline and
 * formula-cached string cells. Formatting, formulas and dates are not interpreted.
 */
import JSZip from 'jszip';

export type SheetRows = string[][];

const ATTR = (attrs: string, name: string): string | undefined =>
  new RegExp(`(?:^|\\s)(?:\\w+:)?${name}="([^"]*)"`).exec(attrs)?.[1];

function decode(xml: string): string {
  return xml
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// All <t> runs inside a fragment (a shared string or an inline string), joined
function texts(fragment: string): string {
  const out: string[] = [];
  const re = /<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g;
  for (let m = re.exec(fragment); m; m = re.exec(fragment)) out.push(decode(m[1]));
  return out.join('');
}

function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/i.exec(ref)?.[0].toUpperCase() ?? 'A';
  return [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
}

export async function readXlsx(data: Buffer): Promise<Map<string, SheetRows>> {
  const zip = await JSZip.loadAsync(data);
  const part = async (name: string) => (await zip.file(name)?.async('string')) ?? '';

  const rels = new Map<string, string>();
  const relXml = await part('xl/_rels/workbook.xml.rels');
  for (const m of relXml.matchAll(/<(?:\w+:)?Relationship\b([^>]*?)\/?>/g)) {
    const id = ATTR(m[1], 'Id');
    let target = ATTR(m[1], 'Target') ?? '';
    if (!id || !target) continue;
    target = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    rels.set(id, target.replace(/^xl\/xl\//, 'xl/'));
  }

  const shared: string[] = [];
  const ssXml = await part('xl/sharedStrings.xml');
  for (const m of ssXml.matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g)) shared.push(texts(m[1]));

  const sheets = new Map<string, SheetRows>();
  const wbXml = await part('xl/workbook.xml');
  for (const m of wbXml.matchAll(/<(?:\w+:)?sheet\b([^>]*?)\/?>/g)) {
    const name = decode(ATTR(m[1], 'name') ?? '');
    const target = rels.get(ATTR(m[1], 'id') ?? '');
    if (!name || !target) continue;
    const xml = await part(target);
    const rows: SheetRows = [];
    for (const r of xml.matchAll(/<(?:\w+:)?row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
      const row: string[] = [];
      for (const c of r[1].matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
        const attrs = c[1];
        const body = c[2] ?? '';
        const type = ATTR(attrs, 't');
        const raw = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/.exec(body)?.[1];
        let value = '';
        if (type === 's') value = shared[Number(raw)] ?? '';
        else if (type === 'inlineStr') value = texts(body);
        else if (raw !== undefined) value = decode(raw);
        row[columnIndex(ATTR(attrs, 'r') ?? 'A')] = value;
      }
      rows.push(Array.from(row, (v) => v ?? ''));
    }
    sheets.set(name, rows);
  }
  return sheets;
}
