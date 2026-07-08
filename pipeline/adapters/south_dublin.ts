import { writeFileSync, mkdirSync } from "node:fs";
import { makeSite, type Site } from "../schema";

// The canonical GeoJSON download for "Derelict Sites Register SDCC".
// spatialRefId=4326 asks ArcGIS for plain lon/lat; where=1=1 means "all rows".
const GEOJSON_URL =
  "https://hub.arcgis.com/api/v3/datasets/" +
  "8ff1b797804145b1ae236d0a6ae98076_0/downloads/data" +
  "?format=geojson&spatialRefId=4326&where=1%3D1";

const RAW_DIR = "data/raw/south_dublin";
const COUNCIL = "South Dublin";

// We read ONLY these fields. Owner, Address_of_Owner, Occupier and Valuation
// are personal/sensitive data and are deliberately never touched.
interface SdccProps {
  DS_Ref?: string;
  Address_of_Property?: string;
  Section_8_7_Entered_on_to_Register?: string;
}

export async function load(): Promise<Site[]> {
  const today = new Date().toISOString().slice(0, 10);

  // 1. Download.
  const resp = await fetch(GEOJSON_URL);
  if (!resp.ok) throw new Error(`SDCC download failed: HTTP ${resp.status}`);
  const text = await resp.text();

  // 2. Archive the raw file, dated.
  mkdirSync(RAW_DIR, { recursive: true });
  writeFileSync(`${RAW_DIR}/${today}.geojson`, text);

  // 3. Parse and map each feature to a Site.
  const data = JSON.parse(text) as {
    features: { properties: SdccProps; geometry: { coordinates: [number, number] } | null }[];
  };

  return data.features.map((f, i) => {
    const p = f.properties;
    const ref = p.DS_Ref?.trim() || null;

    // Coordinates come from the GeoJSON geometry when present (19 of 25 rows).
    // The rest stay null and get geocoded later.
    let lat: number | null = null;
    let lon: number | null = null;
    let confidence: Site["geocode_confidence"] = "none";
    if (f.geometry && Array.isArray(f.geometry.coordinates)) {
      [lon, lat] = f.geometry.coordinates;    // GeoJSON is [lon, lat]
      confidence = "council";
    }

    return makeSite({
      id: ref ? `sdcc-${ref}` : `sdcc-row${i}`,
      council: COUNCIL,
      address: p.Address_of_Property?.trim() ?? "",
      register_ref: ref,
      date_entered: p.Section_8_7_Entered_on_to_Register?.trim() || null,
      lat,
      lon,
      geocode_confidence: confidence,
      source_url: GEOJSON_URL,
      retrieved: today,
    });
  });
}

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