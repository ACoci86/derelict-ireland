// One-time converter: Cork County publishes its register as an on-page HTML
// table. This scrapes it into a committed CSV the adapter reads. It is NOT part
// of `npm run pipeline`. Re-run when the page changes:
//   npx tsx pipeline/manual/cork_county_convert.ts
import { writeFileSync } from "node:fs";
import * as cheerio from "cheerio";

const PAGE_URL =
  "https://www.corkcoco.ie/en/resident/municipal-districts/" +
  "derelict-sites-dangerous-structures/derelict-sites-register-list";
const CSV_OUT = "data/manual/cork_county.csv";

// "20/12/2022" -> "2022-12-20"
function iso(d: string): string {
  const m = d.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return "";
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

async function main() {
  // 1. Download the page and hand it to cheerio.
  const html = await (await fetch(PAGE_URL)).text();
  const $ = cheerio.load(html);

  // 2. Loop the table's rows; read each row's cells as plain text.
  //    cheerio's .text() decodes HTML entities for us (&nbsp;, &#039;, ...).
  const out: string[][] = [];
  $("table tr").each((_, tr) => {
    const cells = $(tr).find("td").map((_, td) => $(td).text().trim()).get();
    if (cells.length < 6) return;                    // skip header / short rows
    const [ref, address, town, eircode, date, valuation] = cells;
    if (!/\/DS\//.test(ref)) return;                 // only real register rows
    out.push([
      ref,
      address,
      town,
      eircode,
      iso(date),
      valuation.replace(/[^\d]/g, ""),               // "€150,000" -> "150000"
    ]);
  });

  // 3. Write the CSV (quote every field so commas are safe).
  const header = "ref,address,town,eircode,date_entered,valuation";
  const lines = out.map((r) =>
    r.map((v) => `"${v.replace(/"/g, '""')}"`).join(","));
  writeFileSync(CSV_OUT, [header, ...lines].join("\n") + "\n");
  console.log(`wrote ${out.length} rows to ${CSV_OUT}`);
}

main();
