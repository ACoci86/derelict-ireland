// One-time converter: Laois County Council publishes its register as a wide PDF
// table that already carries ITM (EPSG:2157) X/Y coordinates, so no geocoding is
// needed. Records wrap over a couple of lines, so we read word positions
// (pdftotext -bbox-layout), assign each word to a column by its x position and
// to a record by the nearest date-entered value, then stitch the cells. There is
// no owner column. We keep ref + town + location + eircode + date + valuation +
// x/y. Re-run when the register changes:  npx tsx pipeline/manual/laois_convert.ts
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const PDF_URL =
  "https://laois.ie/sites/default/files/2026-07/" +
  "Derelict%20Site%20Register%20updated%20July%202026_1.pdf";
const PDF_TMP = "data/manual/laois.pdf";
const CSV_OUT = "data/manual/laois.csv";
const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";

interface Word { x0: number; y: number; xf: number; t: string }

function iso(d: string): string {
  const m = (d ?? "").match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : "";
}
const unesc = (s: string): string =>
  s.replace(/&amp;/g, "&").replace(/&apos;/g, "'").replace(/&#0?39;/g, "'").replace(/&#8217;/g, "’").replace(/&quot;/g, '"');
function eircode(s: string): string {
  const m = (s ?? "").toUpperCase().match(/\b([A-Z]\d{2})\s?([A-Z0-9]{4})\b/);
  return m ? `${m[1]} ${m[2]}` : "";
}
function money(s: string): string {
  const n = Number(String(s ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? String(Math.round(n)) : "";
}
// First ITM-looking coordinate number (5-7 digit, optional decimals) in a cell.
function coord(s: string): string {
  const m = (s ?? "").match(/\d{5,7}(?:\.\d+)?/);
  return m ? m[0] : "";
}

const colOf = (xf: number): "ref" | "town" | "loc" | "eir" | "x" | "y" | "date" | "val" | "skip" =>
  xf < 0.09 ? "ref"
  : xf < 0.14 ? "skip"          // Folio
  : xf < 0.205 ? "town"
  : xf < 0.435 ? "loc"
  : xf < 0.505 ? "eir"
  : xf < 0.585 ? "x"
  : xf < 0.665 ? "y"
  : xf < 0.73 ? "date"
  : xf < 0.80 ? "val"
  : "skip";                      // LA intended use, Action taken

async function main() {
  const buf = Buffer.from(await (await fetch(PDF_URL, { headers: { "User-Agent": UA } })).arrayBuffer());
  writeFileSync(PDF_TMP, buf);
  const xml = execSync(`pdftotext -bbox-layout "${PDF_TMP}" -`, { encoding: "utf8", maxBuffer: 1 << 26 });

  const words: Word[] = [];
  const pageRe = /<page width="([\d.]+)"[^>]*>([\s\S]*?)<\/page>/g;
  let pm: RegExpExecArray | null;
  let page = 0;
  while ((pm = pageRe.exec(xml))) {
    const pw = parseFloat(pm[1]);
    const yoff = page * 100000;
    const wordRe = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g;
    let wm: RegExpExecArray | null;
    while ((wm = wordRe.exec(pm[2]))) {
      words.push({ x0: +wm[1], y: +wm[2] + yoff, xf: +wm[1] / pw, t: wm[5] });
    }
    page++;
  }

  // Each record is anchored by its "Date entered" value (one dd/mm/yyyy per row,
  // always on the main line). Content wraps below it.
  const DATE = /^\d{2}\/\d{2}\/\d{4}$/;
  const anchors = words.filter((w) => colOf(w.xf) === "date" && DATE.test(w.t.trim()));
  const ays = anchors.map((a) => a.y);

  // Drop the column-header row (above the first date on each page).
  const pageMin = new Map<number, number>();
  for (const a of anchors) {
    const pg = Math.floor(a.y / 100000);
    pageMin.set(pg, Math.min(pageMin.get(pg) ?? Infinity, a.y));
  }
  const kept = words.filter((w) => {
    const m = pageMin.get(Math.floor(w.y / 100000));
    return m !== undefined && w.y >= m - 6;
  });

  type Cell = Word[];
  const recs = anchors.map(() => ({ ref: [] as Cell, town: [] as Cell, loc: [] as Cell, eir: [] as Cell, x: [] as Cell, y: [] as Cell, val: [] as Cell }));
  for (const w of kept) {
    const c = colOf(w.xf);
    if (c === "skip" || c === "date") continue;
    // Assign to the nearest date at or above the word (content is on the date
    // line or wraps below it).
    let j = -1, best = Infinity;
    for (let k = 0; k < ays.length; k++) {
      const d = w.y - ays[k];
      if (d >= -6 && d < best) { best = d; j = k; }
    }
    if (j < 0) {
      best = Infinity;
      for (let k = 0; k < ays.length; k++) { const d = Math.abs(ays[k] - w.y); if (d < best) { best = d; j = k; } }
    }
    (recs[j] as any)[c].push(w);
  }

  const order = (p: Cell) => [...p].sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const join = (p: Cell) => unesc(order(p).map((w) => w.t).join(" ")).replace(/\s+/g, " ").replace(/ ,/g, ",").trim();

  const out: string[][] = [];
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    const refM = join(r.ref).match(/\d+\/\d+/);
    const ref = refM ? refM[0] : join(r.ref).split(" ")[0];
    const town = join(r.town);
    const loc = join(r.loc);
    // Build a display address from location + town, avoiding duplication.
    let address = loc || town;
    if (town && !new RegExp(`\\b${town.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(address)) address += `, ${town}`;
    if (!/\blaois\b/i.test(address)) address += ", Co. Laois";
    out.push([ref, address, eircode(join(r.eir)), iso(anchors[i].t.trim()), money(join(r.val)), coord(join(r.x)), coord(join(r.y))]);
  }

  const header = "ref,address,eircode,date_entered,valuation,itm_x,itm_y";
  const lines = out.map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(","));
  writeFileSync(CSV_OUT, [header, ...lines].join("\n") + "\n");
  const withXY = out.filter((r) => r[5] && r[6]).length;
  console.log(`wrote ${out.length} rows to ${CSV_OUT} (${withXY} with coordinates)`);
}

main();
