import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { makeSite, type Site } from "../schema";

// Mayo County Council publishes its register as an Excel spreadsheet with no
// coordinates. pipeline/manual/mayo_convert.ts turns it into this committed CSV
// (owner data dropped); this adapter reads it and leaves lat/lon null so
// geocode.ts places each site from its address.
const CSV_PATH = "data/manual/mayo.csv";
const SOURCE_URL = "https://www.mayo.ie/environment/derelict-sites";
const COUNCIL = "Mayo";
// The date we converted the spreadsheet. Bump when re-running mayo_convert.ts.
const RETRIEVED = "2026-07-10";

// "DS40/103" -> "ds40-103" for a clean id.
const slug = (r: string): string =>
  r.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export async function load(): Promise<Site[]> {
  const rows = parse(readFileSync(CSV_PATH, "utf8"), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];

  return rows.map((row) => {
    const ref = row.ref?.trim() || null;

    let address = row.address?.trim() || (ref ? `Mayo, register ref ${ref}` : "Mayo");
    if (!/\bmayo\b/i.test(address)) address += ", Co. Mayo";

    const valuation = Number(row.valuation);

    return makeSite({
      id: ref ? `mayo-${slug(ref)}` : `mayo-${slug(address)}`,
      council: COUNCIL,
      address,
      register_ref: ref,
      eircode: row.eircode?.trim() || null,
      date_entered: row.date_entered?.trim() || null,
      valuation: Number.isFinite(valuation) && valuation > 0 ? valuation : null,
      // No coordinates in the source -> left for the geocoder.
      source_url: SOURCE_URL,
      retrieved: RETRIEVED,
    });
  });
}

// Run directly:  npx tsx pipeline/adapters/mayo.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  load().then((sites) => {
    for (const s of sites) console.log(`${s.id.padEnd(14)} ${(s.date_entered ?? "?").padEnd(11)} ${s.address}`);
    console.log(`\n${sites.length} sites loaded (all need geocoding)`);
  });
}
