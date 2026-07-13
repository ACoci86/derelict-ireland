import { readFileSync } from "node:fs";
import proj4 from "proj4";
import { parse } from "csv-parse/sync";
import { makeSite, type Site } from "../schema";

// Laois County Council publishes its register as a PDF that already carries ITM
// (EPSG:2157) X/Y coordinates. pipeline/manual/laois_convert.ts scrapes it into
// this CSV; here we convert the grid coordinates to lat/lon, exactly like the
// Limerick and Galway adapters, so every site maps precisely with no geocoding.
// The register has no owner column.
const CSV_PATH = "data/manual/laois.csv";
const SOURCE_URL = "https://laois.ie/departments/planning/derelict-sites/";
const COUNCIL = "Laois";
const RETRIEVED = "2026-07-11";    // date we downloaded the PDF

// Irish Transverse Mercator, EPSG:2157.
proj4.defs(
  "EPSG:2157",
  "+proj=tmerc +lat_0=53.5 +lon_0=-8 +k=0.99982 +x_0=600000 +y_0=750000 " +
    "+ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs"
);
const itmToWgs84 = proj4("EPSG:2157", "WGS84");
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

// "20/39" -> "20-39" for a clean id.
const slug = (r: string): string =>
  r.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export async function load(): Promise<Site[]> {
  const rows = parse(readFileSync(CSV_PATH, "utf8"), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];

  // Refs are short (e.g. "20/39") and can repeat; disambiguate with an index.
  const refCounts = new Map<string, number>();
  for (const r of rows) {
    const k = r.ref?.trim();
    if (k) refCounts.set(k, (refCounts.get(k) ?? 0) + 1);
  }
  const refSeen = new Map<string, number>();

  return rows.map((row) => {
    const ref = row.ref?.trim() || null;

    let lat: number | null = null;
    let lon: number | null = null;
    let confidence: Site["geocode_confidence"] = "none";
    const x = Number(row.itm_x);
    const y = Number(row.itm_y);
    if (Number.isFinite(x) && Number.isFinite(y) && x > 0 && y > 0) {
      [lon, lat] = itmToWgs84.forward([x, y]);
      lon = round6(lon);
      lat = round6(lat);
      confidence = "council";
    }

    let address = row.address?.trim() || (ref ? `Laois, register ref ${ref}` : "Laois");
    if (!/\blaois\b/i.test(address)) address += ", Co. Laois";

    const valuation = Number(row.valuation);

    let id: string;
    if (ref) {
      const base = `laois-${slug(ref)}`;
      if ((refCounts.get(ref) ?? 0) > 1) {
        const i = (refSeen.get(ref) ?? 0) + 1;
        refSeen.set(ref, i);
        id = `${base}-${i}`;
      } else id = base;
    } else id = `laois-${slug(address)}`;

    return makeSite({
      id,
      council: COUNCIL,
      address,
      register_ref: ref,
      eircode: row.eircode?.trim() || null,
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

// Run directly:  npx tsx pipeline/adapters/laois.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  load().then((sites) => {
    for (const s of sites) {
      const where = s.lat ? `${s.lat.toFixed(4)}, ${s.lon!.toFixed(4)}` : "(needs geocoding)";
      console.log(`${s.id.padEnd(14)} ${where.padEnd(22)} ${s.address}`);
    }
    const mapped = sites.filter((s) => s.lat !== null).length;
    console.log(`\n${sites.length} sites, ${mapped} with council coords`);
  });
}
