import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { makeSite, type Site } from "../schema";

// Cork City publishes its register only as a PDF. pipeline/manual/cork_convert.ts
// turns that PDF into this committed CSV; this adapter just reads it.
const CSV_PATH = "data/manual/cork_city.csv";
const SOURCE_URL = "https://www.corkcity.ie/media/astd5t1p/derelict-sites-register.pdf";
const COUNCIL = "Cork City";
// The date we converted the PDF. Bump this when re-running cork_convert.ts.
const RETRIEVED = "2026-07-09";

export async function load(): Promise<Site[]> {
  // 1. Read the committed CSV (not downloaded — it's our source of record).
  const text = readFileSync(CSV_PATH, "utf8");

  // 2. Parse it. Columns: ref, address, date_entered.
  const rows = parse(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];

  // 3. Turn each row into a Site. Cork gives no coordinates, so lat/lon stay
  //    null here and geocode.ts fills them in from the address.
  return rows.map((row) => {
    const address = row.address?.trim() ?? "";

    // "DSP 696" -> "DSP-696"
    const raw = row.ref?.trim();
    const ref = raw ? raw.replace(/\s+/g, "-") : null;

    return makeSite({
      id: ref ? `cork-${ref}` : `cork-${address}`,
      council: COUNCIL,
      address,
      register_ref: ref,
      date_entered: row.date_entered?.trim() || null,
      // No coordinates in the source -> left for the geocoder.
      source_url: SOURCE_URL,
      retrieved: RETRIEVED,
    });
  });
}

// Run directly:  npx tsx pipeline/adapters/cork_city.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  load().then((sites) => {
    for (const s of sites) console.log(`${s.id.padEnd(14)} ${s.address}`);
    console.log(`\n${sites.length} sites loaded (all need geocoding)`);
  });
}
