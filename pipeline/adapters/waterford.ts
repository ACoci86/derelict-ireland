import { writeFileSync, mkdirSync } from "node:fs";
import { makeSite, type Site } from "../schema";

// Waterford City and County Council publishes its register as a hosted ArcGIS
// layer (its own org: waterford-ie). This is the council's "Public View", where
// owner data is already restricted, and the features are points in plain lon/lat
// (WGS84), so every site maps precisely with no geocoding. Sites the council has
// assessed as "Not Derelict" are dropped. We never read the owner field.
const ARCGIS_URL =
  "https://services-eu1.arcgis.com/eivETUtIaP8x2Pdh/arcgis/rest/services/" +
  "Derelict_Sites_Register_Public_View/FeatureServer/0/query?where=1=1&outFields=*&f=geojson";
const RAW_DIR = "data/raw/waterford";
const SOURCE_URL =
  "https://services-eu1.arcgis.com/eivETUtIaP8x2Pdh/arcgis/rest/services/Derelict_Sites_Register_Public_View/FeatureServer/0";
const COUNCIL = "Waterford";
const RETRIEVED = "2026-07-10";

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

// "DS25129" -> "ds25129" for a clean id.
const slug = (r: string): string =>
  r.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// The eircode column sometimes holds a folio/ref instead ("176/05"); keep only
// values that actually look like an eircode, spaced as "X91 DE0V".
function eircode(v: unknown): string | null {
  const s = String(v ?? "").trim().toUpperCase().replace(/\s+/g, "");
  return /^[A-Z]\d{2}[A-Z0-9]{4}$/.test(s) ? `${s.slice(0, 3)} ${s.slice(3)}` : null;
}

// "50000" / "0" / "" -> 50000 / null / null.
function money(v: unknown): number | null {
  const n = Number(String(v ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

interface WaterfordProps {
  objectid?: number;
  reference?: string;
  address?: string;
  eircode?: string;
  status?: string;
  currentmarketvalue?: string;
  // "owner" exists on the source (value "Restricted") but is not read.
}

export async function load(): Promise<Site[]> {
  const resp = await fetch(ARCGIS_URL);
  if (!resp.ok) throw new Error(`Waterford ArcGIS fetch failed: HTTP ${resp.status}`);
  const text = await resp.text();

  mkdirSync(RAW_DIR, { recursive: true });
  writeFileSync(`${RAW_DIR}/${RETRIEVED}.geojson`, text);

  const data = JSON.parse(text) as {
    features: { properties: WaterfordProps; geometry: { type: string; coordinates: [number, number] } | null }[];
  };

  // Drop sites the council concluded are not derelict.
  const features = data.features.filter(
    (f) => String(f.properties.status ?? "").trim().toLowerCase() !== "not derelict"
  );

  // Guard against a shared ref: count each ref-slug, disambiguate with objectid.
  const slugCounts = new Map<string, number>();
  for (const f of features) {
    const r = f.properties.reference?.trim();
    if (r) slugCounts.set(slug(r), (slugCounts.get(slug(r)) ?? 0) + 1);
  }

  return features.map((f, i) => {
    const p = f.properties;
    const ref = p.reference?.trim() || null;

    let address = p.address?.trim() || (ref ? `Waterford, register ref ${ref}` : "Waterford");
    if (!/\bwaterford\b/i.test(address)) address += ", Co. Waterford";

    // Points are already lon/lat; take them straight.
    let lat: number | null = null;
    let lon: number | null = null;
    let confidence: Site["geocode_confidence"] = "none";
    if (f.geometry && f.geometry.type === "Point") {
      [lon, lat] = f.geometry.coordinates;
      lon = round6(lon);
      lat = round6(lat);
      confidence = "council";
    }

    const id = ref
      ? (slugCounts.get(slug(ref))! > 1 ? `waterford-${slug(ref)}-${p.objectid}` : `waterford-${slug(ref)}`)
      : `waterford-obj${p.objectid ?? i}`;

    return makeSite({
      id,
      council: COUNCIL,
      address,
      register_ref: ref,
      eircode: eircode(p.eircode),
      valuation: money(p.currentmarketvalue),
      lat,
      lon,
      geocode_confidence: confidence,
      source_url: SOURCE_URL,
      retrieved: RETRIEVED,
    });
  });
}

// Run directly:  npx tsx pipeline/adapters/waterford.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  load().then((sites) => {
    for (const s of sites) {
      const where = s.lat ? `${s.lat.toFixed(4)}, ${s.lon!.toFixed(4)}` : "(needs geocoding)";
      const val = s.valuation ? `€${s.valuation}` : "";
      console.log(`${s.id.padEnd(14)} ${where.padEnd(22)} ${val.padEnd(9)} ${s.address}`);
    }
    const mapped = sites.filter((s) => s.lat !== null).length;
    console.log(`\n${sites.length} sites, ${mapped} with coords, ${sites.length - mapped} need geocoding`);
  });
}
