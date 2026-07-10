import { writeFileSync, mkdirSync } from "node:fs";
import { makeSite, type Site } from "../schema";

// The canonical GeoJSON download for "Derelict Site Register DCC".
// It already ships point coordinates in plain lon/lat (EPSG:4326).
const GEOJSON_URL =
  "https://data.smartdublin.ie/dataset/" +
  "83b08920-50c6-45b0-b562-8f68940cadf4/resource/" +
  "7bdcf921-e0ed-4219-a4ac-2172e6b32dd9/download/" +
  "dublin_city_council_derelict_sites_register_260427.geojson";
// Human-facing dataset page (the GEOJSON_URL above is a direct file download).
const SOURCE_URL = "https://data.smartdublin.ie/dataset/83b08920-50c6-45b0-b562-8f68940cadf4";

const RAW_DIR = "data/raw/dublin_city";
const COUNCIL = "Dublin City";

// We read ONLY these fields. Owner and full_address hold personal data and
// are deliberately left untouched.
interface DccProps {
  derelict_site_reference_number?: string;
  derelict_site_description?: string;
  date_added_to_the_derelict_sites_register?: string;
  is_on_current_derelict_sites_register?: string;
}

export async function load(): Promise<Site[]> {
  const today = new Date().toISOString().slice(0, 10);

  // 1. Download.
  const resp = await fetch(GEOJSON_URL);
  if (!resp.ok) throw new Error(`DCC download failed: HTTP ${resp.status}`);
  const text = await resp.text();

  // 2. Archive the raw file, dated.
  mkdirSync(RAW_DIR, { recursive: true });
  writeFileSync(`${RAW_DIR}/${today}.geojson`, text);

  // 3. Parse and map each feature to a Site.
  const data = JSON.parse(text) as {
    features: { properties: DccProps; geometry: { coordinates: [number, number] } | null }[];
  };

  return data.features
    // Keep only sites still on the current register.
    .filter((f) => f.properties.is_on_current_derelict_sites_register === "Yes")
    .map((f, i) => {
      const p = f.properties;
      const ref = p.derelict_site_reference_number?.trim() || null;

      // Every DCC row carries coordinates, so this is effectively always set.
      let lat: number | null = null;
      let lon: number | null = null;
      let confidence: Site["geocode_confidence"] = "none";
      if (f.geometry && Array.isArray(f.geometry.coordinates)) {
        [lon, lat] = f.geometry.coordinates;    // GeoJSON is [lon, lat]
        confidence = "council";
      }

      return makeSite({
        id: ref ? `dcc-${ref}` : `dcc-row${i}`,
        council: COUNCIL,
        address: p.derelict_site_description?.trim() ?? "",
        register_ref: ref,
        date_entered: p.date_added_to_the_derelict_sites_register?.trim() || null,
        lat,
        lon,
        geocode_confidence: confidence,
        source_url: SOURCE_URL,
        retrieved: today,
      });
    });
}

// Run directly:  npx tsx pipeline/adapters/dublin_city.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  load().then((sites) => {
    for (const s of sites) {
      const where = s.lat ? `${s.lat.toFixed(4)}, ${s.lon!.toFixed(4)}` : "(needs geocoding)";
      console.log(`${s.id.padEnd(12)} ${where.padEnd(22)} ${s.address}`);
    }
    const geocoded = sites.filter((s) => s.lat !== null).length;
    console.log(`\n${sites.length} sites, ${geocoded} with coords, ${sites.length - geocoded} need geocoding`);
  });
}
