import { writeFileSync, mkdirSync } from "node:fs";
import { makeSite, type Site } from "../schema";

// Offaly County Council publishes its register as a hosted ArcGIS layer (its own
// org: offaly). The features are polygons; the layer's "geojson" output
// reprojects them to plain lon/lat (WGS84), so every site maps precisely with no
// geocoding. We take each polygon's centroid as the pin.
//
// This layer DOES expose an "Owner" field with personal names. We deliberately
// never read it: owner data is left out of this project entirely, the same as
// the Dublin City and Galway adapters. Only address/ref/date/valuation/eircode
// are read below. Sites no longer on the register are flagged On_DS_Reg = "No"
// and dropped.
const ARCGIS_URL =
  "https://services-eu1.arcgis.com/GoYdY5OITUvNLuuX/arcgis/rest/services/" +
  "Planning_Register_Editable/FeatureServer/16/query?where=1=1&outFields=*&f=geojson";
const RAW_DIR = "data/raw/offaly";
const SOURCE_URL =
  "https://services-eu1.arcgis.com/GoYdY5OITUvNLuuX/arcgis/rest/services/Planning_Register_Editable/FeatureServer/16";
const COUNCIL = "Offaly";
const RETRIEVED = "2026-07-10";

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

// "DS 86" -> "ds-86" for a clean id.
const slug = (r: string): string =>
  r.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// Date_Enter is a Unix epoch in milliseconds; keep just the ISO date.
function isoDate(ms: unknown): string | null {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString().slice(0, 10) : null;
}

// "320,000" / " " / "" -> 320000 / null / null.
function money(v: unknown): number | null {
  const n = Number(String(v ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Trim, treat the blank " " placeholder as empty, and space a bare 7-char code.
function eircode(v: unknown): string | null {
  const s = String(v ?? "").trim().toUpperCase();
  if (!s) return null;
  return /^[A-Z0-9]{7}$/.test(s) ? `${s.slice(0, 3)} ${s.slice(3)}` : s;
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

interface OffalyProps {
  FID?: number;
  Ref_No?: string;
  Address?: string;
  On_DS_Reg?: string;
  Date_Enter?: number;
  Current_Va?: string;
  Eircode?: string;
  // "Owner" exists on the source but is intentionally not declared or read.
}

export async function load(): Promise<Site[]> {
  const resp = await fetch(ARCGIS_URL);
  if (!resp.ok) throw new Error(`Offaly ArcGIS fetch failed: HTTP ${resp.status}`);
  const text = await resp.text();

  mkdirSync(RAW_DIR, { recursive: true });
  writeFileSync(`${RAW_DIR}/${RETRIEVED}.geojson`, text);

  const data = JSON.parse(text) as {
    features: { properties: OffalyProps; geometry: { type: string; coordinates: any } | null }[];
  };

  // Keep only sites currently on the register.
  const features = data.features.filter(
    (f) => String(f.properties.On_DS_Reg ?? "").trim().toLowerCase() === "yes"
  );

  // Guard against a shared ref: count each ref-slug, disambiguate with FID.
  const slugCounts = new Map<string, number>();
  for (const f of features) {
    const r = f.properties.Ref_No?.trim();
    if (r) slugCounts.set(slug(r), (slugCounts.get(slug(r)) ?? 0) + 1);
  }

  return features.map((f, i) => {
    const p = f.properties;
    const ref = p.Ref_No?.trim() || null;

    let address = p.Address?.trim() || (ref ? `Offaly, register ref ${ref}` : "Offaly");
    if (!/\boffaly\b/i.test(address)) address += ", Co. Offaly";

    let lat: number | null = null;
    let lon: number | null = null;
    let confidence: Site["geocode_confidence"] = "none";
    const c = centroid(f.geometry);
    if (c) {
      [lon, lat] = c;
      confidence = "council";
    }

    const id = ref
      ? (slugCounts.get(slug(ref))! > 1 ? `offaly-${slug(ref)}-${p.FID}` : `offaly-${slug(ref)}`)
      : `offaly-fid${p.FID ?? i}`;

    return makeSite({
      id,
      council: COUNCIL,
      address,
      register_ref: ref,
      eircode: eircode(p.Eircode),
      date_entered: isoDate(p.Date_Enter),
      valuation: money(p.Current_Va),
      lat,
      lon,
      geocode_confidence: confidence,
      source_url: SOURCE_URL,
      retrieved: RETRIEVED,
    });
  });
}

// Run directly:  npx tsx pipeline/adapters/offaly.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  load().then((sites) => {
    for (const s of sites) {
      const where = s.lat ? `${s.lat.toFixed(4)}, ${s.lon!.toFixed(4)}` : "(needs geocoding)";
      const val = s.valuation ? `€${s.valuation}` : "";
      console.log(`${s.id.padEnd(12)} ${where.padEnd(22)} ${(s.date_entered ?? "?").padEnd(11)} ${val.padEnd(9)} ${s.address}`);
    }
    const mapped = sites.filter((s) => s.lat !== null).length;
    console.log(`\n${sites.length} sites, ${mapped} with coords, ${sites.length - mapped} need geocoding`);
  });
}
