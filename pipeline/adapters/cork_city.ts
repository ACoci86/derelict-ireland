import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { makeSite, type Site } from "../schema";

// Cork City's register comes in two halves. The committed CSV (scraped from the
// council's PDF by pipeline/manual/cork_convert.ts) is the source of record for
// references, addresses and dates. Coordinates live separately in the council's
// ArcGIS layer, which we fetch here and join to the register on the DSP number:
// a matching site gets a precise council pin and its market valuation, the rest
// keep lat/lon null so geocode.ts places them from the address.
//
// The ArcGIS layer also carries owner/occupier names (OwnName1/2/3, OccName).
// We deliberately never read them, the same as the Offaly and Dublin City
// adapters; only DSP, geometry and MktValue are read below.
const CSV_PATH = "data/manual/cork_city.csv";
const ARCGIS_URL =
  "https://services-eu1.arcgis.com/f0ZQOHXBIeLonX0V/arcgis/rest/services/" +
  "DerelictSites/FeatureServer/0/query?where=1=1&outFields=DSP,MktValue&f=geojson";
const RAW_DIR = "data/raw/cork_city";
const SOURCE_URL = "https://www.corkcity.ie/media/astd5t1p/derelict-sites-register.pdf";
const COUNCIL = "Cork City";
const RETRIEVED = "2026-07-09";    // date we converted the PDF
const ARCGIS_RETRIEVED = "2026-07-10";   // date we fetched the coordinate layer

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

// Match key: our ref "DSP-1520" and the layer's DSP "1520" both reduce to "1520".
const dspKey = (v: unknown): string => String(v ?? "").replace(/[^0-9]/g, "");

function money(v: unknown): number | null {
  const n = Number(String(v ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Average of a polygon's outer-ring vertices, good enough to drop a pin on.
function centroid(geom: { type: string; coordinates: any } | null): [number, number] | null {
  if (!geom) return null;
  const ring: [number, number][] =
    geom.type === "Polygon" ? geom.coordinates[0]
    : geom.type === "MultiPolygon" ? geom.coordinates[0][0]
    : null;
  if (!ring || !ring.length) return null;
  const [sx, sy] = ring.reduce(([x, y], [px, py]) => [x + px, y + py], [0, 0]);
  return [round6(sx / ring.length), round6(sy / ring.length)];
}

interface ArcgisMatch { lat: number; lon: number; valuation: number | null }

async function fetchArcgis(): Promise<Map<string, ArcgisMatch>> {
  const resp = await fetch(ARCGIS_URL);
  if (!resp.ok) throw new Error(`Cork City ArcGIS fetch failed: HTTP ${resp.status}`);
  const text = await resp.text();

  mkdirSync(RAW_DIR, { recursive: true });
  writeFileSync(`${RAW_DIR}/${ARCGIS_RETRIEVED}.geojson`, text);

  const data = JSON.parse(text) as {
    features: { properties: { DSP?: string | number; MktValue?: string | number };
                geometry: { type: string; coordinates: any } | null }[];
  };

  const byDsp = new Map<string, ArcgisMatch>();
  for (const f of data.features) {
    const key = dspKey(f.properties.DSP);
    const c = centroid(f.geometry);
    if (!key || !c) continue;
    byDsp.set(key, { lon: c[0], lat: c[1], valuation: money(f.properties.MktValue) });
  }
  return byDsp;
}

export async function load(): Promise<Site[]> {
  // 1. Read the committed CSV (the register: ref, address, date).
  const rows = parse(readFileSync(CSV_PATH, "utf8"), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];

  // 2. Fetch the coordinate layer and index it by DSP number.
  const coords = await fetchArcgis();

  // 3. Join. A DSP match gives council-precise coordinates + valuation; anything
  //    without a match keeps null coordinates for the geocoder, as before.
  return rows.map((row) => {
    const address = row.address?.trim() ?? "";
    const raw = row.ref?.trim();
    const ref = raw ? raw.replace(/\s+/g, "-") : null;   // "DSP 696" -> "DSP-696"

    let lat: number | null = null;
    let lon: number | null = null;
    let valuation: number | null = null;
    let confidence: Site["geocode_confidence"] = "none";
    const hit = ref ? coords.get(dspKey(ref)) : undefined;
    if (hit) {
      lat = hit.lat;
      lon = hit.lon;
      valuation = hit.valuation;
      confidence = "council";
    }

    return makeSite({
      id: ref ? `cork-${ref}` : `cork-${address}`,
      council: COUNCIL,
      address,
      register_ref: ref,
      date_entered: row.date_entered?.trim() || null,
      valuation,
      lat,
      lon,
      geocode_confidence: confidence,
      source_url: SOURCE_URL,
      retrieved: RETRIEVED,
    });
  });
}

// Run directly:  npx tsx pipeline/adapters/cork_city.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  load().then((sites) => {
    const mapped = sites.filter((s) => s.lat !== null).length;
    for (const s of sites) {
      const where = s.lat ? `${s.lat.toFixed(4)}, ${s.lon!.toFixed(4)}` : "(needs geocoding)";
      console.log(`${s.id.padEnd(14)} ${where.padEnd(22)} ${s.address}`);
    }
    console.log(`\n${sites.length} sites, ${mapped} joined to council coordinates, ${sites.length - mapped} need geocoding`);
  });
}
