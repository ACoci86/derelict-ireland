// One-time converter: Carlow County Council publishes its register as a PDF
// table (no coordinates, no owner column). We read word positions
// (pdftotext -bbox-layout), assign each word to a column by its x position and to
// a record by the nearest "DS" reference, then stitch the cells. Records wrap in
// both directions (address above the ref line, notice dates below it). We keep
// ref + electoral area + address + entry date (Section 8(7)) + valuation.
// Re-run when the register changes:  npx tsx pipeline/manual/carlow_convert.ts
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const PDF_URL = "https://carlow.ie/media/1863/download?inline";
const PDF_TMP = "data/manual/carlow.pdf";
const CSV_OUT = "data/manual/carlow.csv";
const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";

interface Word { x0: number; y: number; xf: number; t: string }

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
// "18-Nov-15" / "29-Sept-20" -> ISO.
function iso(d: string): string {
  const m = (d ?? "").match(/(\d{1,2})-([A-Za-z]+)-(\d{2,4})/);
  if (!m) return "";
  const mo = MONTHS[m[2].toLowerCase().slice(0, 3)];
  if (!mo) return "";
  const yr = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return `${yr}-${String(mo).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
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

const colOf = (xf: number): "ref" | "elec" | "addr" | "date" | "val" | "skip" =>
  xf < 0.11 ? "ref"
  : xf < 0.20 ? "elec"
  : xf < 0.50 ? "addr"
  : xf < 0.585 ? "skip"          // Section 8(2)
  : xf < 0.66 ? "date"           // Section 8(7): entry onto register
  : xf < 0.805 ? "skip"          // Section 11 + Section 22
  : "val";

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

  const anchors = words.filter((w) => /^DS\d+/.test(w.t.trim()) && w.xf < 0.11);
  const ays = anchors.map((a) => a.y);

  // Drop the column-header rows (above the first reference on each page).
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
  const recs = anchors.map(() => ({ elec: [] as Cell, addr: [] as Cell, date: [] as Cell, val: [] as Cell }));
  for (const w of kept) {
    const c = colOf(w.xf);
    if (c === "skip" || c === "ref") continue;
    // Content wraps both ways around the ref line, so use nearest anchor.
    let j = 0, best = Infinity;
    for (let k = 0; k < ays.length; k++) {
      const d = Math.abs(ays[k] - w.y);
      if (d < best) { best = d; j = k; }
    }
    (recs[j] as any)[c].push(w);
  }

  const order = (p: Cell) => [...p].sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const join = (p: Cell) => unesc(order(p).map((w) => w.t).join(" ")).replace(/\s+/g, " ").replace(/ ,/g, ",").trim();

  const out: string[][] = [];
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    const ref = anchors[i].t.trim();
    const elec = join(r.elec);
    let address = join(r.addr) || elec;
    if (elec && !new RegExp(`\\b${elec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(address)) address += `, ${elec}`;
    if (!/\bcarlow\b/i.test(address)) address += ", Co. Carlow";
    out.push([ref, address, eircode(address), iso(join(r.date)), money(join(r.val))]);
  }

  const header = "ref,address,eircode,date_entered,valuation";
  const lines = out.map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(","));
  writeFileSync(CSV_OUT, [header, ...lines].join("\n") + "\n");
  console.log(`wrote ${out.length} rows to ${CSV_OUT}`);
}

main();
