// One-time converter: Limerick City and County Council publishes its register
// as a wide-table PDF. Most records carry an ITM grid coordinate (the ds_x/ds_y
// columns) which maps them precisely; the most recent additions have no
// coordinate yet and fall back to the geocoder. This scrapes ref + address +
// eircode + electoral area + valuation + coordinate into a committed CSV.
// Re-run when the register changes:  npx tsx pipeline/manual/limerick_convert.ts
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const PDF_URL =
  "https://www.limerick.ie/sites/default/files/media/documents/2026-03/" +
  "derelict-site-register-2026.pdf";
const PDF_TMP = "data/manual/limerick.pdf";
const CSV_OUT = "data/manual/limerick.csv";

// The six electoral areas. Used to tell "address is missing" apart from a real
// address: when the field right after the site id is one of these, the PDF row
// simply had no address in it.
const ELECTORAL_AREAS = [
  "Limerick City West",
  "Limerick City East",
  "Limerick City North",
  "Cappamore/Kilmallock",
  "Newcastle West",
  "Adare/Rathkeale",
];

// A record line starts with a row number and a site id, e.g. "  12  DS-078-17 …".
const RECORD = /^\s*\d+\s+DS-\d{3}-\d{2}\b/;
// Limerick eircodes route through V** (V94, V42, V35 …); allow an optional space.
const EIRCODE = /\bV\d{2}\s?[A-Z0-9]{4}\b/;
// ds_x / ds_y are the trailing pair of bare 6-digit integers. Dates carry
// slashes and valuations carry a € and commas, so neither can match here.
const COORDS = /(\d{6})\s+(\d{6})\s*$/;

async function main() {
  // 1. Download the PDF and extract its text with the column layout preserved.
  const buf = Buffer.from(await (await fetch(PDF_URL)).arrayBuffer());
  writeFileSync(PDF_TMP, buf);
  const text = execSync(`pdftotext -layout "${PDF_TMP}" -`, { encoding: "utf8" });

  const out: string[][] = [];
  for (const ln of text.split("\n")) {
    if (!RECORD.test(ln)) continue;                 // skip headers + wrapped lines

    const ref = ln.match(/DS-\d{3}-\d{2}/)![0];

    // Fields are separated by runs of 2+ spaces. The address is the field right
    // after the site id — unless that field is an electoral area, which means
    // the row carried no address (left blank; the geocoder can't help either).
    const parts = ln.trim().split(/\s{2,}/).filter(Boolean);
    const refIdx = parts.findIndex((p) => p === ref);
    const cand = parts[refIdx + 1]?.trim() ?? "";
    const address = ELECTORAL_AREAS.includes(cand) ? "" : cand;

    const ea = ELECTORAL_AREAS.find((a) => ln.includes(a)) ?? "";
    const eir = ln.match(EIRCODE);
    const val = ln.match(/€\s?([\d,]+)/);
    const xy = ln.match(COORDS);

    out.push([
      ref,
      address,
      eir ? eir[0].replace(/\s+/g, " ") : "",
      ea,
      val ? val[1].replace(/,/g, "") : "",
      xy ? xy[1] : "",
      xy ? xy[2] : "",
    ]);
  }

  // 2. Write the CSV (quote every field so commas in addresses are safe).
  const header = "ref,address,eircode,electoral_area,valuation,ds_x,ds_y";
  const lines = out.map((r) =>
    r.map((v) => `"${v.replace(/"/g, '""')}"`).join(","));
  writeFileSync(CSV_OUT, [header, ...lines].join("\n") + "\n");

  const withCoords = out.filter((r) => r[5] && r[6]).length;
  console.log(
    `wrote ${out.length} rows to ${CSV_OUT} ` +
      `(${withCoords} with coordinates, ${out.length - withCoords} to geocode)`
  );
}

main();
