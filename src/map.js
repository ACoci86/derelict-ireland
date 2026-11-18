import * as d3 from "d3";
import * as topojson from "topojson-client";
import { euro, int, longDate } from "./format.js";
import { icon, ICON_PATHS } from "./icons.js";
import { tile as d3tile } from "d3-tile";

// The map is drawn at the container's real pixel size (viewBox = CSS px), so
// type and strokes stay the same size on every screen. The layout picks where
// Ireland, the magnifier and the water labels go for the width available.
function layoutFor(W) {
  if (W >= 1100) {
    // Fit the window's height, so the whole map and its controls are on screen.
    const H = Math.round(Math.min(1000, Math.max(640, Math.min(W * 0.66, innerHeight))));
    const lensR = Math.round(Math.min(175, H * 0.17));
    return {
      mode: "wide",
      W,
      H,
      box: [
        [W * 0.12, 96],
        [W * 0.64, H - 36],
      ],
      // Bottom right, clear of the scale panel on the right.
      lens: { r: lensR, cx: Math.min(W * 0.64 + lensR * 1.25, W - 250 - lensR), cy: H - lensR - 44 },
      usable: [
        [0, 80],
        [W - 240, H],
      ],
      safe: [8, W - 250],
      water: false, // the sea names were decoration; the opening view is calmer without them
    };
  }
  if (W >= 640) {
    const H = Math.round(W * 1.08);
    const lensR = Math.round(W * 0.13);
    return {
      mode: "mid",
      W,
      H,
      box: [
        [32, 88],
        [W * 0.72, H - 24],
      ],
      lens: { r: lensR, cx: W - lensR - 28, cy: H * 0.6 },
      usable: [
        [0, 70],
        [W, H],
      ],
      safe: [8, W - 8],
      water: false,
    };
  }
  // Phones: the island fills the width, and the magnifier sits below its south
  // coast, so the map grows by the lens's height.
  const islandH = Math.round(W * 1.32);
  const lensR = Math.round(Math.min(110, W * 0.26));
  const lensCy = islandH + lensR - 4;
  const H = lensCy + lensR + 18;
  return {
    mode: "narrow",
    W,
    H,
    box: [
      [14, 76],
      [W - 14, islandH - 12],
    ],
    lens: { r: lensR, cx: W - lensR - 16, cy: lensCy },
    usable: [
      [0, 60],
      [W, islandH],
    ],
    safe: [8, W - 8],
    water: false,
  };
}

const DUBLIN = [-6.27, 53.36];
const LENS_RADIUS_KM = 18; // ground radius the magnifier shows
// Street map tiles (OpenStreetMap's standard tiles: no key needed, credit
// required, light use only) fade in once zoomed to town level.
const TILE_FADE = [8.4, 9.4]; // tile zoom levels between which streets fade in (county level)
const DOT_STREET = [11, 12.5]; // ...and between which dots ease down to street size
const TILE_MAX = 19; // deepest tile zoom OpenStreetMap serves
const COUNCIL_MAX_ZOOM = 40; // county clicks stop well before street level
const tileUrl = ([x, y, z]) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
let streetZoomBase = 0; // tile zoom of the unzoomed map (set on each layout)
// How big a site's circle is on screen at zoom k. On the drawn map it grows a
// little as you zoom in (k^0.4, capped at 24 px). As the streets fade in it
// eases to street size: 5-14 px, still in proportion to value.
const DOT_GROWTH = 0.4;
function screenR(r, k) {
  const drawn = Math.min(r * Math.pow(k, DOT_GROWTH), Math.max(r, 24));
  const street = 4.5 + r * 0.35;
  const zf = streetZoomBase + Math.log2(k);
  const f = Math.max(0, Math.min(1, (zf - DOT_STREET[0]) / (DOT_STREET[1] - DOT_STREET[0])));
  return drawn + (street - drawn) * f;
}

// Where a council's name sits when its centroid would land on a city's cluster.
const LABEL_AT = {
  "Galway County": [-9.6, 53.47],
  "Cork County": [-9.05, 51.97],
  "Limerick City and County": [-8.95, 52.43],
  Mayo: [-9.45, 53.95],
};

export const shortName = (c) => c.replace(" City and County", "").replace(/ County$/, "");
const esc = (t) =>
  String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// Rasterise an SVG snippet once into a bitmap URL.
async function rasterise(markup, w, h) {
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  await img.decode();
  const dpr = Math.min(2, Math.max(1, devicePixelRatio || 1));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((r) => canvas.toBlob(r));
  return URL.createObjectURL(blob);
}

const bakedUrls = [];
async function bakeTextures({ W, H, landD, allLandD, bounds: [x, y, w, h] }) {
  const css = getComputedStyle(document.documentElement);
  const wave = css.getPropertyValue("--wave").trim() || "#9a8571";
  const ns = 'xmlns="http://www.w3.org/2000/svg"';
  const region = (x0, y0, w0, h0) => `filterUnits="userSpaceOnUse" x="${x0}" y="${y0}" width="${w0}" height="${h0}"`;
  const wavesSvg = `<svg ${ns} width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>
    <pattern id="w" width="24" height="14" patternUnits="userSpaceOnUse"><path d="M0 4q3-2.6 6 0t6 0 6 0 6 0M-12 11q3-2.6 6 0t6 0 6 0 6 0 6 0 6 0" fill="none" stroke="${wave}" stroke-opacity="0.45" stroke-width="0.8"/></pattern>
    <filter id="b" ${region(0, 0, W, H)}><feGaussianBlur stdDeviation="20"/></filter>
    <mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><path d="${allLandD}" fill="#fff" stroke="#fff" stroke-width="80" stroke-linejoin="round" filter="url(#b)"/></mask>
    </defs><rect width="${W}" height="${H}" fill="url(#w)" mask="url(#m)"/></svg>`;
  // Low-frequency mottling reads as relief; high-frequency noise as paper grain.
  const reliefSvg = `<svg ${ns} width="${w}" height="${h}" viewBox="${x} ${y} ${w} ${h}"><defs>
    <filter id="r" ${region(x, y, w, h)}><feTurbulence type="fractalNoise" baseFrequency="0.016" numOctaves="5" seed="7"/><feColorMatrix values="0 0 0 0 0.55  0 0 0 0 0.40  0 0 0 0 0.28  1.6 0 0 0 -0.75"/></filter>
    <filter id="g" ${region(x, y, w, h)}><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="3"/><feColorMatrix values="0 0 0 0 0.45  0 0 0 0 0.32  0 0 0 0 0.24  1.3 0 0 0 -0.6"/></filter>
    <clipPath id="c"><path d="${landD}"/></clipPath></defs>
    <g clip-path="url(#c)"><rect x="${x}" y="${y}" width="${w}" height="${h}" filter="url(#r)" opacity="0.3"/><rect x="${x}" y="${y}" width="${w}" height="${h}" filter="url(#g)" opacity="0.35"/></g></svg>`;
  const [waves, relief] = await Promise.all([rasterise(wavesSvg, W, H), rasterise(reliefSvg, w, h)]);
  while (bakedUrls.length) URL.revokeObjectURL(bakedUrls.pop());
  bakedUrls.push(waves, relief);
  return { waves, relief };
}

export function createMap({ container, svgEl, tipEl, base, sites, councilStats, onCouncilClick, onBackgroundClick }) {
  const svg = d3.select(svgEl);
  const tip = d3.select(tipEl);
  container.classList.add("pre-labels", "pre-ui", "pre-lens", "pre-hint");
  const statsBy = new Map(councilStats.map((c) => [c.council, c]));

  // ---------- Geometry (projection-independent) ----------
  const geoms = base.objects.councils.geometries;
  const land = topojson.merge(base, geoms);
  const coast = topojson.mesh(base, base.objects.councils, (a, b) => a === b);
  const borders = topojson.mesh(
    base,
    base.objects.councils,
    (a, b) => a !== b && a.properties.council !== b.properties.council,
  );
  const councilNames = [...new Set(geoms.map((g) => g.properties.council))];
  const councils = councilNames.map((name) => {
    const parts = geoms.filter((g) => g.properties.council === name);
    return {
      type: "Feature",
      properties: { council: name, unpublished: parts[0].properties.unpublished },
      geometry: topojson.merge(base, parts),
    };
  });
  const context = topojson.feature(base, base.objects.context).features;
  const ni = context.find((c) => c.properties.kind === "ni");
  const allLand = { type: "FeatureCollection", features: [{ type: "Feature", geometry: land }, ...context] };
  const sitesByCouncil = d3.rollup(
    sites,
    (v) => v.length,
    (s) => s.council,
  );
  const lensData = sites.map((s) => ({ s, lens: true }));

  // ---------- Controls ----------
  const ctl = d3.select(container).append("div").attr("class", "zoom-ctl");
  ctl.append("button").attr("type", "button").attr("aria-label", "Zoom in").text("+").on("click", () => zoomBy(2));
  ctl.append("button").attr("type", "button").attr("aria-label", "Zoom out").text("−").on("click", () => zoomBy(0.5));
  const resetBtn = ctl
    .append("button")
    .attr("type", "button")
    .attr("class", "reset")
    .html(`${icon("reset")}<span>Reset view</span>`)
    .property("disabled", true)
    .on("click", () => resetZoom());

  // ---------- State ----------
  let L = null;
  let projection, path, landCentroid;
  let t = d3.zoomIdentity;
  let grow = 1;
  let worldSize = 1;
  let zoomBase = 0;
  let tilesG, tilesTint, sitesZoomG, overG, streetsOn = false;
  let flying = false;
  let sizeFor = () => 0;
  let view = { match: () => true, annotations: [], missing: false };
  let shown = [];
  let delaunay = null;
  let pinned = null;
  let introPending = true; // sites start hidden and spring in once, on first paint
  let introScheduled = false;
  let introAt = -1e9;
  let bakeToken = 0;
  let drag = null;
  let titleRaf = 0;
  let wavesImg, zoomG, sitesSel, labelsG, labelItems, annoG, annoItems, hoverRing, councilHi, watersG;
  // The magnifier: a small source circle on the map (what is magnified) and
  // the big lens (where it is shown), joined by tangent lines. Both can be
  // dragged. src is remembered as lon/lat and the lens as a fraction of the
  // frame, so they survive a resize.
  const lens = { src: DUBLIN, fx: null, fy: null, k: 1, r: 0, r0: 0, sx: 0, sy: 0, cx: 0, cy: 0, moved: false };
  let lensG, lensLinks, lensSrc, lensBody, lensMag, lensSites, lensLabels, lensTitle, lensHint;

  // Zoom by the buttons, the mouse wheel, double-click and county clicks; drag
  // to pan when zoomed in. The wheel only zooms while the map is at the top of
  // the window, and at the whole-island view scrolling down passes through to
  // the page, so a reader is never stuck on the map.
  const zoom = d3
    .zoom()
    .scaleExtent([1, 16])
    .filter((e) => {
      if (e.target.closest?.(".lens")) return false;
      if (e.type === "wheel") {
        if (svgEl.getBoundingClientRect().top < -40) return false; // reading the article
        return !(e.deltaY > 0 && t.k <= 1.001); // nothing to zoom out to: scroll the page
      }
      return e.type === "mousedown" && !e.button;
    })
    .on("zoom", onZoom);

  function render() {
    const W = Math.round(container.clientWidth);
    // Small changes (a scrollbar appearing) only rescale the SVG; no redraw.
    if (L && Math.abs(L.W - W) < 40 && layoutFor(W).mode === L.mode) return;
    // A redraw while the intro is still playing replays it on the new circles.
    if (performance.now() - introAt < 2200) introPending = true;
    L = layoutFor(W);
    container.dataset.mode = L.mode;
    const { H } = L;

    // Web Mercator, so street map tiles line up with the sites when zoomed in.
    projection = d3.geoMercator().fitExtent(L.box, land);
    worldSize = 2 * Math.PI * projection.scale();
    zoomBase = Math.log2(worldSize / 256);
    streetZoomBase = zoomBase;
    zoom.scaleExtent([1, Math.pow(2, TILE_MAX - zoomBase)]);
    path = d3.geoPath(projection);
    landCentroid = path.centroid(land);

    const irelandH = path.bounds(land)[1][1] - path.bounds(land)[0][1];
    const rMax = Math.max(12, irelandH * 0.036);
    const rMin = L.mode === "narrow" ? 1.3 : 1.7;
    const vMax = d3.max(sites, (s) => s.v) ?? 1;
    const rv = d3.scaleSqrt().domain([0, vMax]).range([0, rMax]).clamp(true);
    sizeFor = (v) => (v == null ? rMin + 0.8 : Math.max(rMin, rv(v)));
    for (const s of sites) {
      const p = projection([s.lon, s.lat]);
      s.x = p[0];
      s.y = p[1];
      s.r = s.v == null ? rMin + 0.8 : Math.max(rMin, rv(s.v));
    }

    svg.attr("viewBox", `0 0 ${L.W} ${H}`).attr("width", L.W).attr("height", H);
    svg.selectAll(":scope > :not(title)").remove();
    t = d3.zoomIdentity;
    grow = 1;

    // ---------- defs ----------
    const defs = svg.append("defs");
    const hatchPattern = (id) =>
      defs
        .append("pattern")
        .attr("id", id)
        .attr("width", 7)
        .attr("height", 7)
        .attr("patternUnits", "userSpaceOnUse")
        .attr("patternTransform", "rotate(45)")
        .append("line")
        .attr("x1", 0)
        .attr("y1", 0)
        .attr("x2", 0)
        .attr("y2", 7)
        .attr("stroke", "var(--accent)")
        .attr("stroke-opacity", 0.4)
        .attr("stroke-width", 1.2);
    hatchPattern("hatch");
    hatchPattern("hatch-lens");
    defs.append("clipPath").attr("id", "land-clip").append("path").attr("d", path(land));

    // ---------- zoomable base map ----------
    svg.append("rect").attr("class", "sea").attr("width", L.W).attr("height", H);
    zoomG = svg.append("g").attr("class", "zoomable");
    const nonScaling = (sel) => sel.attr("vector-effect", "non-scaling-stroke");
    // Coastal waves and the land's relief/grain are drawn once into bitmaps:
    // live SVG noise filters would be recomputed on every animation frame.
    wavesImg = zoomG.append("image").attr("class", "texture waves-img").attr("width", L.W).attr("height", H);
    zoomG.append("g").selectAll("path").data(context).join("path").attr("class", "land-out").attr("d", path);
    zoomG.append("g").selectAll("path").data(context).join("path").attr("class", "coast-out").attr("d", path).call(nonScaling);
    zoomG.append("path").attr("class", "land").attr("d", path(land));
    const [[bx0, by0], [bx1, by1]] = path.bounds(land);
    const landImg = zoomG
      .append("image")
      .attr("class", "texture")
      .attr("x", bx0)
      .attr("y", by0)
      .attr("width", bx1 - bx0)
      .attr("height", by1 - by0);
    const token = ++bakeToken;
    bakeTextures({ W: L.W, H, landD: path(land), allLandD: path(allLand), bounds: [bx0, by0, bx1 - bx0, by1 - by0] }).then(
      ({ waves, relief }) => {
        if (token !== bakeToken) return;
        wavesImg.attr("href", waves);
        landImg.attr("href", relief);
      },
    );
    const unpub = councils.filter((c) => c.properties.unpublished);
    zoomG
      .append("g")
      .selectAll("path")
      .data(unpub)
      .join("path")
      .attr("class", "hatch-area")
      .attr("clip-path", "url(#land-clip)")
      .attr("d", path);
    zoomG.append("g").selectAll("path").data(unpub).join("path").attr("class", "hatch-edge").attr("d", path).call(nonScaling);
    // Invisible council shapes catch hover and clicks.
    zoomG
      .append("g")
      .selectAll("path")
      .data(councils)
      .join("path")
      .attr("class", (d) => `council${d.properties.unpublished ? " unpub" : ""}`)
      .attr("d", path);
    zoomG.append("path").attr("class", "borders").attr("d", path(borders)).call(nonScaling);
    zoomG.append("path").attr("class", "coast").attr("d", path(coast)).call(nonScaling);
    councilHi = zoomG.append("path").attr("class", "council-hi").call(nonScaling);

    watersG = zoomG.append("g").attr("class", "waters");
    if (L.water) {
      const curve = d3.line().curve(d3.curveNatural);
      const water = (id, text, pts, size) => {
        defs
          .append("path")
          .attr("id", id)
          .attr("d", curve(pts.map((p) => projection(p))));
        watersG
          .append("text")
          .attr("class", "water")
          .style("font-size", size ? `${size}px` : null)
          .append("textPath")
          .attr("href", `#${id}`)
          .attr("startOffset", "50%")
          .attr("text-anchor", "middle")
          .text(text);
      };
      water("atlantic", "Atlantic Ocean", [
        [-10.95, 51.45],
        [-11.25, 52.9],
        [-10.85, 54.35],
      ]);
      water(
        "irish-sea",
        "Irish Sea",
        [
          [-5.62, 53.15],
          [-5.35, 53.75],
          [-5.18, 54.25],
        ],
        18,
      );
      water(
        "celtic-sea",
        "Celtic Sea",
        [
          [-8.9, 51.3],
          [-7.6, 51.42],
          [-6.3, 51.68],
        ],
        18,
      );
    }

    // Sites: hollow rings first (underneath), then discs from big to small.
    const byDrawOrder = (a, b) => {
      const A = a.s ?? a;
      const B = b.s ?? b;
      return (A.v == null ? 0 : 1) - (B.v == null ? 0 : 1) || B.r - A.r;
    };
    const initP = (d) => (d.__p = introPending || !view.match(d.s ?? d) ? 0 : 1);
    // Street tiles sit above the drawn map and below the sites.
    tilesG = svg.append("g").attr("class", "tiles").attr("opacity", 0);
    tilesG.append("g").attr("class", "tile-imgs");
    tilesTint = tilesG.append("rect").attr("class", "tiles-tint").attr("width", L.W).attr("height", H);
    // Hatching, borders and the hover/click shapes go above the streets.
    overG = svg.append("g").attr("class", "zoomable-over");
    for (const node of zoomG
      .selectAll(":scope > g:has(> .hatch-area), :scope > g:has(> .hatch-edge), :scope > g:has(> .council), :scope > .borders, :scope > .coast, :scope > .council-hi")
      .nodes())
      overG.node().append(node);
    sitesZoomG = svg.append("g").attr("class", "zoomable-sites");
    sitesSel = sitesZoomG
      .append("g")
      .attr("class", "sites")
      .selectAll("circle")
      .data([...sites].sort(byDrawOrder))
      .join("circle")
      .each(initP)
      .attr("class", (d) => `site ${d.v == null ? "u" : "v"}`)
      .classed("off", (d) => !d.__p)
      .attr("cx", (d) => d.x)
      .attr("cy", (d) => d.y)
      .attr("r", radiusOf)
      .call(nonScaling);

    // ---------- screen-space layers ----------
    labelsG = svg.append("g").attr("class", "labels");
    labelItems = [];
    const minArea = (L.W * H) / (L.mode === "narrow" ? 40 : 260);
    for (const c of councils) {
      if (path.area(c) < minArea && !(L.mode === "narrow" && c.properties.unpublished)) continue;
      const [x, y] = labelPoint(c);
      if (!isFinite(x)) continue;
      const g = labelsG.append("g");
      g.append("text").attr("class", "label").attr("dy", "0.35em").text(shortName(c.properties.council));
      if (c.properties.unpublished) g.append("text").attr("class", "label note").attr("dy", "1.7em").text("register offline");
      labelItems.push({ g, x, y });
    }
    if (ni) {
      const [x, y] = path.centroid(ni);
      const g = labelsG.append("g");
      g.append("text").attr("class", "label dim out").text(L.mode === "narrow" ? "N. Ireland" : "Northern Ireland");
      labelItems.push({ g, x, y });
    }

    annoG = svg.append("g").attr("class", "annos");
    annoItems = [];

    buildLens(defs, nonScaling, byDrawOrder, initP);

    hoverRing = svg.append("circle").attr("class", "hover-ring").attr("r", 0).attr("opacity", 0);

    zoom
      .extent([
        [0, 0],
        [L.W, H],
      ])
      .translateExtent([
        [0, 0],
        [L.W, H],
      ]);
    svg.call(zoom).on("dblclick.zoom", null);
    svg.on("dblclick.street", (e) => {
      // Once zoomed in, double-click zooms further in where you click (at the
      // unzoomed map a single click on a county already zooms in).
      const p = pt(e);
      if (t.k <= 1.05 || onSource(p) || inLens(p)) return;
      e.preventDefault();
      svg.transition().duration(reducedMotion() ? 0 : 500).call(zoom.scaleBy, 3, p);
    });
    svg.call(zoom.transform, d3.zoomIdentity);

    if (introPending) {
      if (!introScheduled) {
        introScheduled = true;
        // Two frames so the browser paints the empty map before the pop-in.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            introPending = false;
            introScheduled = false;
            introAt = performance.now();
            applyView("intro");
            stageIn();
          }),
        );
      }
    } else {
      applyView("instant");
    }
  }

  // The opening is staged so it doesn't all land at once: the dots sweep in,
  // then the place names, then the controls, then the magnifier, and last the
  // drag hint, which fades out again by itself.
  function stageIn() {
    const steps = [
      ["pre-labels", 900],
      ["pre-ui", 1500],
      ["pre-lens", 2100],
      ["pre-hint", 2900],
    ];
    if (reducedMotion()) {
      for (const [c] of steps) container.classList.remove(c);
      return;
    }
    for (const [c, ms] of steps) setTimeout(() => container.classList.remove(c), ms);
    setTimeout(() => {
      lensHint?.classed("gone", true);
      lensSrc?.select(".lens-src-pulse").classed("gone", true);
    }, 9500);
  }

  function labelPoint(c) {
    const at = LABEL_AT[c.properties.council];
    return at ? projection(at) : path.centroid(c);
  }

  // ---------- the magnifier ----------
  function buildLens(defs, nonScaling, byDrawOrder, initP) {
    lensG = svg.append("g").attr("class", "lens").attr("aria-hidden", "true");
    lensSites = d3.select(null);
    if (!L.lens) return;
    const { r } = L.lens;
    const a = projection(DUBLIN);
    const b = projection([DUBLIN[0], DUBLIN[1] + 1]);
    const pxPerKm = Math.hypot(a[0] - b[0], a[1] - b[1]) / 111.2;
    lens.r = r;
    lens.k = r / (LENS_RADIUS_KM * pxPerKm);
    lens.r0 = r / lens.k;

    lensLinks = lensG.append("g").selectAll("line").data([1, -1]).join("line").attr("class", "lens-link");
    lensSrc = lensG.append("g").attr("class", "lens-src");
    lensSrc.append("circle").attr("class", "lens-src-hit").attr("r", lens.r0 + 8);
    // Until it's first moved, a pulse and a label say the circle can be dragged.
    lensSrc.append("circle").attr("class", "lens-src-pulse").classed("gone", lens.moved).attr("r", lens.r0);
    lensSrc.append("circle").attr("class", "lens-src-ring").attr("r", lens.r0);
    lensHint = lensSrc
      .append("g")
      .attr("class", "lens-hint")
      .classed("gone", lens.moved)
      .attr("transform", `translate(${-lens.r0 - 12},0)`);
    // Sits to the left (inland) of the circle, pointing right at it, so it
    // never covers the lens, which is always off to the east.
    const hintRect = lensHint.append("rect").attr("rx", 6).attr("height", 28).attr("y", -14);
    lensHint.append("path").attr("d", "M-0.5,-6L6,0L-0.5,6Z");
    const hintText = lensHint.append("text").attr("x", -12).attr("dy", "0.35em").attr("text-anchor", "end").text("Drag to magnify any area");
    const hintIcon = lensHint.append("path").attr("class", "lens-hint-ico").attr("d", ICON_PATHS.move);
    const fitHint = () => {
      const tw = hintText.node().getComputedTextLength() || 150;
      // [12 pad][14 icon][6 gap][text][12 pad], right-aligned to the pointer
      hintRect.attr("x", -tw - 44).attr("width", tw + 44);
      hintIcon.attr("transform", `translate(${-tw - 32},-7) scale(${14 / 24})`);
    };
    fitHint();
    document.fonts?.ready.then(fitHint);

    lensBody = lensG.append("g").attr("class", "lens-body");
    defs.append("clipPath").attr("id", "lens-clip").append("circle").attr("r", r);
    lensBody.append("circle").attr("class", "lens-bg").attr("r", r);
    const inner = lensBody.append("g").attr("clip-path", "url(#lens-clip)");
    lensMag = inner.append("g");
    lensMag.append("g").selectAll("path").data(context).join("path").attr("class", "land-out").attr("d", path);
    lensMag.append("path").attr("class", "land").attr("d", path(land));
    lensMag
      .append("g")
      .selectAll("path")
      .data(councils.filter((c) => c.properties.unpublished))
      .join("path")
      .attr("class", "hatch-area lens-hatch")
      .attr("clip-path", "url(#land-clip)")
      .attr("d", path);
    lensMag.append("path").attr("class", "borders").attr("d", path(borders)).call(nonScaling);
    lensMag.append("path").attr("class", "coast").attr("d", path(coast)).call(nonScaling);
    lensSites = lensMag
      .append("g")
      .attr("class", "sites")
      .selectAll("circle")
      .data([...lensData].sort(byDrawOrder))
      .join("circle")
      .each(initP)
      .attr("class", (d) => `site ${d.s.v == null ? "u" : "v"}`)
      .classed("off", (d) => !d.__p)
      .attr("cx", (d) => d.s.x)
      .attr("cy", (d) => d.s.y)
      .attr("r", radiusOf)
      .call(nonScaling);
    svg.select("#hatch-lens").attr("patternTransform", `rotate(45) scale(${1 / lens.k})`);
    // Every council gets a name inside the lens, even the small Dublin ones.
    lensLabels = inner
      .append("g")
      .selectAll("text")
      .data(councils.map((c) => ({ c, p: path.centroid(c) })))
      .join("text")
      .attr("class", "label dim")
      .style("font-size", "10px")
      .style("letter-spacing", "0.22em")
      .text((d) => (d.c.properties.council === "Dún Laoghaire-Rathdown" ? "DLR" : shortName(d.c.properties.council)));
    lensBody.append("circle").attr("class", "lens-ring").attr("r", r);
    const arcR = r + 12;
    defs
      .append("path")
      .attr("id", "lens-arc")
      .attr("d", `M${-arcR},0 A${arcR},${arcR} 0 0 1 ${arcR},0`);
    lensTitle = lensBody
      .append("text")
      .attr("class", "lens-title")
      .append("textPath")
      .attr("href", "#lens-arc")
      .attr("startOffset", "50%")
      .attr("text-anchor", "middle");

    const [sx, sy] = projection(lens.src);
    if (lens.fx == null) setLensBody(L.lens.cx, L.lens.cy);
    else setLensBody(lens.fx * L.W, lens.fy * L.H);
    setLensSource(sx, sy);
  }

  const clampTo = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function setLensSource(x, y) {
    lens.sx = clampTo(x, lens.r0, L.W - lens.r0);
    lens.sy = clampTo(y, lens.r0, L.H - lens.r0);
    lens.src = projection.invert([lens.sx, lens.sy]);
    lensSrc.attr("transform", `translate(${lens.sx},${lens.sy})`);
    lensMag.attr("transform", `scale(${lens.k}) translate(${-lens.sx},${-lens.sy})`);
    lensLabels.attr("transform", (d) => `translate(${(d.p[0] - lens.sx) * lens.k},${(d.p[1] - lens.sy) * lens.k})`);
    updateLinks();
    if (!titleRaf) titleRaf = requestAnimationFrame(updateLensTitle);
  }

  function setLensBody(x, y) {
    lens.cx = clampTo(x, lens.r * 0.5, L.W - lens.r * 0.5);
    lens.cy = clampTo(y, lens.r * 0.5, L.H - lens.r * 0.5);
    lens.fx = lens.cx / L.W;
    lens.fy = lens.cy / L.H;
    lensBody.attr("transform", `translate(${lens.cx},${lens.cy})`);
    updateLinks();
  }

  // Outer tangents between the source circle and the lens.
  function updateLinks() {
    const { sx, sy, cx, cy, r, r0 } = lens;
    const dist = Math.hypot(cx - sx, cy - sy);
    if (dist <= r - r0 + 1) {
      lensLinks.attr("display", "none");
      return;
    }
    const theta = Math.atan2(cy - sy, cx - sx);
    const phi = Math.acos((r0 - r) / dist);
    lensLinks
      .attr("display", null)
      .attr("x1", (s) => sx + r0 * Math.cos(theta + s * phi))
      .attr("y1", (s) => sy + r0 * Math.sin(theta + s * phi))
      .attr("x2", (s) => cx + r * Math.cos(theta + s * phi))
      .attr("y2", (s) => cy + r * Math.sin(theta + s * phi));
  }

  // Name whatever sits under the source circle.
  function updateLensTitle() {
    titleRaf = 0;
    const ll = lens.src;
    const c = councils.find((f) => d3.geoContains(f, ll));
    const name = c
      ? c.properties.council === "Dún Laoghaire-Rathdown"
        ? "Dún Laoghaire"
        : shortName(c.properties.council)
      : ni && d3.geoContains(ni, ll)
        ? "Northern Ireland"
        : "At sea";
    lensTitle.text(`${name}  ×${lens.k.toFixed(1)}`);
  }

  const lensVisible = () => !!L.lens && t.k <= 1.05;
  const onSource = (p) => lensVisible() && Math.hypot(p[0] - lens.sx, p[1] - lens.sy) <= lens.r0 + 8;
  const inLens = (p) => lensVisible() && Math.hypot(p[0] - lens.cx, p[1] - lens.cy) <= lens.r;

  // ---------- zoom ----------
  function onZoom(e) {
    t = e.transform;
    grow = 1 / t.k;
    zoomG.attr("transform", t);
    sitesZoomG.attr("transform", t);
    overG.attr("transform", t);
    updateTiles();
    sitesSel.attr("r", radiusOf);
    svg.select("#hatch").attr("patternTransform", `rotate(45) scale(${1 / t.k})`);
    for (const l of labelItems) {
      const [x, y] = t.apply([l.x, l.y]);
      l.g.attr("transform", `translate(${x},${y})`);
    }
    positionAnnotations();
    const zoomed = t.k > 1.05;
    lensG.classed("hidden", zoomed);
    svg.classed("zoomed", zoomed);
    wavesImg.attr("opacity", t.k > 1.6 ? 0 : 1);
    watersG.attr("opacity", t.k > 1.6 ? 0 : 1);
    resetBtn.property("disabled", !zoomed);
    if (e.sourceEvent || zoomed) {
      pinned = null;
      hideTip();
    }
  }

  // Fetch and place the street tiles for the current view; fade them in
  // between TILE_FADE levels, and the drawn labels out.
  const tiler = d3tile().tileSize(256);
  function updateTiles() {
    const zf = zoomBase + Math.log2(t.k);
    const o = flying ? 0 : Math.max(0, Math.min(1, (zf - TILE_FADE[0]) / (TILE_FADE[1] - TILE_FADE[0])));
    tilesG.style("opacity", o);
    labelsG?.attr("opacity", 1 - o);
    const on = o > 0;
    if (on !== streetsOn) {
      streetsOn = on;
      container.classList.toggle("streets-on", on);
    }
    const imgs = tilesG.select(".tile-imgs");
    if (flying) return; // keep the old tiles (hidden) until the flight lands
    if (!on) {
      imgs.selectAll("image").remove();
      return;
    }
    tiler.extent([
      [0, 0],
      [L.W, L.H],
    ]);
    const [cx, cy] = t.apply(projection.translate());
    const tiles = tiler({ k: worldSize * t.k, x: cx, y: cy });
    const [tx, ty] = tiles.translate;
    const k = tiles.scale;
    imgs
      .selectAll("image")
      .data(tiles, (d) => d.join("/"))
      .join((enter) => enter.append("image").attr("href", tileUrl))
      .attr("x", ([x]) => Math.round((x + tx) * k))
      .attr("y", ([, y]) => Math.round((y + ty) * k))
      .attr("width", Math.ceil(k) + 1)
      .attr("height", Math.ceil(k) + 1);
  }

  // Fly to a view along d3's zoom curve (pull back, travel, swoop in), taking
  // longer the further it goes. Street tiles pause during the flight, so a
  // trip doesn't fetch every zoom level in between, and fade back on landing.
  function flyTo(T, { min = 500, max = 2600, onEnd } = {}) {
    const [cx, cy] = [L.W / 2, L.H / 2];
    const from = [...t.invert([cx, cy]), L.W / t.k];
    const to = [...T.invert([cx, cy]), L.W / T.k];
    const ms = reducedMotion() ? 0 : Math.max(min, Math.min(max, d3.interpolateZoom(from, to).duration * 0.8));
    flying = ms > 0;
    svg
      .transition("fly")
      .duration(ms)
      .ease(d3.easeCubicInOut)
      .call(zoom.transform, T)
      .on("end interrupt", () => {
        flying = false;
        updateTiles();
      })
      .on("end.cb", () => onEnd?.());
    if (!ms) {
      flying = false;
      updateTiles();
      onEnd?.();
    }
  }
  // + / −: zoom about the middle of the map, kept inside the map's bounds the
  // same way wheel and drag zooms are.
  function zoomBy(f) {
    const [cx, cy] = [L.W / 2, L.H / 2];
    const k = Math.max(zoom.scaleExtent()[0], Math.min(zoom.scaleExtent()[1], t.k * f));
    const [px, py] = t.invert([cx, cy]);
    const T = zoom.constrain()(d3.zoomIdentity.translate(cx, cy).scale(k).translate(-px, -py), zoom.extent()(), zoom.translateExtent());
    flyTo(T, { min: 350, max: 600 });
  }
  function resetZoom() {
    if (t.k === 1 && t.x === 0 && t.y === 0) return;
    flyTo(d3.zoomIdentity, { min: 700 });
  }
  function zoomToCouncils(names) {
    const fs = councils.filter((f) => names.includes(f.properties.council));
    if (!fs.length) return;
    const [[x0, y0], [x1, y1]] = path.bounds({ type: "FeatureCollection", features: fs });
    const [[ux0, uy0], [ux1, uy1]] = L.usable;
    const k = Math.max(1, Math.min(COUNCIL_MAX_ZOOM, 0.82 / Math.max((x1 - x0) / (ux1 - ux0), (y1 - y0) / (uy1 - uy0))));
    const T = d3.zoomIdentity
      .translate((ux0 + ux1) / 2, (uy0 + uy1) / 2)
      .scale(k)
      .translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
    flyTo(T, { min: 800 });
  }

  // ---------- filtering + pop animation ----------
  // A circle's radius: its size, times zoom growth, times its pop-in progress
  // __p (0 hidden → 1 shown, overshooting on the way in). Lens circles sit
  // inside the lens's scale(k), so they are divided back to screen size.
  function radiusOf(d) {
    const p = Math.max(0, d.__p);
    if (d.lens) return (d.s.r / lens.k) * p;
    return (screenR(d.r, t.k) / t.k) * p;
  }

  function applyView(mode) {
    const appear = [];
    const vanish = [];
    const instant = [];
    svg.selectAll("circle.site").each(function (d) {
      const on = view.match(d.s ?? d);
      const off = this.classList.contains("off");
      if (on === !off) return;
      // Lens circles outside the source circle change instantly (nobody sees them).
      if (d.lens && Math.hypot(d.s.x - lens.sx, d.s.y - lens.sy) > lens.r0 + 20) {
        instant.push([this, on]);
        return;
      }
      (on ? appear : vanish).push(this);
    });
    for (const [el, on] of instant) {
      el.__data__.__p = on ? 1 : 0;
      el.classList.toggle("off", !on);
      d3.select(el).interrupt("pop").attr("r", radiusOf(el.__data__));
    }
    const animate = mode !== "instant" && !reducedMotion();
    // Sweep in from west to east, like the registers being switched on.
    const span = !animate ? 0 : mode === "intro" ? 1400 : Math.min(700, 120 + appear.length * 2);
    const xs = appear.map((el) => (el.__data__.s ?? el.__data__).x);
    const [x0, x1] = d3.extent(xs);
    const tween = (to) =>
      function (d) {
        const from = d.__p;
        return (k) => {
          d.__p = from + (to - from) * k;
          return radiusOf(d);
        };
      };
    d3.selectAll(vanish)
      .classed("off", true)
      .interrupt("pop")
      .transition("pop")
      .duration(animate ? 240 : 0)
      .ease(d3.easeCubicIn)
      .attrTween("r", tween(0));
    d3.selectAll(appear)
      .classed("off", false)
      .interrupt("pop")
      .transition("pop")
      .delay((d, i) => (x1 > x0 ? ((xs[i] - x0) / (x1 - x0)) * span : 0) + (animate ? Math.random() * 80 : 0))
      .duration(animate ? 560 : 0)
      .ease(d3.easeBackOut.overshoot(1.8))
      .attrTween("r", tween(1));
    shown = sites.filter(view.match);
    delaunay = d3.Delaunay.from(shown, (s) => s.x, (s) => s.y);
    svg.classed("missing", !!view.missing);
    renderAnnotations(span * 0.6 + 200);
    pinned = null;
    hideTip();
  }

  // ---------- callouts ----------
  function renderAnnotations(delay) {
    annoG.selectAll("*").remove();
    annoItems = (view.annotations ?? []).map((a, i) => {
      const [x, y] = projection([a.lon, a.lat]);
      const g = annoG
        .append("g")
        .attr("class", "anno")
        .style("animation-delay", `${Math.round(delay + i * 110)}ms`);
      const line = g.append("path").attr("class", "anno-line");
      const text = g.append("text");
      text.append("tspan").attr("class", "anno-title").text(a.title);
      text.append("tspan").attr("class", "anno-sub").attr("dy", "1.25em").text(a.sub);
      return { ...a, x, y, g, line, text, w: Math.max(a.title.length * 7, a.sub.length * 7.4) };
    });
    positionAnnotations();
  }

  function positionAnnotations() {
    if (!annoItems?.length) return;
    const [cx, cy] = t.apply(landCentroid);
    const g = 1;
    const [safeL, safeR] = L.safe;
    const placed = [];
    for (const a of annoItems) {
      const [sx, sy] = t.apply([a.x, a.y]);
      const inView = sx > 0 && sx < L.W && sy > 0 && sy < L.H;
      a.g.attr("display", inView ? null : "none");
      if (!inView) continue;
      const r = screenR(a.site?.r ?? a.r ?? 0, t.k) * g;
      const rise = sy < cy ? -1 : 1;
      // Where the text would sit for a given side, clamped to the screen.
      const layout = (side) => {
        const ex = sx + side * (r + 22);
        let ey = sy + rise * (r + 14);
        for (const p of placed) {
          if (p.side === side && Math.abs(p.ey - ey) < 40 && Math.abs(p.ex - ex) < a.w + 20) ey = p.ey + (rise > 0 ? 40 : -40);
        }
        let tx = ex + side * 14;
        if (side > 0 && tx + a.w > safeR) tx = safeR - a.w;
        if (side < 0 && tx - a.w < safeL) tx = safeL + a.w;
        const x0 = side > 0 ? tx : tx - a.w;
        return { side, ex, ey, tx, box: [x0, ey - 16, x0 + a.w, ey + 22] };
      };
      const fits = (o) => o.box[0] >= safeL - 1 && o.box[2] <= safeR + 1;
      // The magnifier lens sits on top of callouts, so steer clear of it.
      const underLens = (o) =>
        lensVisible() &&
        o.box[2] > lens.cx - lens.r &&
        o.box[0] < lens.cx + lens.r &&
        o.box[3] > lens.cy - lens.r - 24 &&
        o.box[1] < lens.cy + lens.r;
      const first = layout(sx >= cx ? 1 : -1);
      const other = layout(-first.side);
      const ok = (o) => fits(o) && !underLens(o);
      const pick = ok(first) ? first : ok(other) ? other : !underLens(first) ? first : other;
      placed.push(pick);
      const { side, ex, ey, tx } = pick;
      a.line.attr("d", `M${sx + side * r * 0.72},${sy + rise * r * 0.72}L${ex},${ey}h${side * 10}`);
      a.text.attr("text-anchor", side > 0 ? "start" : "end");
      a.text
        .selectAll("tspan")
        .attr("x", tx)
        .filter((d, i) => i === 0)
        .attr("y", ey - 4);
    }
  }

  // ---------- hover / click / drag ----------
  function siteAt(p) {
    if (!shown.length) return null;
    if (inLens(p)) {
      // Undo the magnification, then search as usual.
      const bx = lens.sx + (p[0] - lens.cx) / lens.k;
      const by = lens.sy + (p[1] - lens.cy) / lens.k;
      const s = shown[delaunay.find(bx, by)];
      const lx = lens.cx + (s.x - lens.sx) * lens.k;
      const ly = lens.cy + (s.y - lens.sy) * lens.k;
      return Math.hypot(lx - p[0], ly - p[1]) < Math.max(12, s.r + 5) ? { s, x: lx, y: ly, r: s.r } : { inLens: true };
    }
    const [bx, by] = t.invert(p);
    const s = shown[delaunay.find(bx, by)];
    const [sx, sy] = t.apply([s.x, s.y]);
    const r = screenR(s.r, t.k);
    return Math.hypot(sx - p[0], sy - p[1]) < Math.max(12, r + 5) ? { s, x: sx, y: sy, r } : null;
  }

  function placeTip(vx, vy) {
    // Map units → CSS px (the SVG may be scaled slightly after a small resize).
    const box = svgEl.getBoundingClientRect();
    const k = box.width / L.W;
    const [x, y, cw, ch] = [vx * k, vy * k, box.width, box.height];
    const tw = tipEl.offsetWidth;
    const th = tipEl.offsetHeight;
    let left = x + 18;
    let top = y + 18;
    if (left + tw > cw - 8) left = x - tw - 18;
    if (top + th > ch - 8) top = y - th - 18;
    tip.style("left", `${Math.max(8, left)}px`).style("top", `${Math.max(8, top)}px`);
  }

  function showSite(hit, isPinned) {
    const { s, x, y, r } = hit;
    councilHi.classed("on", false);
    hoverRing.attr("cx", x).attr("cy", y).attr("opacity", 1).attr("r", r + 4);
    const same = shown.filter((o) => o !== s && Math.abs(o.x - s.x) < 0.3 && Math.abs(o.y - s.y) < 0.3);
    const meta = [s.ref && `Ref ${esc(s.ref)}`, s.date && `listed since ${longDate(s.date)}`].filter(Boolean).join(" · ");
    tip.html(
      `<div class="t-council">${esc(s.council)}</div>` +
        `<div class="t-address">${s.addr ? esc(s.addr) : "Address not published"}</div>` +
        `<div class="t-value">${s.v == null ? "No value published" : euro(s.v, true)}</div>` +
        (meta ? `<div class="t-meta">${meta}</div>` : "") +
        (same.length
          ? `<div class="t-more">+ ${same.length} more ${same.length === 1 ? "site" : "sites"} placed at this point</div>`
          : "") +
        (isPinned ? "" : `<div class="t-cta">${icon("pin")} Click to pin</div>`),
    );
    tip.attr("hidden", null);
    placeTip(x, y);
  }

  function showCouncil(c, p) {
    hoverRing.attr("opacity", 0);
    councilHi.attr("d", path(c)).classed("on", true);
    const name = c.properties.council;
    if (c.properties.unpublished) {
      tip.html(
        `<div class="t-council">${esc(name)}</div>` +
          `<div class="t-address">Register not published online</div>` +
          `<div class="t-meta">The council keeps a register, but it can only be inspected in person or on request, so none of its sites can be mapped.</div>`,
      );
    } else {
      const st = statsBy.get(name);
      const n = sitesByCouncil.get(name) ?? 0;
      tip.html(
        `<div class="t-council">${esc(name)}</div>` +
          `<div class="t-address">${int(n)} sites mapped${st?.review ? `, ${int(st.review)} held back` : ""}</div>` +
          `<div class="t-value">${st?.valuation ? `${euro(st.valuation, true)} on the register` : "No values published"}</div>` +
          `<div class="t-cta">Click to zoom in and show only ${esc(shortName(name))}</div>`,
      );
    }
    tip.attr("hidden", null);
    placeTip(p[0], p[1]);
  }

  function hideTip() {
    tip.attr("hidden", "");
    hoverRing?.attr("opacity", 0);
    councilHi?.classed("on", false);
  }

  const councilOf = (e) => (e.target?.classList?.contains("council") ? e.target.__data__ : null);
  const pt = (e) => d3.pointer(e, svgEl);

  svg.on("pointerdown.lens", (e) => {
    const p = pt(e);
    const what = onSource(p) ? "src" : inLens(p) ? "body" : null;
    if (!what) return;
    const [ox, oy] = what === "src" ? [lens.sx, lens.sy] : [lens.cx, lens.cy];
    drag = { what, id: e.pointerId, dx: p[0] - ox, dy: p[1] - oy, start: p, moved: 0 };
    svgEl.setPointerCapture(e.pointerId);
    svg.classed("dragging", true);
    hideTip();
    pinned = null;
    e.preventDefault();
  });
  svg.on("pointermove", (e) => {
    const p = pt(e);
    if (drag) {
      drag.moved = Math.max(drag.moved, Math.hypot(p[0] - drag.start[0], p[1] - drag.start[1]));
      if (drag.what === "src") setLensSource(p[0] - drag.dx, p[1] - drag.dy);
      else setLensBody(p[0] - drag.dx, p[1] - drag.dy);
      if (drag.moved > 4 && !lens.moved) {
        lens.moved = true;
        lensHint.classed("gone", true);
        lensSrc.select(".lens-src-pulse").classed("gone", true);
      }
      return;
    }
    if (pinned || e.buttons) return;
    svg.classed("over-src", onSource(p));
    svg.classed("over-lens", inLens(p));
    if (onSource(p)) return hideTip();
    const hit = siteAt(p);
    if (hit?.s) return showSite(hit, false);
    if (hit?.inLens) return hideTip();
    const c = councilOf(e);
    // County tooltips only on the whole-island view; zoomed in, they'd get in
    // the way of exploring the streets.
    c && t.k <= 1.05 ? showCouncil(c, p) : hideTip();
  });
  const endDrag = (e) => {
    if (!drag) return;
    const wasTap = drag.moved < 5 && drag.what === "body";
    svgEl.releasePointerCapture?.(drag.id);
    drag = null;
    svg.classed("dragging", false);
    if (wasTap && e.type === "pointerup") {
      const hit = siteAt(pt(e));
      if (hit?.s) {
        pinned = hit;
        showSite(hit, true);
      }
    }
  };
  svg.on("pointerup", endDrag).on("pointercancel", endDrag);
  svg.on("pointerleave", () => {
    if (!pinned && !drag) hideTip();
  });
  svg.on("click", (e) => {
    const p = pt(e);
    if (onSource(p) || inLens(p)) return; // handled by the drag code
    const hit = siteAt(p);
    if (hit?.s) {
      pinned = hit;
      return showSite(hit, true);
    }
    if (pinned) {
      pinned = null;
      hideTip();
      return;
    }
    const c = councilOf(e);
    if (c && !c.properties.unpublished && t.k <= 1.05) onCouncilClick(c.properties.council);
    else if (!c) onBackgroundClick();
  });
  // Touches that start on the magnifier drag it instead of scrolling the page.
  svgEl.addEventListener(
    "touchstart",
    (e) => {
      const touch = e.touches[0];
      const box = svgEl.getBoundingClientRect();
      const p = [((touch.clientX - box.left) * L.W) / box.width, ((touch.clientY - box.top) * L.H) / box.height];
      if (onSource(p) || inLens(p)) e.preventDefault();
    },
    { passive: false },
  );
  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && pinned) {
      pinned = null;
      hideTip();
    }
  });

  // Pin the zoom buttons to the bottom of the map drawing itself (on narrow
  // layouts the container also holds the valuation panel underneath).
  const credit = d3.select(container).select(".map-credit");
  const placeControls = () => {
    const h = svgEl.getBoundingClientRect().height;
    // On phones the bottom of the map holds the magnifier, so "Reset view" sits up top.
    ctl.style("top", L.mode === "narrow" ? "72px" : `${h - 64}px`);
    credit.style("top", L.mode === "wide" ? null : `${h - 24}px`);
  };

  render();
  placeControls();
  let raf = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      render();
      placeControls();
    });
  }).observe(container);

  return {
    setView(next, { zoomTo = null, resetView = false } = {}) {
      view = { ...view, ...next };
      if (!introPending) applyView("change");
      if (zoomTo?.length) zoomToCouncils(zoomTo);
      else if (resetView) resetZoom();
    },
    // Back to the opening view: whole island, no tooltip, magnifier over Dublin.
    reset() {
      pinned = null;
      hideTip();
      svg.classed("previewing", false);
      resetZoom();
      if (L.lens) {
        lens.fx = null;
        lensG.interrupt("move");
        setLensBody(L.lens.cx, L.lens.cy);
        setLensSource(...projection(DUBLIN));
      }
    },
    preview(fn) {
      svg.classed("previewing", !!fn);
      if (fn) svg.selectAll("circle.site").classed("pv", (d) => fn(d.s ?? d));
    },
    councils,
    get mode() {
      return L.mode;
    },
    // Radius in px of a site's circle on the unzoomed map (null value: a ring).
    sizeFor: (v) => sizeFor(v),
    // Zoom in on one site and pin its details (used by search).
    focusSite(s) {
      if (!shown.includes(s)) return false;
      // Fly down to street level (tile zoom 16), where the streets show.
      const k = Math.pow(2, Math.min(16, TILE_MAX) - zoomBase);
      const [[ux0, uy0], [ux1, uy1]] = L.usable;
      const T = d3.zoomIdentity
        .translate((ux0 + ux1) / 2, (uy0 + uy1) / 2)
        .scale(k)
        .translate(-s.x, -s.y);
      flyTo(T, {
        min: 900,
        onEnd: () => {
          const [x, y] = t.apply([s.x, s.y]);
          pinned = { s, x, y, r: screenR(s.r, t.k) };
          showSite(pinned, true);
        },
      });
      return true;
    },
  };
}
