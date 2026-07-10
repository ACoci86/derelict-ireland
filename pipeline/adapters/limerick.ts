import { readFileSync } from "node:fs";
import proj4 from "proj4";
import { parse } from "csv-parse/sync";
import { makeSite, type Site } from "../schema";

// Limerick City and County publishes its register as a PDF with an ITM grid
// coordinate (ds_x/ds_y) on most records. pipeline/manual/limerick_convert.ts
// scrapes it into this CSV; here we convert the grid coordinates to lat/lon,
// exactly like the Galway and DLR adapters. The ~20 newest sites carry no
// coordinate yet, those keep lat/lon null and geocode.ts fills them from the
// address.
const CSV_PATH = "data/manual/limerick.csv";
const SOURCE_URL =
  "https://www.limerick.ie/sites/default/files/media/documents/2026-03/" +
  "derelict-site-register-2026.pdf";
const COUNCIL = "Limerick City and County";
const RETRIEVED = "2026-07-10";    // date we downloaded the PDF

// Irish Transverse Mercator, EPSG:2157 (same grid Galway and DLR publish in).
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
    // Rows without a coordinate leave lat/lon null for the geocoder.
    let lat: number | null = null;
    let lon: number | null = null;
    let confidence: Site["geocode_confidence"] = "none";
    const x = Number(row.ds_x);
    const y = Number(row.ds_y);
    if (Number.isFinite(x) && Number.isFinite(y) && x > 0 && y > 0) {
      [lon, lat] = itmToWgs84.forward([x, y]);
      lon = round6(lon);
      lat = round6(lat);
      confidence = "council";
    }

    const valuation = Number(row.valuation);

    return makeSite({
      id: ref ? `limerick-${ref}` : `limerick-${row.ds_x}-${row.ds_y}`,
      council: COUNCIL,
      // Address is best-effort; a handful of rows carry none, so fall back to
      // the register reference to keep the pin labelled.
      address: row.address?.trim() || `Limerick, register ref ${ref}`,
      eircode: row.eircode?.trim() || null,
      register_ref: ref,
      valuation: Number.isFinite(valuation) && valuation > 0 ? valuation : null,
      lat,
      lon,
      geocode_confidence: confidence,
      source_url: SOURCE_URL,
      retrieved: RETRIEVED,
    });
  });
}

// Run directly:  npx tsx pipeline/adapters/limerick.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  load().then((sites) => {
    for (const s of sites) {
      const where = s.lat ? `${s.lat.toFixed(4)}, ${s.lon!.toFixed(4)}` : "(needs geocoding)";
      console.log(`${s.id.padEnd(16)} ${where.padEnd(22)} ${s.address}`);
    }
    const mapped = sites.filter((s) => s.lat !== null).length;
    console.log(`\n${sites.length} sites, ${mapped} with coords, ${sites.length - mapped} need geocoding`);
  });
}
