import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { makeSite, type Site } from "../schema";

// Cork County publishes its register as an on-page HTML table.
// pipeline/manual/cork_county_convert.ts scrapes it into this committed CSV.
const CSV_PATH = "data/manual/cork_county.csv";
const SOURCE_URL =
  "https://www.corkcoco.ie/en/resident/municipal-districts/" +
  "derelict-sites-dangerous-structures/derelict-sites-register-list";
const COUNCIL = "Cork County";
const RETRIEVED = "2026-07-09";    // date we scraped the page

export async function load(): Promise<Site[]> {
  const rows = parse(readFileSync(CSV_PATH, "utf8"), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];

  return rows.map((row) => {
    const ref = row.ref?.trim() || null;
    // Address for geocoding = street + town (the town column adds vital context).
    const address = [row.address, row.town].filter(Boolean).join(", ");
    const valuation = Number(row.valuation);

    return makeSite({
      id: ref ? `cork-co-${ref.replace(/\//g, "-")}` : `cork-co-${address}`,
      council: COUNCIL,
      address,
      eircode: row.eircode?.trim() || null,       // captured, ready for later use
      register_ref: ref,
      date_entered: row.date_entered?.trim() || null,
      valuation: Number.isFinite(valuation) && valuation > 0 ? valuation : null,
      // No coordinates in the source -> geocoded from address/town.
      source_url: SOURCE_URL,
      retrieved: RETRIEVED,
    });
  });
}

// Run directly:  npx tsx pipeline/adapters/cork_county.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  load().then((sites) => {
    for (const s of sites) console.log(`${s.id.padEnd(16)} ${s.address}`);
    console.log(`\n${sites.length} sites loaded`);
  });
}
