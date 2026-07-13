import { writeFileSync, mkdirSync } from "node:fs";
import { toFeature, type Site } from "./schema";
import { load as loadDlr } from "./adapters/dlr";
import { load as loadSouthDublin } from "./adapters/south_dublin";
import { load as loadFingal } from "./adapters/fingal";
import { load as loadDublinCity } from "./adapters/dublin_city";
import { load as loadCorkCity } from "./adapters/cork_city";
import { load as loadCorkCounty } from "./adapters/cork_county";
import { load as loadGalway } from "./adapters/galway";
import { load as loadLimerick } from "./adapters/limerick";
import { load as loadWicklow } from "./adapters/wicklow";
import { load as loadRoscommon } from "./adapters/roscommon";
import { load as loadMeath } from "./adapters/meath";
import { load as loadKilkenny } from "./adapters/kilkenny";
import { load as loadOffaly } from "./adapters/offaly";
import { load as loadWaterford } from "./adapters/waterford";
import { load as loadKildare } from "./adapters/kildare";
import { load as loadMayo } from "./adapters/mayo";
import { load as loadTipperary } from "./adapters/tipperary";
import { load as loadWexford } from "./adapters/wexford";
import { load as loadLouth } from "./adapters/louth";
import { load as loadLaois } from "./adapters/laois";
import { load as loadWestmeath } from "./adapters/westmeath";
import { load as loadCarlow } from "./adapters/carlow";
import { load as loadMonaghan } from "./adapters/monaghan";
import { load as loadSligo } from "./adapters/sligo";
import { load as loadLeitrim } from "./adapters/leitrim";
import { load as loadDonegal } from "./adapters/donegal";
import { geocodeAll, proposeGemini } from "./geocode";

// Rough bounding box around the island of Ireland.
const LAT_MIN = 51.3, LAT_MAX = 55.5;
const LON_MIN = -10.7, LON_MAX = -5.3;

const ADAPTERS = [loadDlr, loadSouthDublin, loadFingal, loadDublinCity, loadCorkCity, loadCorkCounty, loadGalway, loadLimerick, loadWicklow, loadRoscommon, loadMeath, loadKilkenny, loadOffaly, loadWaterford, loadKildare, loadMayo, loadTipperary, loadWexford, loadLouth, loadLaois, loadWestmeath, loadCarlow, loadMonaghan, loadSligo, loadLeitrim, loadDonegal];   // every new council adds one entry here

function inIreland(s: Site): boolean {
  return (
    s.lat !== null && s.lon !== null &&
    s.lat >= LAT_MIN && s.lat <= LAT_MAX &&
    s.lon >= LON_MIN && s.lon <= LON_MAX
  );
}

// A single register entry can list several properties on one street, e.g.
// "6, 8, 8A, 10 & 12 Bridge Street, Balbriggan". Those are distinct addresses,
// so we split them into one site per number ("6 Bridge Street, …", "8 Bridge
// Street, …") before geocoding, each with a suffixed id but the same register
// reference. Addresses with a single number, a range ("6-12"), or no leading
// number pass through unchanged.
const MULTI_UNIT = /^\s*(?:Nos?\.?\s+)?(\d+[A-Za-z]?(?:\s*(?:,|&|and|\+)\s*\d+[A-Za-z]?)+)\s+(\D.*)$/i;
function expandMultiUnit(site: Site): Site[] {
  const m = site.address.match(MULTI_UNIT);
  if (!m) return [site];
  const nums = m[1].split(/\s*(?:,|&|and|\+)\s*/i).map((n) => n.trim()).filter(Boolean);
  if (nums.length < 2 || nums.length > 12) return [site];   // guard against odd matches
  const rest = m[2].trim();
  // The entry lists one valuation for all the properties together, so keep it on
  // the first split only - otherwise the per-council total counts it N times.
  return nums.map((n, i) => ({
    ...site,
    id: `${site.id}-${n.replace(/\s+/g, "")}`,
    address: `${n} ${rest}`,
    valuation: i === 0 ? site.valuation : null,
  }));
}

async function main() {
  const all: Site[] = [];
  for (const load of ADAPTERS) {
    const sites = await load();
    console.log(`${sites.length} sites loaded`);
    all.push(...sites);
  }

  // Split multi-property entries ("6, 8 & 10 Main Street") into one site each.
  const sites = all.flatMap(expandMultiUnit);
  const split = sites.length - all.length;
  if (split > 0) console.log(`split ${split} extra sites from multi-property entries`);

  // Guard against valuation parse errors: no derelict site is worth over 50m,
  // so anything above that (one Mayo entry lists ~40 trillion) is bad data.
  for (const s of sites) {
    if (s.valuation !== null && (s.valuation <= 0 || s.valuation > 50_000_000)) {
      s.valuation = null;
    }
  }

  await geocodeAll(sites);         // fill in coordinates for sites that lack them

  const good = sites.filter(inIreland);
  const review = sites.filter((s) => !inIreland(s));

  // For the sites the OSM geocoders couldn't place, ask Gemini for proposed
  // placements and write them to a review file. These are NOT put on the map -
  // they're for manual filtering; approved ones get applied in a later step.
  const proposals = await proposeGemini(sites);
  if (proposals.length > 0) {
    const esc = (v: string) => `"${String(v).replace(/"/g, '""')}"`;
    const header = "council,register_ref,eircode,id,original_address,cleaned_query,lat,lon,confidence,check_on_map";
    const rows = proposals.map((p) =>
      [p.council, p.register_ref ?? "", p.eircode ?? "", p.id, p.address, p.cleaned, p.lat, p.lon, p.confidence,
        `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon}#map=18/${p.lat}/${p.lon}`]
        .map((v) => esc(String(v))).join(",")
    );
    mkdirSync("data/manual", { recursive: true });
    writeFileSync("data/manual/gemini-proposed.csv", [header, ...rows].join("\n") + "\n");
    console.log(`wrote ${proposals.length} Gemini proposals to data/manual/gemini-proposed.csv (review, then approve)`);
  }

  mkdirSync("public", { recursive: true });
  writeFileSync(
    "public/sites.geojson",
    JSON.stringify({ type: "FeatureCollection", features: good.map(toFeature) })
  );

  // Small stats file so the landing page can show counts the geojson can't,
  // e.g. how many sites we couldn't place on the map (held for review), and a
  // per-council breakdown for the coverage table.
  const byCouncil = new Map<string, { mapped: number; review: number }>();
  const bump = (council: string, key: "mapped" | "review") => {
    const e = byCouncil.get(council) ?? { mapped: 0, review: 0 };
    e[key]++;
    byCouncil.set(council, e);
  };
  for (const s of good) bump(s.council, "mapped");
  for (const s of review) bump(s.council, "review");

  // Total valuation per council (where the register publishes site values), and
  // how many sites that total is based on. Councils that publish none get 0.
  const valByCouncil = new Map<string, { total: number; count: number }>();
  for (const s of sites) {
    if (!s.valuation) continue;
    const e = valByCouncil.get(s.council) ?? { total: 0, count: 0 };
    e.total += s.valuation;
    e.count++;
    valByCouncil.set(s.council, e);
  }

  // Where each council's data comes from, for the coverage table's Source link.
  const sourceByCouncil = new Map<string, string>();
  for (const s of all) {
    if (s.source_url && !sourceByCouncil.has(s.council)) sourceByCouncil.set(s.council, s.source_url);
  }

  // When each council last updated its OWN register at source (best-effort, not
  // when we fetched it). ArcGIS layers: editingInfo.lastEditDate; smartdublin:
  // dataset modified date; PDF/portal councils: the date stated on the register.
  // Limerick is a publication month only (register PDF under a /2026-03/ path).
  // Refresh these when you re-pull the sources.
  const SOURCE_UPDATED: Record<string, string> = {
    "Dún Laoghaire-Rathdown": "2025-06-19",
    "South Dublin": "2026-05-28",
    "Fingal": "2026-01-05",
    "Dublin City": "2026-06-24",
    "Cork City": "2026-07-08",
    "Cork County": "2026-06-18",
    "Galway City": "2026-07-08",
    "Limerick City and County": "2026-03-01",
    "Wicklow": "2025-08-19",
    "Roscommon": "2026-07-10",
    "Meath": "2026-03-30",
    "Kilkenny": "2026-03-27",
    "Offaly": "2025-10-15",
    "Waterford": "2026-07-09",
    "Kildare": "2026-03-20",
    "Mayo": "2026-03-06",
    "Tipperary": "2026-06-08",
    "Wexford": "2026-03-04",
    "Louth": "2026-06-04",
    "Laois": "2026-07-01",
    "Westmeath": "2026-06-11",
    "Carlow": "2026-06-01",
    "Monaghan": "2026-04-01",
    "Sligo": "2026-07-11",
    "Leitrim": "2026-01-01",
    "Donegal": "2026-01-01",
  };

  const councils = [...byCouncil.entries()]
    .map(([council, c]) => ({
      council, ...c,
      source: sourceByCouncil.get(council) ?? "",
      updated: SOURCE_UPDATED[council] ?? null,
      valuation: valByCouncil.get(council)?.total ?? null,
      valued: valByCouncil.get(council)?.count ?? 0,
    }))
    .sort((a, b) => b.mapped + b.review - (a.mapped + a.review) || a.council.localeCompare(b.council));

  // Councils that keep a register but do not publish it online (in-office /
  // on-request inspection only), shown in the table as "not available online".
  const unavailable = [
    { council: "Kerry", source: "https://www.kerrycoco.ie/" },
    { council: "Longford", source: "https://www.longfordcoco.ie/services/housing/vacant-homes-office/derelict-sites/" },
    { council: "Cavan", source: "https://www.cavancoco.ie/services/planning-building/derelict-sites/" },
    { council: "Clare", source: "https://www.clarecoco.ie/services/planning/vacant-derelict-sites/derelict-sites/" },
    { council: "Galway County", source: "https://www.galway.ie/en/environment/derelict-sites" },
  ];

  writeFileSync(
    "public/stats.json",
    JSON.stringify({ mapped: good.length, review: review.length, councils, unavailable })
  );

  // Human-readable list of everything held for review, grouped by council, so
  // the docs stay in step with the data on every pipeline run.
  const today = new Date().toISOString().slice(0, 10);
  const reviewByCouncil = new Map<string, Site[]>();
  for (const s of review) {
    if (!reviewByCouncil.has(s.council)) reviewByCouncil.set(s.council, []);
    reviewByCouncil.get(s.council)!.push(s);
  }
  let md = `# Sites not yet mapped (held for review)\n\n`;
  md += `${review.length} sites the geocoder could not place. Generated ${today}.\n`;
  for (const [council, sites] of reviewByCouncil) {
    md += `\n## ${council} (${sites.length})\n\n`;
    for (const s of sites) md += `- \`${s.id}\`: ${s.address}\n`;
  }
  mkdirSync("docs", { recursive: true });
  writeFileSync("docs/not-yet-mapped.md", md);

  console.log(`wrote ${good.length} sites to public/sites.geojson, ${review.length} held for review`);
  console.log(`wrote docs/not-yet-mapped.md (${reviewByCouncil.size} councils)`);
}

main();