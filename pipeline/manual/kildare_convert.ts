// One-time converter: Kildare County Council publishes its register as a PDF
// with no coordinates. The layout is a wide table where a single record's cells
// wrap across several lines and interleave, so a plain line reader is unreliable.
// Instead we read word positions (pdftotext -bbox-layout), drop header/footer
// lines, assign each word to a column by its x position and to a record by the
// nearest Date-of-Entry row, then stitch the cells back together. Sites have no
// coordinates here, so geocode.ts places them from the address later.
// Re-run when the register changes:  npx tsx pipeline/manual/kildare_convert.ts
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const PDF_URL =
  "https://kildarecoco.ie/AllServices/Housing/DerelictSites/DS%20register%2020.03.2026.pdf";
const PDF_TMP = "data/manual/kildare.pdf";
const CSV_OUT = "data/manual/kildare.csv";
const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";

interface Word { x0: number; y: number; x1: number; yc: number; t: string; pw: number }

// "31/01/2011" -> "2011-01-31".
function iso(d: string): string {
  const m = d.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : "";
}

const unesc = (s: string): string =>
  s.replace(/&amp;/g, "&").replace(/&apos;/g, "'").replace(/&#0?39;/g, "'")
   .replace(/&#8217;/g, "’").replace(/&quot;/g, '"');

// Column of a word by its left edge as a fraction of page width.
const colOf = (x: number, pw: number): "ref" | "date" | "addr" | "dist" =>
  x / pw < 0.20 ? "ref" : x / pw < 0.37 ? "date" : x / pw < 0.70 ? "addr" : "dist";

async function main() {
  // 1. Download the PDF (Kildare's server needs a browser User-Agent).
  const buf = Buffer.from(await (await fetch(PDF_URL, { headers: { "User-Agent": UA } })).arrayBuffer());
  writeFileSync(PDF_TMP, buf);

  // 2. Extract words with bounding boxes. Offset each page's y so records never
  //    bleed across page breaks (page 2's y=100 must not sit near page 1's).
  const xml = execSync(`pdftotext -bbox-layout "${PDF_TMP}" -`, { encoding: "utf8", maxBuffer: 1 << 26 });
  const words: Word[] = [];
  const pageRe = /<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g;
  let pm: RegExpExecArray | null;
  let page = 0;
  while ((pm = pageRe.exec(xml))) {
    const pw = parseFloat(pm[1]);
    const yoff = page * 100000;
    const wordRe = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g;
    let wm: RegExpExecArray | null;
    while ((wm = wordRe.exec(pm[3]))) {
      const y0 = +wm[2] + yoff, y1 = +wm[4] + yoff;
      words.push({ x0: +wm[1], y: y0, x1: +wm[3], yc: (y0 + y1) / 2, t: wm[5], pw });
    }
    page++;
  }

  // 3. Drop whole header/footer lines: any text line carrying one of these
  //    words is a running header, the column titles, or the footer.
  const TRIGGERS = new Set(["File", "Municipal", "Derelict", "End", "updated:"]);
  const bands = words.filter((w) => TRIGGERS.has(w.t.trim())).map((w) => w.yc);
  const kept = words.filter((w) => !bands.some((b) => Math.abs(w.yc - b) < 6));

  // 4. Each Date-of-Entry anchors one record; assign every other word to the
  //    record whose date is nearest in (page-offset) y.
  const dateRe = /^\d{2}\/\d{2}\/\d{4}$/;
  const dates = kept.filter((w) => dateRe.test(w.t.trim()));
  const recs = dates.map((d) => ({ ref: [] as Word[], addr: [] as Word[], dist: [] as Word[], date: d.t.trim() }));
  const dys = dates.map((d) => d.yc);
  for (const w of kept) {
    if (dateRe.test(w.t.trim())) continue;
    const c = colOf(w.x0, w.pw);
    if (c === "date") continue;
    let j = 0, best = Infinity;
    for (let k = 0; k < dys.length; k++) {
      const d = Math.abs(dys[k] - w.yc);
      if (d < best) { best = d; j = k; }
    }
    recs[j][c].push(w);
  }

  // 5. Stitch cells back in reading order (top-to-bottom, left-to-right). A ref
  //    that wrapped ("DS-2016-" + "Newbridge01") joins with no space.
  const order = (p: Word[]) => [...p].sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const jref = (p: Word[]) => unesc(order(p).map((w) => w.t).join(""));
  const jtxt = (p: Word[]) => unesc(order(p).map((w) => w.t).join(" ")).replace(/ ,/g, ",").trim().replace(/,+$/, "");

  const out = recs
    .map((r) => [jref(r.ref), jtxt(r.addr), iso(r.date), jtxt(r.dist)])
    .filter((r) => r[0].startsWith("DS"));

  const header = "ref,address,date_entered,municipal_district";
  const lines = out.map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(","));
  writeFileSync(CSV_OUT, [header, ...lines].join("\n") + "\n");
  console.log(`wrote ${out.length} rows to ${CSV_OUT}`);
}

main();
