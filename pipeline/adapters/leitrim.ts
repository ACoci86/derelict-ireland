import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { makeSite, type Site } from "../schema";

// Leitrim County Council publishes its register as an Excel spreadsheet (no
// coordinates). pipeline/manual/leitrim_convert.ts scrapes it into this CSV
// (owner column dropped); this adapter reads it and leaves lat/lon null so
// geocode.ts places each site from its address.
const CSV_PATH = "data/manual/leitrim.csv";
const SOURCE_URL = "https://www.leitrim.ie/Council/Services/Planning-Building/Derelict-sites/";
const COUNCIL = "Leitrim";
const RETRIEVED = "2026-07-11";

const slug = (r: string): string =>
  r.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export async function load(): Promise<Site[]> {
  const rows = parse(readFileSync(CSV_PATH, "utf8"), {
    columns: true, skip_empty_lines: true, trim: true,
  }) as Record<string, string>[];

  return rows.map((row) => {
    const ref = row.ref?.trim() || null;
    let address = row.address?.trim() || (ref ? `Leitrim, register ref ${ref}` : "Leitrim");
    if (!/\bleitrim\b/i.test(address)) address += ", Co. Leitrim";

    return makeSite({
      id: ref ? `leitrim-${slug(ref)}` : `leitrim-${slug(address)}`,
      council: COUNCIL,
      address,
      register_ref: ref,
      eircode: row.eircode?.trim() || null,
      date_entered: row.date_entered?.trim() || null,
      source_url: SOURCE_URL,
      retrieved: RETRIEVED,
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  load().then((sites) => {
    for (const s of sites) console.log(`${s.id.padEnd(14)} ${(s.date_entered ?? "?").padEnd(11)} ${s.address}`);
    console.log(`\n${sites.length} sites loaded (all need geocoding)`);
  });
}
