// Turns the pipeline's output (public/sites.geojson, public/stats.json and
// public/counties.geojson) into the compact files the page loads from
// public/data/. Run with `npm run data` (dev and build do it for you).
//
//   public/data/base.json     topology of council areas + NI/GB context land
//   public/data/sites.json    one compact row per mapped site
//   public/data/summary.json  every number the essay quotes

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { geoArea, geoBounds } from "d3";
import { topology } from "topojson-server";
import * as topojson from "topojson-client";

const require = createRequire(import.meta.url);
const read = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), "utf8"));
const out = (name, obj) =>
  writeFileSync(new URL(`../public/data/${name}`, import.meta.url), JSON.stringify(obj));
mkdirSync(new URL("../public/data", import.meta.url), { recursive: true });

const sites = read("public/sites.geojson");

// ---------- Place fixes -------------------------------------------------------
// The pipeline's fallback geocoder sometimes matches a same-named street in the
// wrong town ("Main Street, Ringaskiddy" landed near the Limerick border).
// data/place-fixes.json moves those sites to the town their address names; a
// fix whose site is gone or already moved is skipped, so it survives refreshes.
{
  const { fixes } = read("data/place-fixes.json");
  const byId = new Map(sites.features.map((f) => [f.properties.id, f]));
  let applied = 0;
  for (const fx of fixes) {
    const f = byId.get(fx.id);
    if (!f || f.properties.address !== fx.address || f.properties.geocode_confidence === "council") continue;
    f.geometry = { type: "Point", coordinates: [fx.lon, fx.lat] };
    f.properties.geocode_confidence = "town";
    applied++;
  }
  console.log(`place fixes: ${applied} of ${fixes.length} applied`);
}
const stats = read("public/stats.json");
const counties = read("public/counties.geojson");
const world = require("world-atlas/countries-10m.json");

const TODAY = new Date().toISOString().slice(0, 10);

// ---------- Council areas ---------------------------------------------------
// The boundary file splits a few councils in two (old city/county areas).
const AREA_TO_COUNCIL = {
  "Limerick City": "Limerick City and County",
  "Limerick County": "Limerick City and County",
  "North Tipperary": "Tipperary",
  "South Tipperary": "Tipperary",
  "Waterford City": "Waterford",
  "Waterford County": "Waterford",
};
const KEEP_SUFFIX = new Set(["Galway County", "Cork County"]);
const councilOf = (name) =>
  AREA_TO_COUNCIL[name] ?? (KEEP_SUFFIX.has(name) ? name : name.replace(/ County$/, ""));

const unpublished = new Set((stats.unavailable ?? []).map((u) => u.council));

// d3-geo wants clockwise exterior rings; RFC 7946 GeoJSON is the reverse.
// A ring wound the wrong way covers the whole globe, so flip anything huge.
function rewind(feature) {
  if (geoArea(feature) > 2 * Math.PI) {
    const g = feature.geometry;
    if (g.type === "Polygon") g.coordinates = g.coordinates.map((r) => r.slice().reverse());
    if (g.type === "MultiPolygon")
      g.coordinates = g.coordinates.map((p) => p.map((r) => r.slice().reverse()));
  }
  return feature;
}

for (const f of counties.features) {
  rewind(f);
  const council = councilOf(f.properties.name);
  f.properties = { council, unpublished: unpublished.has(council) };
}

// ---------- Context land: Northern Ireland, Britain, Isle of Man ------------
const countries = topojson.feature(world, world.objects.countries);
const BOX = { w: -11.5, e: -2.5, s: 50.8, n: 56.4 };
const inBox = (poly) => {
  const [[w, s], [e, n]] = geoBounds({ type: "Polygon", coordinates: poly });
  return e > BOX.w && w < BOX.e && n > BOX.s && s < BOX.n;
};
const context = [];
for (const c of countries.features) {
  if (!["826", "833"].includes(String(c.id))) continue; // UK, Isle of Man
  const polys = c.geometry.type === "Polygon" ? [c.geometry.coordinates] : c.geometry.coordinates;
  for (const p of polys.filter(inBox)) {
    const [[w], [e]] = geoBounds({ type: "Polygon", coordinates: p });
    // The only UK polygon west of -5.3° that sits on the island of Ireland is NI.
    const isNI = String(c.id) === "826" && w < -6.5 && e < -5.3 && geoBounds({ type: "Polygon", coordinates: p })[0][1] > 54;
    context.push({
      type: "Feature",
      properties: { kind: isNI ? "ni" : "gb" },
      geometry: { type: "Polygon", coordinates: p },
    });
  }
}

const topo = topology(
  {
    councils: counties,
    context: { type: "FeatureCollection", features: context },
  },
  1e5,
);
out("base.json", topo);

// ---------- Sites ------------------------------------------------------------
// Columns: [lon, lat, councilIndex, valuation|null, dateEntered|null, address, ref, precision]
// precision: c = council's own coordinates, a = full address, s = street, t = town only
const councilNames = [...new Set(sites.features.map((f) => f.properties.council))].sort((a, b) =>
  a.localeCompare(b),
);
const idx = new Map(councilNames.map((c, i) => [c, i]));
const round = (n) => Math.round(n * 1e5) / 1e5;
const rows = sites.features.map((f) => {
  const p = f.properties;
  const [lon, lat] = f.geometry.coordinates;
  // A handful of register dates are in the future; treat those as unknown.
  const date = p.date_entered && p.date_entered <= TODAY ? p.date_entered : null;
  return [
    round(lon),
    round(lat),
    idx.get(p.council),
    p.valuation ?? null,
    date,
    (p.address ?? "").trim(),
    p.register_ref ?? "",
    { council: "c", exact: "a", street: "s", town: "t" }[p.geocode_confidence] ?? "t",
  ];
});
out("sites.json", { councils: councilNames, rows });

// ---------- Summary numbers for the essay -----------------------------------
const valued = rows.filter((r) => r[3] != null);
const sum = (a) => a.reduce((s, r) => s + r[3], 0);
const cat = {
  c1: valued.filter((r) => r[3] >= 1e6),
  c2: valued.filter((r) => r[3] >= 1e5 && r[3] < 1e6),
  c3: valued.filter((r) => r[3] < 1e5),
};
const byCouncil = (list) => {
  const m = new Map();
  for (const r of list) m.set(councilNames[r[2]], (m.get(councilNames[r[2]]) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
};
const dated = rows.filter((r) => r[4]).sort((a, b) => a[4].localeCompare(b[4]));
const median = (a) => {
  const s = a.map((r) => r[3]).sort((x, y) => x - y);
  return s.length ? (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2 : null;
};

const summary = {
  generated: TODAY,
  mapped: rows.length,
  review: stats.review,
  published: councilNames.length,
  unpublished: [...unpublished],
  valued: valued.length,
  unvalued: rows.length - valued.length,
  valueTotal: sum(valued),
  valueMedian: median(valued),
  valueMax: Math.max(...valued.map((r) => r[3])),
  valueMin: Math.min(...valued.map((r) => r[3])),
  categories: Object.fromEntries(
    Object.entries(cat).map(([k, list]) => [
      k,
      { count: list.length, total: sum(list), top: byCouncil(list).slice(0, 3) },
    ]),
  ),
  pre2000: dated.filter((r) => r[4] < "2000").length,
  // How each site was placed: council-supplied coordinates, or geocoded to an
  // exact address, a street, or only a town.
  precision: sites.features.reduce((m, f) => {
    const k = f.properties.geocode_confidence ?? "unknown";
    m[k] = (m[k] ?? 0) + 1;
    return m;
  }, {}),
  oldest: dated[0] && { date: dated[0][4], address: dated[0][5], council: councilNames[dated[0][2]] },
  councils: stats.councils
    .map((c) => ({
      council: c.council,
      mapped: c.mapped,
      review: c.review,
      valuation: c.valuation,
      valued: c.valued,
      updated: c.updated,
      source: c.source,
    }))
    .sort((a, b) => b.mapped - a.mapped),
  unpublishedSources: stats.unavailable ?? [],
};
out("summary.json", summary);


console.log(
  `data: ${rows.length} sites, ${councilNames.length} councils, ${context.length} context polygons ` +
    `(${context.filter((c) => c.properties.kind === "ni").length} NI)`,
);
