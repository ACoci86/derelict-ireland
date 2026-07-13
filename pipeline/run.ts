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
import { geocodeAll } from "./geocode";

// Rough bounding box around the island of Ireland.
const LAT_MIN = 51.3, LAT_MAX = 55.5;
const LON_MIN = -10.7, LON_MAX = -5.3;

const ADAPTERS = [loadDlr, loadSouthDublin, loadFingal, loadDublinCity, loadCorkCity, loadCorkCounty, loadGalway, loadLimerick, loadWicklow, loadRoscommon, loadMeath, loadKilkenny, loadOffaly, loadWaterford, loadKildare, loadMayo, loadTipperary];   // every new council adds one entry here

function inIreland(s: Site): boolean {
  return (
    s.lat !== null && s.lon !== null &&
    s.lat >= LAT_MIN && s.lat <= LAT_MAX &&
    s.lon >= LON_MIN && s.lon <= LON_MAX
  );
}

async function main() {
  const all: Site[] = [];
  for (const load of ADAPTERS) {
    const sites = await load();
    console.log(`${sites.length} sites loaded`);
    all.push(...sites);
  }

  await geocodeAll(all);          // fill in coordinates for sites that lack them

  const good = all.filter(inIreland);
  const review = all.filter((s) => !inIreland(s));

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
  };

  const councils = [...byCouncil.entries()]
    .map(([council, c]) => ({
      council, ...c,
      source: sourceByCouncil.get(council) ?? "",
      updated: SOURCE_UPDATED[council] ?? null,
    }))
    .sort((a, b) => b.mapped + b.review - (a.mapped + a.review) || a.council.localeCompare(b.council));

  writeFileSync(
    "public/stats.json",
    JSON.stringify({ mapped: good.length, review: review.length, councils })
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