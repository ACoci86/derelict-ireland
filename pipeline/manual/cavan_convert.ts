// One-time converter: Cavan County Council published its register online for
// the first time in September 2026 (it was inspection-only before), as a PDF
// table that carries ITM (EPSG:2157) X/Y coordinates, so no geocoding is
// needed. There are no street addresses (only townland and municipal
// district) and no valuations. Re-run when the register changes:
//   npx tsx pipeline/manual/cavan_convert.ts
//
// Two quirks of this PDF:
// - Every word is drawn twice, a fraction of a point apart, so words are
//   de-duplicated before anything else.
// - "Date Placed on Register" mixes formats: the older rows are m/d/yyyy
//   (10/23/2019), the newer ones d/m/yyyy (19/02/2026), and most values are
//   ambiguous (9/12/2019). The register is in roughly date order, so an
//   ambiguous date takes the format of the nearest unambiguous row around it.
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const PDF_URL = "https://www.cavancoco.ie/media/hleizcvd/derelict-sites-register-sept-2026.pdf";
const PDF_TMP = "data/manual/cavan.pdf";
const CSV_OUT = "data/manual/cavan.csv";
const REGISTER_DATE = "2026-09-30"; // the register is dated September 2026
const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";

interface Word { page: number; xf: number; y: number; t: string }
type Col = "count" | "ref" | "desc" | "town" | "district" | "date" | "x" | "y" | "eir";

// Column boundaries as fractions of the page width (from the header row).
const colOf = (xf: number): Col =>
  xf < 0.104 ? "count"
  : xf < 0.175 ? "ref"
  : xf < 0.268 ? "desc"
  : xf < 0.423 ? "town"
  : xf < 0.535 ? "district"
  : xf < 0.68 ? "date"
  : xf < 0.78 ? "x"
  : xf < 0.87 ? "y"
  : "eir";

const unesc = (s: string): string =>
  s.replace(/&amp;/g, "&").replace(/&apos;/g, "'").replace(/&#0?39;/g, "'").replace(/&quot;/g, '"');
// First Eircode in the cell (one entry lists several units: "H14 KP57, H14 W265, …").
function eircode(s: string): string {
  const m = (s ?? "").toUpperCase().match(/\b([A-Z]\d{2})\s?([A-Z0-9]{4})\b/);
  return m ? `${m[1]} ${m[2]}` : "";
}

// Where a two-line description is centred across a row boundary, the generic
// wrap rule below can't tell which row a word belongs to. Read from the PDF.
const DESCRIPTION_FIXES: Record<string, string> = {
  DS24104: "Agricultural/shed",
  DS24105: "Old Methodist Church",
};
// DS23155 is one entry for eight units, with eight Eircodes over four lines;
// keep the first, as for every other entry.
const EIRCODE_FIXES: Record<string, string> = { DS23155: "H14 RT63" };

type Fmt = "md" | "dm";
function parts(d: string): [number, number, number] | null {
  const m = d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? [+m[1], +m[2], +m[3]] : null;
}
function formatOf(d: string): Fmt | null {
  const p = parts(d);
  if (!p) return null;
  if (p[0] > 12) return "dm";
  if (p[1] > 12) return "md";
  return null; // ambiguous
}
function iso(d: string, fmt: Fmt): string {
  const p = parts(d);
  if (!p) return "";
  const [month, day] = fmt === "md" ? [p[0], p[1]] : [p[1], p[0]];
  if (month < 1 || month > 12 || day < 1 || day > 31) return "";
  return `${p[2]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

async function main() {
  const buf = Buffer.from(await (await fetch(PDF_URL, { headers: { "User-Agent": UA } })).arrayBuffer());
  writeFileSync(PDF_TMP, buf);
  const xml = execSync(`pdftotext -bbox-layout "${PDF_TMP}" -`, { encoding: "utf8", maxBuffer: 1 << 26 });

  // Read every word with its page, column and line, dropping the duplicates.
  const words: Word[] = [];
  const pageRe = /<page width="([\d.]+)"[^>]*>([\s\S]*?)<\/page>/g;
  let pm: RegExpExecArray | null;
  let page = 0;
  while ((pm = pageRe.exec(xml))) {
    const pw = parseFloat(pm[1]);
    const wordRe = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="[\d.]+" yMax="[\d.]+">([^<]*)<\/word>/g;
    let wm: RegExpExecArray | null;
    while ((wm = wordRe.exec(pm[2]))) {
      const w = { page, xf: +wm[1] / pw, y: +wm[2], t: unesc(wm[3]) };
      const dup = words.some((o) => o.page === w.page && o.t === w.t && Math.abs(o.xf - w.xf) < 0.002 && Math.abs(o.y - w.y) < 1.5);
      if (!dup) words.push(w);
    }
    page++;
  }

  // One record per X coordinate; every other cell joins the record whose
  // anchor line is closest on the same page.
  const anchors = words.filter((w) => colOf(w.xf) === "x" && /^\d{6}(\.\d+)?$/.test(w.t));
  const recs = anchors.map((a) => ({ a, cells: {} as Record<Col, Word[]> }));
  for (const w of words) {
    const c = colOf(w.xf);
    if (c === "x" && !anchors.includes(w)) continue;
    let best = -1;
    let bd = Infinity;
    for (let k = 0; k < recs.length; k++) {
      const a = recs[k].a;
      if (a.page !== w.page) continue;
      const d = Math.abs(a.y - w.y);
      if (d < bd) { bd = d; best = k; }
    }
    if (best < 0 || bd > 7) continue; // header, footer and notes
    (recs[best].cells[c] ??= []).push(w);
  }
  const text = (ws?: Word[]) => (ws ?? []).sort((a, b) => a.y - b.y || a.xf - b.xf).map((w) => w.t).join(" ").replace(/\s+/g, " ").trim();

  const rows = recs.map((r) => ({
    count: Number(text(r.cells.count)) || 0,
    ref: (text(r.cells.ref).match(/DS\d{5}/) ?? [""])[0],
    desc: text(r.cells.desc),
    town: text(r.cells.town),
    district: text(r.cells.district).replace(/\s*-\s*|(?<=Cavan)\s+(?=Belturbet)/g, " - "),
    dateRaw: (text(r.cells.date).match(/\d{1,2}\/\d{1,2}\/\d{4}/) ?? [""])[0],
    x: text(r.cells.x),
    y: (text(r.cells.y).match(/\d{6}(\.\d+)?/) ?? [""])[0],
    eir: eircode(text(r.cells.eir)),
  }));
  rows.sort((a, b) => a.count - b.count);

  // Descriptions wrap across rows: a lowercase first word ("shed") belongs to
  // the row above.
  for (let i = 1; i < rows.length; i++) {
    const m = rows[i].desc.match(/^([a-z][\w/&-]*)\s*(.*)$/);
    if (m) {
      rows[i - 1].desc = `${rows[i - 1].desc} ${m[1]}`.trim();
      rows[i].desc = m[2];
    }
  }

  for (const r of rows) if (DESCRIPTION_FIXES[r.ref]) r.desc = DESCRIPTION_FIXES[r.ref];
  for (const r of rows) if (EIRCODE_FIXES[r.ref]) r.eir = EIRCODE_FIXES[r.ref];

  // Resolve date formats from the nearest unambiguous neighbours in register order.
  const fmts = rows.map((r) => formatOf(r.dateRaw));
  let inferred = 0;
  const dates = rows.map((r, i) => {
    let f = fmts[i];
    if (!f) {
      for (let d = 1; d < rows.length && !f; d++) f = fmts[i - d] ?? fmts[i + d] ?? null;
      inferred++;
    }
    const v = iso(r.dateRaw, f ?? "dm");
    return v && v <= REGISTER_DATE ? v : "";
  });

  const header = "ref,townland,district,description,date_entered,date_as_printed,eircode,itm_x,itm_y";
  const q = (v: string) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = rows.map((r, i) => [r.ref, r.town, r.district, r.desc, dates[i], r.dateRaw, r.eir, r.x, r.y].map(q).join(","));
  writeFileSync(CSV_OUT, [header, ...lines].join("\n") + "\n");

  const refs = new Set(rows.map((r) => r.ref).filter(Boolean));
  console.log(
    `wrote ${rows.length} rows to ${CSV_OUT}: ${refs.size} distinct refs, ` +
      `${rows.filter((r) => r.x && r.y).length} with coordinates, ${dates.filter(Boolean).length} dated ` +
      `(${inferred} date formats inferred from neighbouring rows)`,
  );
}

main();
