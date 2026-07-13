import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import type { Site } from "./schema";

const CACHE_PATH = "data/cache/geocode.json";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
// Photon is a second OpenStreetMap-based geocoder, more tolerant of vague or
// partial addresses. We use it only as a fallback when Nominatim finds nothing.
const PHOTON_URL = "https://photon.komoot.io/api";

// Rough bounding box around the island of Ireland. Photon has no country filter
// (unlike Nominatim's countrycodes=ie), so we reject any result outside this.
const IE = { latMin: 51.3, latMax: 55.5, lonMin: -10.7, lonMax: -5.3 };

// The usage policy REQUIRES a User-Agent identifying the application.
// https://operations.osmfoundation.org/policies/nominatim/
const USER_AGENT = "derelict-ireland/0.1 (https://github.com/ACoci86/derelict-ireland)";

// A locality hint per council, added to the query so ambiguous street names
// (there's a "North Main Street" in both Cork and Wexford) resolve to the right
// place. Keep these short, "Cork", not "Cork City", which over-specifies and
// returns nothing.
const AREA_HINT: Record<string, string> = {
  "Cork City": "Cork",
  "Cork County": "County Cork",
  "Dublin City": "Dublin",
  "South Dublin": "Dublin",
  "Fingal": "Dublin",
  "Dún Laoghaire-Rathdown": "Dublin",
  "Limerick City and County": "County Limerick",
  "Wicklow": "County Wicklow",
  "Roscommon": "County Roscommon",
  "Meath": "County Meath",
  "Kilkenny": "County Kilkenny",
  "Offaly": "County Offaly",
  "Waterford": "County Waterford",
  "Kildare": "County Kildare",
  "Mayo": "County Mayo",
  "Tipperary": "County Tipperary",
  "Wexford": "County Wexford",
  "Louth": "County Louth",
  "Laois": "County Laois",
  "Westmeath": "County Westmeath",
  "Carlow": "County Carlow",
  "Monaghan": "County Monaghan",
  "Sligo": "County Sligo",
  "Leitrim": "County Leitrim",
  "Donegal": "County Donegal",
};

// Generous per-county bounding boxes [latMin, latMax, lonMin, lonMax]. A fuzzy
// geocoder can match a same-named street in the wrong county; we reject any
// result that lands outside the council's own county. Only councils whose sites
// are geocoded (no council-supplied coordinates) need an entry.
const COUNTY_BOX: Record<string, [number, number, number, number]> = {
  "Cork City": [51.7, 52.05, -8.7, -8.25],
  "Cork County": [51.4, 52.4, -10.3, -7.8],
  "Dublin City": [53.28, 53.45, -6.45, -6.1],
  "South Dublin": [53.18, 53.4, -6.6, -6.28],
  "Fingal": [53.35, 53.66, -6.4, -6.03],
  "Dún Laoghaire-Rathdown": [53.22, 53.32, -6.3, -6.03],
  "Kildare": [52.85, 53.5, -7.25, -6.45],
  "Mayo": [53.45, 54.35, -10.35, -8.85],
  "Wexford": [52.15, 52.9, -7.05, -6.1],
  "Louth": [53.7, 54.15, -6.75, -6.03],
  "Westmeath": [53.25, 53.8, -8.05, -7.05],
  "Carlow": [52.45, 52.95, -7.2, -6.45],
  "Sligo": [53.95, 54.5, -9.2, -8.15],
  "Leitrim": [53.75, 54.5, -8.5, -7.65],
  "Donegal": [54.4, 55.45, -8.9, -6.9],
  "Monaghan": [53.85, 54.45, -7.4, -6.5],
  "Limerick City and County": [52.3, 52.8, -9.4, -7.9],
  "Tipperary": [52.2, 53.2, -8.55, -7.3],
  "Wicklow": [52.6, 53.25, -6.7, -5.95],
  "Galway City": [53.05, 53.75, -10.35, -7.9],
};

// Nominatim's result "type" -> our honest confidence level.
const CONFIDENCE: Record<string, Site["geocode_confidence"]> = {
  house: "exact", building: "exact", residential: "street",
  road: "street", street: "street",
  town: "town", village: "town", suburb: "town",
  hamlet: "town", locality: "town", postcode: "town",
  administrative: "town",
};

interface NominatimHit {
  lat: string;
  lon: string;
  type: string;
}

// The cache maps a query string to a hit (or null = "we looked, found nothing").
type Cache = Record<string, NominatimHit | null>;

function loadCache(): Cache {
  if (existsSync(CACHE_PATH)) return JSON.parse(readFileSync(CACHE_PATH, "utf8"));
  return {};
}

function saveCache(cache: Cache): void {
  mkdirSync("data/cache", { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function queryNominatim(query: string): Promise<NominatimHit | null> {
  const url =
    `${NOMINATIM_URL}?q=${encodeURIComponent(query)}` +
    `&format=json&countrycodes=ie&limit=1`;
  const resp = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!resp.ok) throw new Error(`Nominatim HTTP ${resp.status}`);
  const results = (await resp.json()) as NominatimHit[];
  return results.length > 0 ? results[0] : null;
}

interface PhotonResponse {
  features?: { geometry: { coordinates: [number, number] }; properties: { type?: string } }[];
}

async function queryPhoton(query: string): Promise<NominatimHit | null> {
  // Bias results toward the middle of Ireland and take the top match.
  const url = `${PHOTON_URL}?q=${encodeURIComponent(query)}&limit=1&lang=en&lat=53.4&lon=-8.0`;
  const resp = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!resp.ok) throw new Error(`Photon HTTP ${resp.status}`);
  const f = ((await resp.json()) as PhotonResponse).features?.[0];
  if (!f) return null;
  const [lon, lat] = f.geometry.coordinates;
  if (lat < IE.latMin || lat > IE.latMax || lon < IE.lonMin || lon > IE.lonMax) return null;
  return { lat: String(lat), lon: String(lon), type: f.properties?.type ?? "" };
}

// Photon is a fuzzy fallback, so we cap its precision honestly: a house/street
// match counts as "street", anything coarser as "town".
function photonConfidence(type: string): Site["geocode_confidence"] {
  return type === "house" || type === "street" ? "street" : "town";
}

/**
 * Fill in lat/lon for any site that doesn't already have coordinates.
 * Mutates the sites in place. Council-supplied coordinates are left untouched.
 */
export async function geocodeAll(sites: Site[]): Promise<void> {
  const cache = loadCache();
  let liveCalls = 0;
  let photonHits = 0;

  for (const site of sites) {
    if (site.lat !== null) continue;            // tier 0: already has coordinates

    const hint = AREA_HINT[site.council];
    const query = hint
      ? `${site.address}, ${hint}, Ireland`
      : `${site.address}, Ireland`;

    let hit: NominatimHit | null;
    if (query in cache) {
      hit = cache[query];                       // tier 1: seen before, free
    } else {
      await sleep(1100);                        // tier 2: the 1-request-per-second rule
      hit = await queryNominatim(query);
      cache[query] = hit;
      saveCache(cache);                         // save after every call: a crash loses nothing
      liveCalls++;
    }

    // Fallback: when Nominatim finds nothing, try Photon (cached separately).
    let fromPhoton = false;
    if (!hit) {
      const pkey = `photon:${query}`;
      let phit: NominatimHit | null = null;
      if (pkey in cache) {
        phit = cache[pkey];
      } else {
        await sleep(1100);
        try {
          phit = await queryPhoton(query);
          cache[pkey] = phit;                   // only cache real answers, not errors
          saveCache(cache);
        } catch {
          phit = null;                          // transient error: retry next run
        }
        liveCalls++;
      }
      if (phit) { hit = phit; fromPhoton = true; photonHits++; }
    }

    // Reject a match that landed outside the council's own county.
    const box = COUNTY_BOX[site.council];
    if (hit && box) {
      const la = parseFloat(hit.lat), lo = parseFloat(hit.lon);
      if (la < box[0] || la > box[1] || lo < box[2] || lo > box[3]) {
        if (fromPhoton) photonHits--;
        hit = null;
      }
    }

    if (hit) {
      site.lon = Math.round(parseFloat(hit.lon) * 1e6) / 1e6;
      site.lat = Math.round(parseFloat(hit.lat) * 1e6) / 1e6;
      site.geocode_confidence = fromPhoton ? photonConfidence(hit.type) : (CONFIDENCE[hit.type] ?? "town");
    } else {
      site.geocode_confidence = "none";
    }
  }

  console.log(`geocoded: ${liveCalls} new lookups (${photonHits} placed by Photon), ${sites.length} sites checked`);
}