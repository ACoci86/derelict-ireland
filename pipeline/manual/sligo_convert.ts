// One-time converter: Sligo County Council publishes its register as an HTML
// table (no coordinates). We scrape it with cheerio and keep ref + address +
// eircode + date + valuation. The table has an Owner column (personal data)
// which we deliberately never read, the same as the Offaly and Mayo adapters.
// Re-run when the register changes:  npx tsx pipeline/manual/sligo_convert.ts
import { writeFileSync } from "node:fs";
import * as cheerio from "cheerio";

// Sligo's server presents an incomplete TLS chain; allow this one-time fetch.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const PAGE_URL = "https://www.sligococo.ie/planning/Enforcement/DerelictSites/";
const CSV_OUT = "data/manual/sligo.csv";
const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";

// Column order: Number, File Reference, Address & type, Owner, Urban Area,
// Date Entered, Valuation. Owner (index 3) is never read.
function iso(d: string): string {
  const m = (d ?? "").match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : "";
}
function eircode(s: string): string {
  const m = (s ?? "").toUpperCase().match(/\b([A-Z]\d{2})\s?([A-Z0-9]{4})\b/);
  return m ? `${m[1]} ${m[2]}` : "";
}
function money(s: string): string {
  const n = Number(String(s ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? String(Math.round(n)) : "";
}

async function main() {
  const html = await (await fetch(PAGE_URL, { headers: { "User-Agent": UA } })).text();
  const $ = cheerio.load(html);

  const out: string[][] = [];
  $("table tr").each((_, tr) => {
    const tds = $(tr).find("td").map((_i, td) => $(td).text().replace(/\s+/g, " ").trim()).get();
    if (tds.length < 7) return;             // header or malformed row
    const ref = tds[1];
    const address = tds[2];
    if (!ref || !/^DS/i.test(ref)) return;
    out.push([ref, address, eircode(address), iso(tds[5]), money(tds[6])]);
  });

  const header = "ref,address,eircode,date_entered,valuation";
  const lines = out.map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(","));
  writeFileSync(CSV_OUT, [header, ...lines].join("\n") + "\n");
  console.log(`wrote ${out.length} rows to ${CSV_OUT}`);
}

main();
