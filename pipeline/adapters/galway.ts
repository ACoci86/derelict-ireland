import { readFileSync } from "node:fs";
import proj4 from "proj4";
import { parse } from "csv-parse/sync";
import { makeSite, type Site } from "../schema";

// Galway City publishes its register as a PDF with an ITM grid coordinate on
// every record. pipeline/manual/galway_convert.ts scrapes it into this CSV;
// here we convert the grid coordinates to lat/lon, exactly like the DLR adapter.
const CSV_PATH = "data/manual/galway.csv";
const SOURCE_URL =
  "https://www.galwaycity.ie/services/housing/housing-services/vacant-and-derelict-properties/derelict-sites";
const COUNCIL = "Galway City";
const RETRIEVED = "2026-07-09";    // date we downloaded the PDF

// Irish Transverse Mercator, EPSG:2157 (same grid DLR publishes in).
proj4.defs(
  "EPSG:2157",
  "+proj=tmerc +lat_0=53.5 +lon_0=-8 +k=0.99982 +x_0=600000 +y_0=750000 " +
    "+ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs"
);
const itmToWgs84 = proj4("EPSG:2157", "WGS84");
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

export async function load(): Promise<Site[]> {
  const rows = parse(readFileSync(CSV_PATH, "utf8"), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];

  return rows.map((row) => {
    const ref = row.ref?.trim() || null;

    // Convert the Irish grid metres to lon/lat when both are valid numbers.
    let lat: number | null = null;
    let lon: number | null = null;
    let confidence: Site["geocode_confidence"] = "none";
    const e = Number(row.itm_e);
    const n = Number(row.itm_n);
    if (Number.isFinite(e) && Number.isFinite(n)) {
      [lon, lat] = itmToWgs84.forward([e, n]);
      lon = round6(lon);
      lat = round6(lat);
      confidence = "council";
    }

    const valuation = Number(row.valuation);

    return makeSite({
      id: ref ? `galway-${ref}` : `galway-${row.itm_e}-${row.itm_n}`,
      council: COUNCIL,
      // Address is best-effort; fall back to the register reference when the PDF
      // layout didn't give us a clean, owner-free address.
      address: row.address?.trim() || `Galway, register ref ${ref}`,
      eircode: row.eircode?.trim() || null,
      register_ref: ref,
      date_entered: row.date_entered?.trim() || null,
      valuation: Number.isFinite(valuation) && valuation > 0 ? valuation : null,
      lat,
      lon,
      geocode_confidence: confidence,
      source_url: SOURCE_URL,
      retrieved: RETRIEVED,
    });
  });
}

// Run directly:  npx tsx pipeline/adapters/galway.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  load().then((sites) => {
    for (const s of sites) {
      const where = s.lat ? `${s.lat.toFixed(4)}, ${s.lon!.toFixed(4)}` : "(no coords)";
      console.log(`${s.id.padEnd(12)} ${where.padEnd(22)} ${s.address}`);
    }
    const mapped = sites.filter((s) => s.lat !== null).length;
    console.log(`\n${sites.length} sites, ${mapped} with coords`);
  });
}
