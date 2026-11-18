import { readFileSync } from "node:fs";
import proj4 from "proj4";
import { parse } from "csv-parse/sync";
import { makeSite, type Site } from "../schema";

// Cavan County Council kept its register inspection-only until September 2026,
// when it published it as a PDF with ITM (EPSG:2157) X/Y coordinates.
// pipeline/manual/cavan_convert.ts scrapes it into this CSV; here we convert the
// grid coordinates to lat/lon, as the Laois, Limerick and Galway adapters do, so
// every site maps precisely with no geocoding. The register gives a townland and
// municipal district rather than a street address, and no valuations.
const CSV_PATH = "data/manual/cavan.csv";
const SOURCE_URL = "https://www.cavancoco.ie/services/planning-building/derelict-sites/";
const COUNCIL = "Cavan";
const RETRIEVED = "2026-11-18"; // date we downloaded the PDF

// Irish Transverse Mercator, EPSG:2157.
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

    // "Lurganboy (Loughtee Upper By), Cavan - Belturbet, Co. Cavan"
    const parts = [row.townland?.trim(), row.district?.trim()].filter(Boolean);
    const address = `${parts.join(", ") || (ref ? `Cavan, register ref ${ref}` : "Cavan")}, Co. Cavan`;

    return makeSite({
      id: `cavan-${(ref ?? address).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
      council: COUNCIL,
      address,
      register_ref: ref,
      eircode: row.eircode?.trim() || null,
      description: row.description?.trim() || null,
      date_entered: row.date_entered?.trim() || null,
      valuation: null,
      lat,
      lon,
      geocode_confidence: confidence,
      source_url: SOURCE_URL,
      retrieved: RETRIEVED,
    });
  });
}

// Run directly:  npx tsx pipeline/adapters/cavan.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  load().then((sites) => {
    for (const s of sites.slice(0, 8)) {
      const where = s.lat ? `${s.lat.toFixed(4)}, ${s.lon!.toFixed(4)}` : "(needs geocoding)";
      console.log(`${s.id.padEnd(16)} ${where.padEnd(22)} ${s.address}`);
    }
    const mapped = sites.filter((s) => s.lat !== null).length;
    console.log(`\n${sites.length} sites, ${mapped} with council coords`);
  });
}
