import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { makeSite, type Site } from "../schema";

// Kildare County Council publishes its register only as a PDF (no coordinates).
// pipeline/manual/kildare_convert.ts scrapes it into this CSV; this adapter just
// reads it and leaves lat/lon null so geocode.ts places each site from its
// address. The PDF carries no owner data.
const CSV_PATH = "data/manual/kildare.csv";
const SOURCE_URL = "https://kildarecoco.ie/AllServices/Housing/DerelictSites/";
const COUNCIL = "Kildare";
// The date we converted the PDF. Bump this when re-running kildare_convert.ts.
const RETRIEVED = "2026-07-10";

export async function load(): Promise<Site[]> {
  const rows = parse(readFileSync(CSV_PATH, "utf8"), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];

  return rows.map((row) => {
    const ref = row.ref?.trim() || null;

    // Add the county to help the geocoder when the address omits it.
    let address = row.address?.trim() || (ref ? `Kildare, register ref ${ref}` : "Kildare");
    if (!/\bkildare\b/i.test(address)) address += ", Co. Kildare";

    return makeSite({
      id: ref ? `kildare-${ref}` : `kildare-${address}`,
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

// Run directly:  npx tsx pipeline/adapters/kildare.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  load().then((sites) => {
    for (const s of sites) console.log(`${s.id.padEnd(20)} ${s.date_entered ?? "?"}  ${s.address}`);
    console.log(`\n${sites.length} sites loaded (all need geocoding)`);
  });
}
