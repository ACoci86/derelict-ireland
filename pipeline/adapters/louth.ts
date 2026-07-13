import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { makeSite, type Site } from "../schema";

// Louth County Council publishes its register only as a PDF (no coordinates).
// pipeline/manual/louth_convert.ts scrapes it into this CSV; this adapter reads
// it and leaves lat/lon null so geocode.ts places each site from its address.
// The register has no owner column.
const CSV_PATH = "data/manual/louth.csv";
const SOURCE_URL = "https://www.louthcoco.ie/en/services/planning/derelict-sites-dangerous-structures/";
const COUNCIL = "Louth";
// The date we converted the PDF. Bump when re-running louth_convert.ts.
const RETRIEVED = "2026-07-11";

// "DS 2023 010" -> "ds-2023-010" for a clean id.
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

    let address = row.address?.trim() || (ref ? `Louth, register ref ${ref}` : "Louth");
    if (!/\blouth\b/i.test(address)) address += ", Co. Louth";

    const valuation = Number(row.valuation);

    return makeSite({
      id: ref ? `louth-${slug(ref)}` : `louth-${slug(address)}`,
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

// Run directly:  npx tsx pipeline/adapters/louth.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  load().then((sites) => {
    for (const s of sites) {
      const val = s.valuation ? `€${s.valuation}` : "";
      console.log(`${s.id.padEnd(16)} ${(s.date_entered ?? "?").padEnd(11)} ${val.padEnd(9)} ${s.address}`);
    }
    console.log(`\n${sites.length} sites loaded (all need geocoding)`);
  });
}
