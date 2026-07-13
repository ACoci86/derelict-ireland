import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { makeSite, type Site } from "../schema";

// Sligo County Council publishes its register as an HTML table (no coordinates).
// pipeline/manual/sligo_convert.ts scrapes it into this CSV (owner column
// dropped); this adapter reads it and leaves lat/lon null so geocode.ts places
// each site from its address.
const CSV_PATH = "data/manual/sligo.csv";
const SOURCE_URL = "https://www.sligococo.ie/planning/Enforcement/DerelictSites/";
const COUNCIL = "Sligo";
const RETRIEVED = "2026-07-11";

const slug = (r: string): string =>
  r.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export async function load(): Promise<Site[]> {
  const rows = parse(readFileSync(CSV_PATH, "utf8"), {
    columns: true, skip_empty_lines: true, trim: true,
  }) as Record<string, string>[];

  return rows.map((row) => {
    const ref = row.ref?.trim() || null;
    let address = row.address?.trim() || (ref ? `Sligo, register ref ${ref}` : "Sligo");
    if (!/\bsligo\b/i.test(address)) address += ", Co. Sligo";
    const valuation = Number(row.valuation);

    return makeSite({
      id: ref ? `sligo-${slug(ref)}` : `sligo-${slug(address)}`,
      council: COUNCIL,
      address,
      register_ref: ref,
      eircode: row.eircode?.trim() || null,
      date_entered: row.date_entered?.trim() || null,
      valuation: Number.isFinite(valuation) && valuation > 0 ? valuation : null,
      source_url: SOURCE_URL,
      retrieved: RETRIEVED,
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  load().then((sites) => {
    for (const s of sites) console.log(`${s.id.padEnd(12)} ${(s.date_entered ?? "?").padEnd(11)} ${s.address}`);
    console.log(`\n${sites.length} sites loaded (all need geocoding)`);
  });
}
