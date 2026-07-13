// One-time converter: Wexford County Council publishes its register as a wide
// PDF table where each record's cells wrap over several lines and interleave,
// so a plain line reader is unreliable. We read word positions
// (pdftotext -bbox-layout), assign each word to a column by its x position and
// to a record by the nearest reference (DER...), then stitch the cells back.
//
// The table has an "Owner Name & Address" column (personal data) which we NEVER
// read: only the reference / location / date / valuation columns are kept, the
// same stance as the Offaly and Mayo adapters. Sites have no coordinates, so
// geocode.ts places them from the address later.
// Re-run when the register changes:  npx tsx pipeline/manual/wexford_convert.ts
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const PDF_URL =
  "https://www.wexfordcoco.ie/sites/default/files/content/Planning/" +
  "Derelict%20Site%20Register%20March%202026.pdf";
const PDF_TMP = "data/manual/wexford.pdf";
const CSV_OUT = "data/manual/wexford.csv";
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

// Column of a word by its left edge as a fraction of page width (from the
// header: Reference 0.07, Location 0.15-0.43, Owner 0.46-0.76, Date 0.78,
// Valuation 0.90). The owner band is deliberately dropped.
const colOf = (xf: number): "ref" | "loc" | "owner" | "date" | "val" =>
  xf < 0.15 ? "ref" : xf < 0.44 ? "loc" : xf < 0.76 ? "owner" : xf < 0.88 ? "date" : "val";

async function main() {
  const buf = Buffer.from(await (await fetch(PDF_URL, { headers: { "User-Agent": UA } })).arrayBuffer());
  writeFileSync(PDF_TMP, buf);
  const xml = execSync(`pdftotext -bbox-layout "${PDF_TMP}" -`, { encoding: "utf8", maxBuffer: 1 << 26 });

  // Words, with each page's y offset so records never bleed across page breaks.
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

  // Drop the running title/header lines (they repeat at the top of every page,
  // at slightly different heights, so exclude by content not position). These
  // three words appear only in the title/header, never in a data row.
  const TRIGGERS = new Set(["Reference", "Valuation", "Updated:"]);
  const bands = words.filter((w) => TRIGGERS.has(w.t.trim())).map((w) => w.y);
  const kept = words.filter((w) => !bands.some((b) => Math.abs(w.y - b) < 5));

  // References anchor the records; assign every other word to the nearest one.
  const REF = /^DER\d{4}-\d+/;
  const refs = kept.filter((w) => REF.test(w.t.trim()));
  const recs = refs.map((r) => ({ ref: r.t.trim(), loc: [] as Word[], date: [] as Word[], val: [] as Word[] }));
  const rys = refs.map((r) => r.y);
  const nearest = (y: number) => {
    let j = 0, best = Infinity;
    for (let k = 0; k < rys.length; k++) {
      const d = Math.abs(rys[k] - y);
      if (d < best) { best = d; j = k; }
    }
    return j;
  };
  for (const w of kept) {
    const c = colOf(w.xf);
    if (c === "owner" || c === "ref") continue;   // never read owner or the ref/row-number column
    let j: number;
    if (c === "loc") {
      // A record's address sits ON or just ABOVE its reference line (long ones
      // wrap upward), so assign an address word to the nearest reference at or
      // below it; fall back to plain nearest for the last record.
      let best = Infinity;
      j = -1;
      for (let k = 0; k < rys.length; k++) {
        const d = rys[k] - w.y;
        if (d >= -5 && d < best) { best = d; j = k; }
      }
      if (j < 0) j = nearest(w.y);
    } else {
      j = nearest(w.y);   // date/valuation always sit on the reference line
    }
    recs[j][c].push(w);
  }

  const order = (p: Word[]) => [...p].sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const join = (p: Word[]) => unesc(order(p).map((w) => w.t).join(" ")).replace(/\s+/g, " ").replace(/ ,/g, ",").trim();

  const out: string[][] = [];
  for (const r of recs) {
    const address = join(r.loc);
    if (!address) continue;
    const date = iso(join(r.date));
    out.push([r.ref, address, eircode(address), date, money(join(r.val))]);
  }

  const header = "ref,address,eircode,date_entered,valuation";
  const lines = out.map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(","));
  writeFileSync(CSV_OUT, [header, ...lines].join("\n") + "\n");
  console.log(`wrote ${out.length} rows to ${CSV_OUT}`);
}

main();
