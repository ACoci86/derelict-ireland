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
import { geocodeAll } from "./geocode";

// Rough bounding box around the island of Ireland.
const LAT_MIN = 51.3, LAT_MAX = 55.5;
const LON_MIN = -10.7, LON_MAX = -5.3;

const ADAPTERS = [loadDlr, loadSouthDublin, loadFingal, loadDublinCity, loadCorkCity, loadCorkCounty, loadGalway, loadLimerick, loadWicklow, loadRoscommon, loadMeath];   // every new council adds one entry here

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

  const councils = [...byCouncil.entries()]
    .map(([council, c]) => ({ council, ...c }))
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