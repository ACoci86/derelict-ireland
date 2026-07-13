// One-time converter: Westmeath County Council publishes its register as a wide
// PDF table (no coordinates, no owner column). We read word positions
// (pdftotext -bbox-layout), assign each word to a column by its x position and to
// a record by the nearest "DS File No" at or above it, then stitch the cells. We
// keep ref + address + town + entry date (S8(7) notice) + market value; the
// intermediate notice columns and district are dropped. Sites have no
// coordinates, so geocode.ts places them from the address later.
// Re-run when the register changes:  npx tsx pipeline/manual/westmeath_convert.ts
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const PDF_URL = "https://www.westmeathcoco.ie/en/media/CopyOfCountyDerelictSitesRegisterAsAt110626.pdf";
const PDF_TMP = "data/manual/westmeath.pdf";
const CSV_OUT = "data/manual/westmeath.csv";
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

const colOf = (xf: number): "ref" | "addr" | "town" | "date" | "val" | "skip" =>
  xf < 0.16 ? "ref"
  : xf < 0.41 ? "addr"
  : xf < 0.475 ? "town"
  : xf < 0.665 ? "skip"          // District, S8(2), S11 notice columns
  : xf < 0.74 ? "date"           // S8(7): entry onto register
  : xf < 0.86 ? "val"
  : "skip";

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

  // Each record is anchored by its file number (a bare integer in the ref column).
  const anchors = words.filter((w) => colOf(w.xf) === "ref" && /^\d+$/.test(w.t.trim()));
  const ays = anchors.map((a) => a.y);

  // Drop the column-header rows (above the first file number on each page).
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
  const recs = anchors.map(() => ({ addr: [] as Cell, town: [] as Cell, date: [] as Cell, val: [] as Cell }));
  for (const w of kept) {
    const c = colOf(w.xf);
    if (c === "skip" || c === "ref") continue;
    // Content sits on the file-number line or wraps below it.
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
    const ref = anchors[i].t.trim();
    const town = join(r.town);
    let address = join(r.addr) || town;
    if (town && !new RegExp(`\\b${town.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(address)) address += `, ${town}`;
    if (!/\bwestmeath\b/i.test(address)) address += ", Co. Westmeath";
    out.push([ref, address, eircode(address), iso(join(r.date)), money(join(r.val))]);
  }

  const header = "ref,address,eircode,date_entered,valuation";
  const lines = out.map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(","));
  writeFileSync(CSV_OUT, [header, ...lines].join("\n") + "\n");
  console.log(`wrote ${out.length} rows to ${CSV_OUT}`);
}

main();
