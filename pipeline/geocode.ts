import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import type { Site } from "./schema";

const CACHE_PATH = "data/cache/geocode.json";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

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

/**
 * Fill in lat/lon for any site that doesn't already have coordinates.
 * Mutates the sites in place. Council-supplied coordinates are left untouched.
 */
export async function geocodeAll(sites: Site[]): Promise<void> {
  const cache = loadCache();
  let liveCalls = 0;

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

    if (hit) {
      site.lon = Math.round(parseFloat(hit.lon) * 1e6) / 1e6;
      site.lat = Math.round(parseFloat(hit.lat) * 1e6) / 1e6;
      site.geocode_confidence = CONFIDENCE[hit.type] ?? "town";
    } else {
      site.geocode_confidence = "none";
    }
  }

  console.log(`geocoded: ${liveCalls} new lookups, ${sites.length} sites checked`);
}