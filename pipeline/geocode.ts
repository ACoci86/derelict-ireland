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

// --- Gemini address cleaner (optional third tier) ---------------------------
// When both OSM geocoders fail, we ask Google's free Gemini model to rewrite a
// messy register address into a clean "street, town, county" query, then feed
// THAT back through Nominatim/Photon. The model never supplies coordinates - a
// real geocoder still places the point, and the county-box guard still applies.
// Skipped entirely if no GEMINI_API_KEY is set.
const GEMINI_MODEL = "gemini-flash-lite-latest";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const GEMINI_CACHE_PATH = "data/cache/gemini.json";

// Read GEMINI_API_KEY from the environment, or from a local .env if not set.
function geminiKey(): string {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  try {
    for (const line of readFileSync(".env", "utf8").split("\n")) {
      const m = line.match(/^\s*GEMINI_API_KEY\s*=\s*(.+?)\s*$/);
      if (m) return m[1].replace(/^["']|["']$/g, "");
    }
  } catch { /* no .env file */ }
  return "";
}

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

// The Gemini cache maps a "county||address" key to a cleaned query (or null =
// "the model judged this unlocatable"). Separate file from the geocode cache.
type GeminiCache = Record<string, string | null>;

function loadGeminiCache(): GeminiCache {
  if (existsSync(GEMINI_CACHE_PATH)) return JSON.parse(readFileSync(GEMINI_CACHE_PATH, "utf8"));
  return {};
}

function saveGeminiCache(c: GeminiCache): void {
  mkdirSync("data/cache", { recursive: true });
  writeFileSync(GEMINI_CACHE_PATH, JSON.stringify(c, null, 2));
}

// Ask Gemini to rewrite one messy address into a geocodable query. Returns the
// cleaned query, or null if the model judged it unlocatable. Throws "429" on a
// quota/rate-limit response so the caller can back off.
async function queryGemini(key: string, address: string, county: string): Promise<string | null> {
  const prompt =
    `You clean messy addresses from an Irish council's Derelict Sites Register so ` +
    `a geocoder (OpenStreetMap) can find them${county ? ` (this one is in ${county})` : ""}. ` +
    `KEEP as much of the real postal address as possible: house/street numbers, ALL ` +
    `street names, the town, the county, and the Eircode if present. Only REMOVE text ` +
    `that is not part of a postal address: descriptive phrases ("Derelict House", ` +
    `"Site at", "Property at", "Vacant"), building or business names ("Lamberts ` +
    `Hardware", "Capri Bungalow"), and bracketed asides ("(beside X)"). A leading ` +
    `COUNT of properties ("3 Derelict Houses on Main Street", "2 Vacant Sites at X") ` +
    `is not a house number - drop the count and its noun, keeping just the street. If ` +
    `several house numbers are listed for one street, keep only the first. Do not invent ` +
    `detail. If nothing mappable remains (a bare townland or nothing usable), reply ` +
    `exactly UNLOCATABLE. Reply with ONLY the cleaned address, no other words.` +
    `\n\nAddress: ${address}`;
  const resp = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 256 },
    }),
  });
  if (resp.status === 429) throw new Error("429");
  if (!resp.ok) throw new Error(`Gemini HTTP ${resp.status}`);
  const data = (await resp.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = (data.candidates?.[0]?.content?.parts?.[0]?.text ?? "").replace(/\s+/g, " ").trim();
  if (!text || /^UNLOCATABLE\b/i.test(text)) return null;
  return text;
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
    if (hit && fromPhoton) photonHits++;

    if (hit) {
      site.lon = Math.round(parseFloat(hit.lon) * 1e6) / 1e6;
      site.lat = Math.round(parseFloat(hit.lat) * 1e6) / 1e6;
      site.geocode_confidence = fromPhoton ? photonConfidence(hit.type) : (CONFIDENCE[hit.type] ?? "town");
    } else {
      site.geocode_confidence = "none";
    }
  }

  console.log(`geocoded: ${counters.live} new lookups (${photonHits} Photon), ${sites.length} sites checked`);
}

// A proposed placement for a site the OSM geocoders couldn't map, produced by
// the Gemini cleaner. These are NOT put on the map - they're written to a review
// file so a human can eyeball each one and drop the bad ones before they go live.
export interface GeminiProposal {
  id: string;
  council: string;
  register_ref: string | null;
  eircode: string | null;
  address: string;                // the original register address
  cleaned: string;                // Gemini's cleaned query
  lat: number;
  lon: number;
  confidence: Site["geocode_confidence"];
}

/**
 * For every site the OSM geocoders left unplaced, ask Gemini to clean the
 * address, geocode the clean version, and (if it lands in the right county)
 * record it as a PROPOSAL. Does not mutate the sites - the caller decides what
 * to do with the proposals. Skipped entirely if there is no GEMINI_API_KEY.
 */
export async function proposeGemini(sites: Site[]): Promise<GeminiProposal[]> {
  const key = geminiKey();
  if (!key) { console.log("Gemini: no API key set, skipping proposals"); return []; }

  const cache = loadCache();
  const geminiCache = loadGeminiCache();
  const counters = { live: 0 };
  const proposals: GeminiProposal[] = [];
  let geminiOn = true;

  for (const site of sites) {
    if (site.lat !== null) continue;            // already mapped by the OSM geocoders
    if (!geminiOn) break;                        // quota gone: stop, resume next run

    const hint = AREA_HINT[site.council];
    const county = hint ?? site.council;
    const box = COUNTY_BOX[site.council];
    const gkey = `${county}||${site.address}`;

    let cleaned: string | null = null;
    if (gkey in geminiCache) {
      cleaned = geminiCache[gkey];
    } else {
      // Pace under the free tier's ~15 requests/minute limit; on a rate-limit
      // response wait a minute and retry rather than giving up immediately.
      for (let attempt = 0; attempt < 3 && geminiOn; attempt++) {
        await sleep(4500);
        try {
          cleaned = await queryGemini(key, site.address, county);
          geminiCache[gkey] = cleaned;
          saveGeminiCache(geminiCache);
          break;
        } catch (e) {
          if (String(e).includes("429") && attempt < 2) {
            console.log("Gemini: rate limit, waiting 60s...");
            await sleep(60000);
            continue;
          }
          if (String(e).includes("429")) { geminiOn = false; console.log("Gemini: quota exhausted, stopping for this run"); }
          cleaned = null;
          break;
        }
      }
    }
    if (!cleaned) continue;

    const r = await geocodeQuery(`${cleaned}, Ireland`, cache, counters);
    if (r.hit && inCounty(r.hit, box)) {
      proposals.push({
        id: site.id,
        council: site.council,
        register_ref: site.register_ref,
        eircode: site.eircode,
        address: site.address,
        cleaned,
        lat: Math.round(parseFloat(r.hit.lat) * 1e6) / 1e6,
        lon: Math.round(parseFloat(r.hit.lon) * 1e6) / 1e6,
        confidence: photonConfidence(r.hit.type),
      });
    }
  }

  console.log(`Gemini proposals: ${proposals.length} placed (${counters.live} geocoder lookups)`);
  return proposals;
}