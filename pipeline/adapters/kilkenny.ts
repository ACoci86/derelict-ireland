import { writeFileSync, mkdirSync } from "node:fs";
import { makeSite, type Site } from "../schema";

// Kilkenny County Council publishes its register as a hosted ArcGIS layer (its
// own org: kilkennycoco). The features are polygons; the layer's "geojson"
// output reprojects them to plain lon/lat (WGS84), so every site maps precisely
// with no geocoding. We take each polygon's centroid as the pin. The layer also
// holds sites no longer on the register, flagged OnDSReg = "N", which we drop.
// No owner/personal fields are exposed by the layer.
const ARCGIS_URL =
  "https://services-eu1.arcgis.com/ciqs2VrgJ6vG8Jqb/arcgis/rest/services/" +
  "Derelict_Sites/FeatureServer/0/query?where=1=1&outFields=*&f=geojson";
const RAW_DIR = "data/raw/kilkenny";
const SOURCE_URL =
  "https://services-eu1.arcgis.com/ciqs2VrgJ6vG8Jqb/arcgis/rest/services/Derelict_Sites/FeatureServer/0";
const COUNCIL = "Kilkenny";
const RETRIEVED = "2026-07-10";

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

// "03-26" -> "03-26" (already clean); lower-cased, non-alphanumerics collapsed.
const slug = (r: string): string =>
  r.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

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

interface KkProps {
  OBJECTID?: number;
  Address?: string;
  DS_ID?: string;
  OnDSReg?: string;   // "Y" = currently on the register
}

export async function load(): Promise<Site[]> {
  const resp = await fetch(ARCGIS_URL);
  if (!resp.ok) throw new Error(`Kilkenny ArcGIS fetch failed: HTTP ${resp.status}`);
  const text = await resp.text();

  mkdirSync(RAW_DIR, { recursive: true });
  writeFileSync(`${RAW_DIR}/${RETRIEVED}.geojson`, text);

  const data = JSON.parse(text) as {
    features: { properties: KkProps; geometry: { type: string; coordinates: any } | null }[];
  };

  // Keep only sites currently on the register.
  const features = data.features.filter((f) => f.properties.OnDSReg === "Y");

  // Guard against a shared id: count each ref-slug, disambiguate with OBJECTID.
  const slugCounts = new Map<string, number>();
  for (const f of features) {
    const r = f.properties.DS_ID?.trim();
    if (r) slugCounts.set(slug(r), (slugCounts.get(slug(r)) ?? 0) + 1);
  }

  return features.map((f, i) => {
    const p = f.properties;
    const ref = p.DS_ID?.trim() || null;

    let address = p.Address?.trim() || (ref ? `Kilkenny, register ref ${ref}` : "Kilkenny");
    if (!/\bkilkenny\b/i.test(address)) address += ", Co. Kilkenny";

    let lat: number | null = null;
    let lon: number | null = null;
    let confidence: Site["geocode_confidence"] = "none";
    const c = centroid(f.geometry);
    if (c) {
      [lon, lat] = c;
      confidence = "council";
    }

    const id = ref
      ? (slugCounts.get(slug(ref))! > 1 ? `kilkenny-${slug(ref)}-${p.OBJECTID}` : `kilkenny-${slug(ref)}`)
      : `kilkenny-obj${p.OBJECTID ?? i}`;

    return makeSite({
      id,
      council: COUNCIL,
      address,
      register_ref: ref,
      lat,
      lon,
      geocode_confidence: confidence,
      source_url: SOURCE_URL,
      retrieved: RETRIEVED,
    });
  });
}

// Run directly:  npx tsx pipeline/adapters/kilkenny.ts
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
