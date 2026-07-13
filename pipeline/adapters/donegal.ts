import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { makeSite, type Site } from "../schema";

// Donegal County Council publishes its register as an Excel spreadsheet (no
// coordinates). pipeline/manual/donegal_convert.ts scrapes it into this CSV
// (owner columns dropped); this adapter reads it and leaves lat/lon null so
// geocode.ts places each site from its address.
const CSV_PATH = "data/manual/donegal.csv";
const SOURCE_URL = "https://www.donegalcoco.ie/services/planning/derelictsites/";
const COUNCIL = "Donegal";
const RETRIEVED = "2026-07-11";

const slug = (r: string): string =>
  r.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export async function load(): Promise<Site[]> {
  const rows = parse(readFileSync(CSV_PATH, "utf8"), {
    columns: true, skip_empty_lines: true, trim: true,
  }) as Record<string, string>[];

  return rows.map((row) => {
    const ref = row.ref?.trim() || null;
    let address = row.address?.trim() || (ref ? `Donegal, register ref ${ref}` : "Donegal");
    if (!/\bdonegal\b/i.test(address)) address += ", Co. Donegal";
    const valuation = Number(row.valuation);

    return makeSite({
      id: ref ? `donegal-${slug(ref)}` : `donegal-${slug(address)}`,
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
    for (const s of sites) console.log(`${s.id.padEnd(18)} ${(s.date_entered ?? "?").padEnd(11)} ${s.address}`);
    console.log(`\n${sites.length} sites loaded (all need geocoding)`);
  });
}
