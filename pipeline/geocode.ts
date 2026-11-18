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
  class?: string;
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

// One query through Nominatim, then Photon as a fallback. Returns the hit (or
// null) and whether Photon produced it. Mutates and persists the shared cache.
async function geocodeQuery(
  query: string,
  cache: Cache,
  counters: { live: number },
): Promise<{ hit: NominatimHit | null; fromPhoton: boolean }> {
  let hit: NominatimHit | null;
  if (query in cache) {
    hit = cache[query];
  } else {
    await sleep(1100);
    hit = await queryNominatim(query);
    cache[query] = hit;
    saveCache(cache);
    counters.live++;
  }

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
        cache[pkey] = phit;
        saveCache(cache);
      } catch {
        phit = null;
      }
      counters.live++;
    }
    if (phit) { hit = phit; fromPhoton = true; }
  }
  return { hit, fromPhoton };
}

// ---------------------------------------------------------------------------
// Town check for Photon hits. Photon is fuzzy: given "Main Street, Ringaskiddy"
// it returned a Main Street near the Limerick border, which is still inside the
// Cork county box. So a Photon hit must also lie near a town or townland that
// the address names. If it doesn't, the site goes to that place instead,
// marked as placed to the town only. (Run over the November 2026 data, it
// moved 57 of the 371 Photon-placed sites, some by 60 to 100 km.)
// ---------------------------------------------------------------------------
const NEAR_KM = 5;        // a hit this close to a named place is accepted
const SAME_AREA_KM = 25;  // a named place this close to the postal town is the same area

// The county a council is in, for place lookups ("Kinnegad, County Westmeath").
const COUNTY_OF: Record<string, string> = {
  "Cork City": "Cork",
  "Cork County": "Cork",
  "Dublin City": "Dublin",
  "South Dublin": "Dublin",
  "Fingal": "Dublin",
  "Dún Laoghaire-Rathdown": "Dublin",
  "Limerick City and County": "Limerick",
  "Galway City": "Galway",
};
const countyOf = (council: string) => COUNTY_OF[council] ?? council;

// Address parts that are streets, buildings or directions, not places.
const STREETY =
  /\b(street|st\.?|road|rd\.?|terrace|tce\.?|lane|avenue|ave|place|row|hill|park|square|sq|close|court|drive|crescent|grove|lawn|view|cottage|house|apartments?|estate|mill|bungalow|convent|dispensary|quay|mall|walk|way|green|heights|centre|site|church|school|hall|adjacent|rear|end|west|east|north|south|upper|lower|main)\b/i;

/**
 * The places an address names, most specific first: "Steelaun, Rathfran,
 * Carrowmore Lacken, Ballina, Co Mayo" -> Steelaun, Rathfran, Carrowmore
 * Lacken, Ballina. Streets, house names, Eircodes and the county are dropped,
 * and so is a part that is just the county's name ("Tullylannon Td., Leitrim"
 * could mean Leitrim village or County Leitrim).
 */
export function namedPlaces(address: string, council: string): string[] {
  const county = countyOf(council).toLowerCase();
  return address
    .split(",")
    .map((p) =>
      p
        .trim()
        .replace(/\s+(co\.?|county)\s+\w+.*$/i, "")
        .replace(/\s+[A-Z]\d{2}(\s?[A-Z0-9]{4})?$/i, "")
        .replace(/\s+(td\.?|village)$/i, "")
        .replace(/^"|"$/g, "")
        .trim(),
    )
    .filter(
      (p) =>
        p &&
        !/^(co\.?|county)\s/i.test(p) &&
        !/^[A-Z]\d{2}/i.test(p) &&
        !/\d/.test(p) &&
        !STREETY.test(p) &&
        p.toLowerCase() !== county,
    );
}

const PLACE_TYPES = new Set([
  "city", "town", "village", "hamlet", "townland", "locality", "suburb", "neighbourhood",
  "isolated_dwelling", "administrative", "island",
]);
const isPlace = (h: NominatimHit | null) => !!h && (h.class === "place" || h.class === "boundary" || PLACE_TYPES.has(h.type));

// Look a place up by name. A plain search can return a shop or a bus stop of
// that name ("Kilbeggan" -> the distillery), so if it isn't a place, ask again
// for settlements only. Both lookups are cached. Returns undefined if
// Nominatim couldn't be reached (busy or down), so the caller can leave the
// site alone this run and try again next time.
async function lookupPlace(
  name: string,
  council: string,
  cache: Cache,
  counters: { live: number },
): Promise<NominatimHit | null | undefined> {
  const q = `${name}, County ${countyOf(council)}, Ireland`;
  for (const [key, extra] of [[`place:${q}`, ""], [`settlement:${q}`, "&featureType=settlement"]] as const) {
    if (!(key in cache)) {
      const url = `${NOMINATIM_URL}?q=${encodeURIComponent(q)}&format=json&countrycodes=ie&limit=1${extra}`;
      let results: NominatimHit[] | null = null;
      for (const wait of [1100, 10_000]) {
        await sleep(wait);
        try {
          const resp = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
          if (resp.ok) {
            results = (await resp.json()) as NominatimHit[];
            break;
          }
        } catch {
          // network error: retry once, then give up for this run
        }
      }
      counters.live++;
      if (!results) return undefined;
      const r = results[0];
      cache[key] = r ? { lat: r.lat, lon: r.lon, type: r.type, class: r.class } : null;
      saveCache(cache);
    }
    if (isPlace(cache[key])) return cache[key];
  }
  return null;
}

function km(a: NominatimHit, b: NominatimHit): number {
  const t = Math.PI / 180;
  const [la1, lo1, la2, lo2] = [a.lat, a.lon, b.lat, b.lon].map(parseFloat);
  const h = Math.sin(((la2 - la1) * t) / 2) ** 2 + Math.cos(la1 * t) * Math.cos(la2 * t) * Math.sin(((lo2 - lo1) * t) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/**
 * Check a Photon hit against the places its address names. Returns the hit
 * if it is near one of them (or if none of them can be found), otherwise the
 * most specific named place that agrees with the postal town.
 */
export async function townCheck(
  address: string,
  council: string,
  hit: NominatimHit,
  cache: Cache,
  counters: { live: number },
): Promise<{ hit: NominatimHit; moved: string | null }> {
  const found: { name: string; place: NominatimHit; d: number }[] = [];
  for (const name of namedPlaces(address, council)) {
    const place = await lookupPlace(name, council, cache, counters);
    if (place === undefined) return { hit, moved: null }; // can't check now; next run will
    if (place) found.push({ name, place, d: km(hit, place) });
  }
  if (!found.length || found.some((f) => f.d <= NEAR_KM)) return { hit, moved: null };
  const town = found[found.length - 1];
  const pick = found.find((f) => km(f.place, town.place) <= SAME_AREA_KM) ?? town;
  return { hit: { ...pick.place, type: "town" }, moved: pick.name };
}

// Is a hit inside the council's own county box? (True when there's no box.)
function inCounty(hit: NominatimHit, box?: [number, number, number, number]): boolean {
  if (!box) return true;
  const la = parseFloat(hit.lat), lo = parseFloat(hit.lon);
  return la >= box[0] && la <= box[1] && lo >= box[2] && lo <= box[3];
}

/**
 * Fill in lat/lon for any site that doesn't already have coordinates.
 * Mutates the sites in place. Council-supplied coordinates are left untouched.
 */
export async function geocodeAll(sites: Site[]): Promise<void> {
  const cache = loadCache();
  const counters = { live: 0 };
  let photonHits = 0;
  let movedToTown = 0;

  for (const site of sites) {
    if (site.lat !== null) continue;            // tier 0: already has coordinates

    const hint = AREA_HINT[site.council];
    const box = COUNTY_BOX[site.council];
    const query = hint
      ? `${site.address}, ${hint}, Ireland`
      : `${site.address}, Ireland`;

    // Nominatim, then Photon as a fallback, on the raw address.
    let { hit, fromPhoton } = await geocodeQuery(query, cache, counters);
    if (hit && !inCounty(hit, box)) { hit = null; fromPhoton = false; }
    let moved: string | null = null;
    if (hit && fromPhoton) {
      photonHits++;
      ({ hit, moved } = await townCheck(site.address, site.council, hit, cache, counters));
      if (moved) movedToTown++;
    }

    if (hit) {
      site.lon = Math.round(parseFloat(hit.lon) * 1e6) / 1e6;
      site.lat = Math.round(parseFloat(hit.lat) * 1e6) / 1e6;
      site.geocode_confidence = moved ? "town" : fromPhoton ? photonConfidence(hit.type) : (CONFIDENCE[hit.type] ?? "town");
    } else {
      site.geocode_confidence = "none";
    }
  }

  console.log(
    `geocoded: ${counters.live} new lookups (${photonHits} Photon, ${movedToTown} of them moved to the town ` +
      `their address names), ${sites.length} sites checked`,
  );
}
