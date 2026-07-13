// One-time converter: Louth County Council publishes its register as a wide PDF
// table. It has NO owner column (just ref / address / actions / valuation /
// date), but records wrap inconsistently: an address may sit on the reference
// line or on the line below it. We read word positions (pdftotext -bbox-layout),
// assign each word to a column by its x position and to a record by the nearest
// reference at or above it (content wraps downward here), then stitch the cells.
// We keep ref + address + eircode + date + valuation.
// Re-run when the register changes:  npx tsx pipeline/manual/louth_convert.ts
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const PDF_URL = "https://www.louthcoco.ie/media/jtmhrz14/derelict-sites-register-updated-4-june-2026.pdf";
const PDF_TMP = "data/manual/louth.pdf";
const CSV_OUT = "data/manual/louth.csv";
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

// Column by left-edge fraction of page width (Ref <0.10, address 0.12-0.36,
// actions/not-applicable 0.36-0.77 dropped, valuation 0.77-0.85, date >=0.85).
const colOf = (xf: number): "addr" | "val" | "date" | "skip" =>
  xf >= 0.115 && xf < 0.36 ? "addr" : xf >= 0.77 && xf < 0.85 ? "val" : xf >= 0.85 ? "date" : "skip";

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

  // Each record is anchored by its reference. A ref is "DS <year> <seq>" (older
  // ones just "DS <n>"): all the ref-column tokens (x fraction < 0.10) on the
  // "DS" line, in order. The single-digit count column sits just right of them.
  const anchors: { y: number; page: number; ref: string }[] = [];
  for (const w of words) {
    if (w.t.trim() !== "DS" || w.xf > 0.06) continue;
    const ref = words
      .filter((o) => Math.abs(o.y - w.y) < 4 && o.xf < 0.10)
      .sort((a, b) => a.x0 - b.x0)
      .map((o) => o.t.trim())
      .join(" ").replace(/\s+/g, " ").trim();
    anchors.push({ y: w.y, page: Math.floor(w.y / 100000), ref });
  }

  // Drop the running header/title/subtitle. Two belt-and-braces filters: keep
  // only words at or below the first reference on each page, AND drop any line
  // carrying a word that appears only in the title/column header ("updated" for
  // the "updated <date>" subtitle, plus the column labels).
  const pageMin = new Map<number, number>();
  for (const a of anchors) pageMin.set(a.page, Math.min(pageMin.get(a.page) ?? Infinity, a.y));
  const TRIGGERS = new Set(["updated", "valuation", "Entered", "Actions", "REGISTER"]);
  const bands = words.filter((w) => TRIGGERS.has(w.t.trim())).map((w) => w.y);
  const kept = words.filter((w) => {
    const m = pageMin.get(Math.floor(w.y / 100000));
    if (m === undefined || w.y < m - 5) return false;
    return !bands.some((b) => Math.abs(w.y - b) < 6);
  });

  const recs = anchors.map((a) => ({ ref: a.ref, addr: [] as Word[], val: [] as Word[], date: [] as Word[] }));
  for (const w of kept) {
    const c = colOf(w.xf);
    if (c === "skip") continue;
    // Content sits on the reference line or the line below it, on the same page,
    // so assign to the nearest anchor at or above the word.
    const pg = Math.floor(w.y / 100000);
    let j = -1, best = Infinity;
    for (let k = 0; k < anchors.length; k++) {
      if (anchors[k].page !== pg) continue;
      const d = w.y - anchors[k].y;
      if (d >= -5 && d < best) { best = d; j = k; }
    }
    if (j >= 0) recs[j][c].push(w);
  }

  const order = (p: Word[]) => [...p].sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const join = (p: Word[]) => unesc(order(p).map((w) => w.t).join(" ")).replace(/\s+/g, " ").replace(/ ,/g, ",").trim();

  const out: string[][] = [];
  for (const r of recs) {
    // Strip any "Section 8 Notice ..." text that bled in from the actions column
    // where two columns rendered as one word (never part of a real address).
    const address = join(r.addr).replace(/\s*Section .*$/, "").replace(/Section$/, "").replace(/,+\s*$/, "").trim();
    if (!address) continue;
    out.push([r.ref, address, eircode(address), iso(join(r.date)), money(join(r.val))]);
  }

  const header = "ref,address,eircode,date_entered,valuation";
  const lines = out.map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(","));
  writeFileSync(CSV_OUT, [header, ...lines].join("\n") + "\n");
  console.log(`wrote ${out.length} rows to ${CSV_OUT}`);
}

main();
