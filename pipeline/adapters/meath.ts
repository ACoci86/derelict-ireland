import { writeFileSync, mkdirSync } from "node:fs";
import { makeSite, type Site } from "../schema";

// Meath County Council publishes its register as a hosted ArcGIS layer (its own
// GIS office: gisoff@meathcoco.ie). The features are polygons; the layer's
// "geojson" output reprojects them to plain lon/lat (WGS84), so every site maps
// precisely with no geocoding. We take each polygon's centroid as the pin. No
// owner/personal fields are exposed by the layer.
const ARCGIS_URL =
  "https://services-eu1.arcgis.com/33tCl0taHHdVAN9O/arcgis/rest/services/" +
  "DerelictSitesRegister/FeatureServer/0/query?where=1=1&outFields=*&f=geojson";
const RAW_DIR = "data/raw/meath";
const SOURCE_URL =
  "https://services-eu1.arcgis.com/33tCl0taHHdVAN9O/arcgis/rest/services/DerelictSitesRegister/FeatureServer/0";
const COUNCIL = "Meath";
const RETRIEVED = "2026-07-10";

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

// "DS-1024" -> "ds-1024" for a clean id.
const slug = (r: string): string =>
  r.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// Date_Enter is a Unix epoch in milliseconds; keep just the ISO date.
function isoDate(ms: unknown): string | null {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString().slice(0, 10) : null;
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

interface MeathProps {
  OBJECTID?: number;
  Reference?: string;
  Derelict_S?: string;   // the site address / description
  MunicipalD?: string;   // municipal district
  Date_Enter?: number;   // epoch millis
}

export async function load(): Promise<Site[]> {
  const resp = await fetch(ARCGIS_URL);
  if (!resp.ok) throw new Error(`Meath ArcGIS fetch failed: HTTP ${resp.status}`);
  const text = await resp.text();

  mkdirSync(RAW_DIR, { recursive: true });
  writeFileSync(`${RAW_DIR}/${RETRIEVED}.geojson`, text);

  const data = JSON.parse(text) as {
    features: { properties: MeathProps; geometry: { type: string; coordinates: any } | null }[];
  };

  // A couple of distinct sites can share a register number in the source data,
  // so a ref alone isn't a unique id. Count how often each ref-slug occurs;
  // where one repeats, we disambiguate the id with the OBJECTID below.
  const slugCounts = new Map<string, number>();
  for (const f of data.features) {
    const r = f.properties.Reference?.trim();
    if (r) slugCounts.set(slug(r), (slugCounts.get(slug(r)) ?? 0) + 1);
  }

  return data.features.map((f, i) => {
    const p = f.properties;
    const ref = p.Reference?.trim() || null;

    // The council's own address text; add the county when it isn't already there.
    let address = p.Derelict_S?.trim() || (ref ? `Meath, register ref ${ref}` : "Meath");
    if (!/\bmeath\b/i.test(address)) address += ", Co. Meath";

    let lat: number | null = null;
    let lon: number | null = null;
    let confidence: Site["geocode_confidence"] = "none";
    const c = centroid(f.geometry);
    if (c) {
      [lon, lat] = c;
      confidence = "council";
    }

    const id = ref
      ? (slugCounts.get(slug(ref))! > 1 ? `meath-${slug(ref)}-${p.OBJECTID}` : `meath-${slug(ref)}`)
      : `meath-obj${p.OBJECTID ?? i}`;

    return makeSite({
      id,
      council: COUNCIL,
      address,
      register_ref: ref,
      date_entered: isoDate(p.Date_Enter),
      lat,
      lon,
      geocode_confidence: confidence,
      source_url: SOURCE_URL,
      retrieved: RETRIEVED,
    });
  });
}

// Run directly:  npx tsx pipeline/adapters/meath.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  load().then((sites) => {
    for (const s of sites) {
      const where = s.lat ? `${s.lat.toFixed(4)}, ${s.lon!.toFixed(4)}` : "(needs geocoding)";
      console.log(`${s.id.padEnd(14)} ${where.padEnd(22)} ${s.date_entered ?? "?"}  ${s.address}`);
    }
    const mapped = sites.filter((s) => s.lat !== null).length;
    console.log(`\n${sites.length} sites, ${mapped} with coords, ${sites.length - mapped} need geocoding`);
  });
}
