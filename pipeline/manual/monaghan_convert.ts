// One-time converter: Monaghan County Council publishes its register as a PDF
// that already carries ITM (EPSG:2157) X/Y coordinates, so no geocoding is
// needed. Each record is a tall block (the "Action taken" column lists several
// Section notices), with the address above the reference line and the date /
// value / coordinates below it. We read word positions (pdftotext -bbox-layout),
// assign each word to a column by its x position and to a record by the nearest
// "DSN" reference, then stitch the cells. There is no owner column. We keep
// ref + address + eircode + town + date + valuation + x/y.
// Re-run when the register changes:  npx tsx pipeline/manual/monaghan_convert.ts
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const PDF_URL =
  "https://monaghan.ie/planning/wp-content/uploads/sites/4/2026/05/" +
  "Derelict-Sites-Online-Register-April-2026.pdf";
const PDF_TMP = "data/manual/monaghan.pdf";
const CSV_OUT = "data/manual/monaghan.csv";
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
function coord(s: string): string {
  const m = (s ?? "").match(/\d{5,7}(?:\.\d+)?/);
  return m ? m[0] : "";
}

const colOf = (xf: number): "ref" | "addr" | "eir" | "town" | "date" | "val" | "x" | "y" | "skip" =>
  xf < 0.155 ? "ref"
  : xf < 0.335 ? "addr"
  : xf < 0.39 ? "eir"
  : xf < 0.455 ? "town"
  : xf < 0.53 ? "date"
  : xf < 0.705 ? "val"
  : xf < 0.765 ? "skip"          // Action taken by MCC
  : xf < 0.845 ? "x"
  : "y";

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

  // Anchor each record on its "DSN <n>/<yy>" reference.
  const anchors: { y: number; page: number; ref: string }[] = [];
  for (const w of words) {
    if (w.t.trim() !== "DSN" || w.xf > 0.155) continue;
    const right = words
      .filter((o) => Math.abs(o.y - w.y) < 4 && o.x0 > w.x0 && o.xf < 0.16)
      .sort((a, b) => a.x0 - b.x0)[0];
    anchors.push({ y: w.y, page: Math.floor(w.y / 100000), ref: `DSN ${right ? right.t.trim() : ""}`.trim() });
  }
  const ays = anchors.map((a) => a.y);

  // Drop the column headers (above the first reference on each page).
  const pageMin = new Map<number, number>();
  for (const a of anchors) pageMin.set(a.page, Math.min(pageMin.get(a.page) ?? Infinity, a.y));
  const kept = words.filter((w) => {
    const m = pageMin.get(Math.floor(w.y / 100000));
    return m !== undefined && w.y >= m - 8;
  });

  type Cell = Word[];
  const recs = anchors.map(() => ({ addr: [] as Cell, eir: [] as Cell, town: [] as Cell, date: [] as Cell, val: [] as Cell, x: [] as Cell, y: [] as Cell }));
  for (const w of kept) {
    const c = colOf(w.xf);
    if (c === "skip" || c === "ref") continue;
    // Each record is a contiguous block; the ref sits within it, so nearest wins.
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
    const town = join(r.town).replace(/^-$/, "");
    let address = join(r.addr) || town;
    if (town && !new RegExp(`\\b${town.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(address)) address += `, ${town}`;
    if (!/\bmonaghan\b/i.test(address)) address += ", Co. Monaghan";
    const eir = eircode(join(r.eir));
    out.push([anchors[i].ref, address, eir, iso(join(r.date)), money(join(r.val)), coord(join(r.x)), coord(join(r.y))]);
  }

  const header = "ref,address,eircode,date_entered,valuation,itm_x,itm_y";
  const lines = out.map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(","));
  writeFileSync(CSV_OUT, [header, ...lines].join("\n") + "\n");
  const withXY = out.filter((r) => r[5] && r[6]).length;
  console.log(`wrote ${out.length} rows to ${CSV_OUT} (${withXY} with coordinates)`);
}

main();
