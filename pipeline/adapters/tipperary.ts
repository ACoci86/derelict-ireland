import { readFileSync } from "node:fs";
import proj4 from "proj4";
import { parse } from "csv-parse/sync";
import { makeSite, type Site } from "../schema";

// Tipperary County Council publishes its register as a spreadsheet. About a
// fifth of the rows carry a grid coordinate; the rest have only an address, so
// lat/lon stay null and geocode.ts places them. The coordinate column mixes two
// grids: older rows use the Irish Grid (EPSG:29903), newer ones use ITM
// (EPSG:2157). They are told apart by magnitude (ITM eastings are ~600,000,
// Irish Grid ~200,000). pipeline/manual/tipperary_convert.ts produces the
// committed CSV. No owner data is present in the source.
const CSV_PATH = "data/manual/tipperary.csv";
const SOURCE_URL = "https://www.tipperarycoco.ie/planning-and-building/derelict-sites-register";
const COUNCIL = "Tipperary";
const RETRIEVED = "2026-07-11";    // date we downloaded the spreadsheet

// Irish Grid (TM75, EPSG:29903) and ITM (EPSG:2157). The sheet mixes both.
proj4.defs(
  "EPSG:29903",
  "+proj=tmerc +lat_0=53.5 +lon_0=-8 +k=1.000035 +x_0=200000 +y_0=250000 " +
    "+ellps=mod_airy +towgs84=482.5,-130.6,564.6,-1.042,-0.214,-0.631,8.15 +units=m +no_defs"
);
proj4.defs(
  "EPSG:2157",
  "+proj=tmerc +lat_0=53.5 +lon_0=-8 +k=0.99982 +x_0=600000 +y_0=750000 " +
    "+ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs"
);
const irishGridToWgs84 = proj4("EPSG:29903", "WGS84");
const itmToWgs84 = proj4("EPSG:2157", "WGS84");
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

// "ENV-C-97-201" -> "env-c-97-201" for a clean id.
const slug = (r: string): string =>
  r.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export async function load(): Promise<Site[]> {
  const rows = parse(readFileSync(CSV_PATH, "utf8"), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];

  // Several distinct properties (multi-unit developments) share one register
  // ref, so a ref alone isn't a unique id. Count each ref, then suffix an index
  // when it repeats.
  const refCounts = new Map<string, number>();
  for (const r of rows) {
    const k = r.ref?.trim();
    if (k) refCounts.set(k, (refCounts.get(k) ?? 0) + 1);
  }
  const refSeen = new Map<string, number>();

  return rows.map((row) => {
    const ref = row.ref?.trim() || null;

    // Convert grid metres to lon/lat when both are valid, picking the grid by
    // magnitude (ITM eastings are ~600,000; Irish Grid ~200,000). Otherwise
    // leave null for the geocoder.
    let lat: number | null = null;
    let lon: number | null = null;
    let confidence: Site["geocode_confidence"] = "none";
    const e = Number(row.easting);
    const n = Number(row.northing);
    if (Number.isFinite(e) && Number.isFinite(n) && e > 0 && n > 0) {
      const conv = e >= 400000 ? itmToWgs84 : irishGridToWgs84;
      [lon, lat] = conv.forward([e, n]);
      lon = round6(lon);
      lat = round6(lat);
      confidence = "council";
    }

    let address = row.address?.trim() || (ref ? `Tipperary, register ref ${ref}` : "Tipperary");
    if (!/\btipperary\b/i.test(address)) address += ", Co. Tipperary";

    let id: string;
    if (ref) {
      const base = `tipperary-${slug(ref)}`;
      if ((refCounts.get(ref) ?? 0) > 1) {
        const i = (refSeen.get(ref) ?? 0) + 1;
        refSeen.set(ref, i);
        id = `${base}-${i}`;
      } else {
        id = base;
      }
    } else {
      id = `tipperary-${slug(address)}`;
    }

    return makeSite({
      id,
      council: COUNCIL,
      address,
      register_ref: ref,
      eircode: row.eircode?.trim() || null,
      date_entered: row.date_entered?.trim() || null,
      lat,
      lon,
      geocode_confidence: confidence,
      source_url: SOURCE_URL,
      retrieved: RETRIEVED,
    });
  });
}

// Run directly:  npx tsx pipeline/adapters/tipperary.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  load().then((sites) => {
    for (const s of sites) {
      const where = s.lat ? `${s.lat.toFixed(4)}, ${s.lon!.toFixed(4)}` : "(needs geocoding)";
      console.log(`${s.id.padEnd(18)} ${where.padEnd(22)} ${s.address}`);
    }
    const mapped = sites.filter((s) => s.lat !== null).length;
    console.log(`\n${sites.length} sites, ${mapped} with council coords, ${sites.length - mapped} need geocoding`);
  });
}
