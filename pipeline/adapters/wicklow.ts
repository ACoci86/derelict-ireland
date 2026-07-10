import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { makeSite, type Site } from "../schema";

// Wicklow's register comes in two halves. pipeline/manual/wicklow_convert.ts
// scrapes the site details (ref, address, date, valuation) from the council's
// PDF into a committed CSV; the coordinates live separately in the council's
// ArcGIS layer, which we fetch here and join to the register on the reference
// number. The ArcGIS "geojson" output is already in lon/lat (WGS84), so a site
// with matching geometry maps precisely; anything not (yet) in the layer keeps
// lat/lon null and geocode.ts fills it in from the address.
const CSV_PATH = "data/manual/wicklow.csv";
const ARCGIS_URL =
  "https://services.arcgis.com/hQOfkHGHCu8mgDpG/arcgis/rest/services/" +
  "Derelict_Sites_Register/FeatureServer/16/query?where=1=1&outFields=*&f=geojson";
const RAW_DIR = "data/raw/wicklow";
const SOURCE_URL =
  "https://www.wicklow.ie/Living/Services/Planning/Derelict-Vacant-Sites/Derelict-Sites";
const COUNCIL = "Wicklow";
const RETRIEVED = "2026-07-10";    // date we downloaded the register PDF

// The register prints "DS/113"; the ArcGIS layer stores "DS113". Strip anything
// that isn't a letter or digit so the two line up.
const normRef = (r: string): string => r.replace(/[^A-Z0-9]/gi, "").toUpperCase();
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

// Average of a polygon's outer-ring vertices, good enough to drop a pin on.
function centroid(ring: [number, number][]): [number, number] {
  const n = ring.length;
  const [sx, sy] = ring.reduce(([x, y], [px, py]) => [x + px, y + py], [0, 0]);
  return [sx / n, sy / n];
}

async function fetchCoords(): Promise<Map<string, [number, number]>> {
  const resp = await fetch(ARCGIS_URL);
  if (!resp.ok) throw new Error(`Wicklow ArcGIS fetch failed: HTTP ${resp.status}`);
  const text = await resp.text();

  mkdirSync(RAW_DIR, { recursive: true });
  writeFileSync(`${RAW_DIR}/${RETRIEVED}.geojson`, text);

  const data = JSON.parse(text) as {
    features: { properties: { Derelict?: string }; geometry: { type: string; coordinates: number[][][] } | null }[];
  };

  const byRef = new Map<string, [number, number]>();
  for (const f of data.features) {
    const ref = f.properties.Derelict;
    if (!ref || !f.geometry || f.geometry.type !== "Polygon") continue;
    const [lon, lat] = centroid(f.geometry.coordinates[0] as [number, number][]);
    byRef.set(normRef(ref), [round6(lon), round6(lat)]);
  }
  return byRef;
}

export async function load(): Promise<Site[]> {
  const rows = parse(readFileSync(CSV_PATH, "utf8"), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];

  const coords = await fetchCoords();

  return rows.map((row) => {
    const ref = row.ref?.trim() || null;

    // Join to the ArcGIS coordinate on the reference; fall back to the geocoder.
    let lat: number | null = null;
    let lon: number | null = null;
    let confidence: Site["geocode_confidence"] = "none";
    const hit = ref ? coords.get(normRef(ref)) : undefined;
    if (hit) {
      [lon, lat] = hit;
      confidence = "council";
    }

    const valuation = Number(row.valuation);

    return makeSite({
      id: ref ? `wicklow-${normRef(ref)}` : `wicklow-row`,
      council: COUNCIL,
      address: row.address?.trim() || `Wicklow, register ref ${ref}`,
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

// Run directly:  npx tsx pipeline/adapters/wicklow.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  load().then((sites) => {
    for (const s of sites) {
      const where = s.lat ? `${s.lat.toFixed(4)}, ${s.lon!.toFixed(4)}` : "(needs geocoding)";
      console.log(`${s.id.padEnd(14)} ${where.padEnd(22)} ${s.address}`);
    }
    const mapped = sites.filter((s) => s.lat !== null).length;
    console.log(`\n${sites.length} sites, ${mapped} with coords, ${sites.length - mapped} need geocoding`);
  });
}
