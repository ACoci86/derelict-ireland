// One-time converter: Cork City publishes its derelict sites register only as a
// PDF, so this turns that PDF into a clean CSV we commit and the adapter reads.
// It is NOT part of `npm run pipeline`. Re-run only when the register changes:
//   npx tsx pipeline/manual/cork_convert.ts
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const PDF_URL = "https://www.corkcity.ie/media/astd5t1p/derelict-sites-register.pdf";
const PDF_TMP = "data/manual/cork_city.pdf";
const CSV_OUT = "data/manual/cork_city.csv";

// The register uses TWO date formats: old "13-Apr-93" and newer "01/07/2016".
const DATE = String.raw`\d{1,2}-[A-Za-z]{3}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}`;
// A real record line: entry-no, DSP ref, other ref, address..., date at end.
// The DSP ref is written inconsistently: "DSP 1852", "DSP1852", or "DSP-1827",
// so allow an optional space/dash and capture just the number.
const REC = new RegExp(String.raw`^\s*(\d+)\s+DSP[\s-]*(\d+[A-Za-z]?)\s+(N\/A|DS[\s-]*\S+)\s+(.*?)\s+(${DATE})\s*$`);
// A wrapped continuation: indented text, no entry number, no trailing date.
const CONT = /^\s{20,}(\S.*?)\s*$/;
const HAS_DATE = new RegExp(DATE);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Normalise either date format to ISO "1993-04-13".
function iso(d: string): string {
  if (d.includes("/")) {                              // "01/07/2016" -> DD/MM/YYYY
    const [dd, mm, yyyy] = d.split("/");
    return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }
  const [dd, mon, yy] = d.split("-");                 // "13-Apr-93"
  const y = Number(yy) >= 90 ? 1900 + Number(yy) : 2000 + Number(yy);
  const m = MONTHS.indexOf(mon) + 1;
  return `${y}-${String(m).padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

async function main() {
  // 1. Download the PDF and extract its text with the pdftotext CLI.
  const buf = Buffer.from(await (await fetch(PDF_URL)).arrayBuffer());
  writeFileSync(PDF_TMP, buf);
  const text = execSync(`pdftotext -layout "${PDF_TMP}" -`, { encoding: "utf8" });

  // 2. Walk the lines, stitching wrapped addresses onto their record.
  const rows: string[][] = [];
  let pending = "";
  for (const ln of text.split("\n")) {
    const m = ln.match(REC);
    if (m) {
      const [, , dspNum, , addr, date] = m;          // entry-no and other-ref unused
      const full = pending ? `${pending} ${addr}`.trim() : addr.trim();
      rows.push([`DSP ${dspNum}`, full, iso(date)]);  // normalise ref to "DSP 1852"
      pending = "";                                  // used it up
      continue;
    }
    const c = ln.match(CONT);
    if (c && !HAS_DATE.test(ln) && !ln.includes("Address")) {
      pending = `${pending} ${c[1]}`.trim();         // top half of a split address
    } else {
      pending = "";
    }
  }

  // 2b. Six records defeat automatic parsing: their date wrapped onto the next
  //     line, or (worse) got glued straight onto the address with no space, so
  //     the column layout breaks. They're transcribed by hand from the PDF.
  //     If Cork republishes the register, re-check these against the new file.
  const MANUAL: string[][] = [
    ["DSP 1943", "49/50 Old Market Place (junction of Wolfe Tone Street & Glen Ryan Road)", "2022-02-18"],
    ["DSP 2025", "Forecourt at 49/50 Old Market Place (junction of Wolfe Tone St. & Glen Ryan Rd.)", "2022-02-04"],
    ["DSP 2036", "1 Alms Cottages, Glanmire Village, also known as 1 The Cottages", "2022-12-02"],
    ["DSP 2037", "2 Alms Cottages, Glanmire Village also known as 2 The Cottages", "2022-12-02"],
    ["DSP 2038", "3 Alms Cottages, Glanmire Village also known as 3 The Cottages", "2022-12-02"],
    ["DSP 2154", "1-6 Woodlea Cottages, Eastcliffe, Ballinglanna, Glanmire, Cork T45A611", "2026-03-13"],
  ];
  const seen = new Set(rows.map((r) => r[0]));
  for (const m of MANUAL) if (!seen.has(m[0])) rows.push(m);

  // 3. Write the CSV (quote every field so commas in addresses are safe).
  const csv = ["ref,address,date_entered"];
  for (const [ref, addr, date] of rows) {
    csv.push([ref, addr, date].map((v) => `"${v.replace(/"/g, '""')}"`).join(","));
  }
  writeFileSync(CSV_OUT, csv.join("\n") + "\n");
  console.log(`wrote ${rows.length} rows to ${CSV_OUT}`);
}

main();
