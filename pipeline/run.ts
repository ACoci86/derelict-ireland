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
import { geocodeAll } from "./geocode";

// Rough bounding box around the island of Ireland.
const LAT_MIN = 51.3, LAT_MAX = 55.5;
const LON_MIN = -10.7, LON_MAX = -5.3;

const ADAPTERS = [loadDlr, loadSouthDublin, loadFingal, loadDublinCity, loadCorkCity, loadCorkCounty, loadGalway, loadLimerick, loadWicklow, loadRoscommon];   // every new council adds one entry here

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
  // e.g. how many sites we couldn't place on the map (held for review).
  writeFileSync(
    "public/stats.json",
    JSON.stringify({ mapped: good.length, review: review.length })
  );

  console.log(`wrote ${good.length} sites to public/sites.geojson, ${review.length} held for review`);
  for (const s of review) console.log(`  review: ${s.id} ${s.address}`);
}

main();