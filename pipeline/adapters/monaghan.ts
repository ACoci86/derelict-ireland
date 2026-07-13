import { readFileSync } from "node:fs";
import proj4 from "proj4";
import { parse } from "csv-parse/sync";
import { makeSite, type Site } from "../schema";

// Monaghan County Council publishes its register as a PDF that carries ITM
// (EPSG:2157) X/Y coordinates for most sites. pipeline/manual/monaghan_convert.ts
// scrapes it into this CSV; here we convert the grid coordinates to lat/lon like
// the Limerick adapter, and leave the few without coordinates for geocode.ts.
// The register has no owner column.
const CSV_PATH = "data/manual/monaghan.csv";
const SOURCE_URL = "https://monaghan.ie/planning/derelict-sites/";
const COUNCIL = "Monaghan";
const RETRIEVED = "2026-07-11";

proj4.defs(
  "EPSG:2157",
  "+proj=tmerc +lat_0=53.5 +lon_0=-8 +k=0.99982 +x_0=600000 +y_0=750000 " +
    "+ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs"
);
const itmToWgs84 = proj4("EPSG:2157", "WGS84");
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const slug = (r: string): string =>
  r.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export async function load(): Promise<Site[]> {
  const rows = parse(readFileSync(CSV_PATH, "utf8"), {
    columns: true, skip_empty_lines: true, trim: true,
  }) as Record<string, string>[];

  return rows.map((row) => {
    const ref = row.ref?.trim() || null;

    let lat: number | null = null;
    let lon: number | null = null;
    let confidence: Site["geocode_confidence"] = "none";
    const x = Number(row.itm_x);
    const y = Number(row.itm_y);
    if (Number.isFinite(x) && Number.isFinite(y) && x > 0 && y > 0) {
      [lon, lat] = itmToWgs84.forward([x, y]);
      lon = round6(lon); lat = round6(lat);
      confidence = "council";
    }

    let address = row.address?.trim() || (ref ? `Monaghan, register ref ${ref}` : "Monaghan");
    if (!/\bmonaghan\b/i.test(address)) address += ", Co. Monaghan";
    const valuation = Number(row.valuation);

    return makeSite({
      id: ref ? `monaghan-${slug(ref)}` : `monaghan-${slug(address)}`,
      council: COUNCIL,
      address,
      register_ref: ref,
      eircode: row.eircode?.trim() || null,
      date_entered: row.date_entered?.trim() || null,
      valuation: Number.isFinite(valuation) && valuation > 0 ? valuation : null,
      lat, lon, geocode_confidence: confidence,
      source_url: SOURCE_URL,
      retrieved: RETRIEVED,
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  load().then((sites) => {
    const mapped = sites.filter((s) => s.lat !== null).length;
    console.log(`${sites.length} sites, ${mapped} with council coords, ${sites.length - mapped} need geocoding`);
  });
}
