import { writeFileSync, mkdirSync } from "node:fs";
import { makeSite, type Site } from "../schema";

// Roscommon County Council publishes its register as a hosted ArcGIS layer.
// The features are polygons stored in Irish Transverse Mercator, but the layer's
// "geojson" output reprojects them to plain lon/lat (WGS84) for us, so every
// site maps precisely with no geocoding. We take each polygon's centroid as the
// pin. No owner/personal fields are exposed by the layer.
const ARCGIS_URL =
  "https://services1.arcgis.com/0g8o874l5un2eDgz/arcgis/rest/services/" +
  "DerelictSitesRegister/FeatureServer/0/query?where=1=1&outFields=*&f=geojson";
const RAW_DIR = "data/raw/roscommon";
const SOURCE_URL =
  "https://data-roscoco.opendata.arcgis.com/datasets/RosCoCo::derelict-sites-register-roscommon";
const COUNCIL = "Roscommon";
const RETRIEVED = "2026-07-10";

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

// "DS 2017/08" / "1992/36" -> "ds-2017-08" / "1992-36" for a clean id.
const slug = (r: string): string =>
  r.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// Average of a polygon's outer-ring vertices — good enough to drop a pin on.
// Handles both Polygon (coords[0] = outer ring) and MultiPolygon (coords[0][0]).
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

interface RosProps {
  OBJECTID?: number;
  DS_NUMBER?: string;
  TOWNLAND?: string;
  SITUATED_AT?: string;
  PARTICULARS_OF_SITE?: string;
}

export async function load(): Promise<Site[]> {
  const resp = await fetch(ARCGIS_URL);
  if (!resp.ok) throw new Error(`Roscommon ArcGIS fetch failed: HTTP ${resp.status}`);
  const text = await resp.text();

  mkdirSync(RAW_DIR, { recursive: true });
  writeFileSync(`${RAW_DIR}/${RETRIEVED}.geojson`, text);

  const data = JSON.parse(text) as {
    features: { properties: RosProps; geometry: { type: string; coordinates: any } | null }[];
  };

  // A couple of distinct sites share a register number in the source data, so a
  // ref alone isn't a unique id. Count how often each ref-slug occurs; where one
  // repeats, we disambiguate the id with the feature's OBJECTID below.
  const slugCounts = new Map<string, number>();
  for (const f of data.features) {
    const r = f.properties.DS_NUMBER?.trim();
    if (r) slugCounts.set(slug(r), (slugCounts.get(slug(r)) ?? 0) + 1);
  }

  return data.features.map((f, i) => {
    const p = f.properties;
    const ref = p.DS_NUMBER?.trim() || null;

    // Address = the specific location plus its townland, dropping duplicates
    // (many rural sites list the same value for both), then the county.
    const parts = [p.SITUATED_AT?.trim(), p.TOWNLAND?.trim()].filter(Boolean);
    const uniq = [...new Set(parts)];
    const address = uniq.length
      ? `${uniq.join(", ")}, Co. Roscommon`
      : `Roscommon — register ref ${ref}`;

    let lat: number | null = null;
    let lon: number | null = null;
    let confidence: Site["geocode_confidence"] = "none";
    const c = centroid(f.geometry);
    if (c) {
      [lon, lat] = c;
      confidence = "council";
    }

    // Clean ref-based id, suffixed with OBJECTID only when the ref isn't unique.
    const id = ref
      ? (slugCounts.get(slug(ref))! > 1 ? `roscommon-${slug(ref)}-${p.OBJECTID}` : `roscommon-${slug(ref)}`)
      : `roscommon-obj${p.OBJECTID ?? i}`;

    return makeSite({
      id,
      council: COUNCIL,
      address,
      register_ref: ref,
      description: p.PARTICULARS_OF_SITE?.trim() || null,
      lat,
      lon,
      geocode_confidence: confidence,
      source_url: SOURCE_URL,
      retrieved: RETRIEVED,
    });
  });
}

// Run directly:  npx tsx pipeline/adapters/roscommon.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  load().then((sites) => {
    for (const s of sites) {
      const where = s.lat ? `${s.lat.toFixed(4)}, ${s.lon!.toFixed(4)}` : "(needs geocoding)";
      console.log(`${s.id.padEnd(18)} ${where.padEnd(22)} ${s.address}`);
    }
    const mapped = sites.filter((s) => s.lat !== null).length;
    console.log(`\n${sites.length} sites, ${mapped} with coords, ${sites.length - mapped} need geocoding`);
  });
}
