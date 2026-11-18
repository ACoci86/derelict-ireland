import { createMap } from "./map.js";
import { createScale, CATEGORIES } from "./scale.js";
import { createSearch } from "./search.js";
import { euro, int, monthYear } from "./format.js";
import { valueDots, councilMultiples, siteName, onceVisible } from "./charts.js";
import { yearDots, councilDots } from "./dots.js";
import { registerLines, councilPicker, offlineMap, linePuller } from "./story.js";

const BASE = import.meta.env.BASE_URL;
const getJSON = (p) => fetch(`${BASE}data/${p}`).then((r) => r.json());

const [base, siteData, summary] = await Promise.all([
  getJSON("base.json"),
  getJSON("sites.json"),
  getJSON("summary.json"),
]);
// Let the page paint once (header, headline, the map's sea) before the map is
// built: on a slow phone the build is a long task, and the data now arrives
// early enough that it would otherwise hold up the very first paint.
await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

const sites = siteData.rows.map(([lon, lat, ci, v, date, addr, ref, p], i) => ({
  i,
  lon,
  lat,
  council: siteData.councils[ci],
  v,
  date,
  addr,
  ref,
  p,
}));
const valued = sites.filter((s) => s.v != null);
const mappedIn = (name) => sites.filter((s) => s.council === name).length;

// ---------- Numbers in the article ----------
const WORDS = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty".split(" ");
const word = (n, cap = false) => {
  const w = n <= 20 ? WORDS[n] : int(n);
  return cap ? w[0].toUpperCase() + w.slice(1) : w;
};
const pct = (a, b) => `${Math.round((a / b) * 100)}%`;
const cats = summary.categories;
const topOf = (c, name) => (cats[c].top.find(([n]) => n === name) ?? [, 0])[1];
const dated = sites.filter((s) => s.date);
const byYear = new Map();
for (const s of dated) byYear.set(+s.date.slice(0, 4), (byYear.get(+s.date.slice(0, 4)) ?? 0) + 1);
const [peakYear, peakN] = [...byYear].reduce((a, b) => (b[1] > a[1] ? b : a));
const since2023 = dated.filter((s) => s.date >= "2023").length;
const minValue = Math.min(...valued.map((s) => s.v));
const dublin = ["Dublin City", "Fingal", "South Dublin", "Dún Laoghaire-Rathdown"];

const numbers = {
  entries: int(summary.mapped + summary.review),
  published: int(summary.published),
  mapped: int(summary.mapped),
  review: int(summary.review),
  valued: int(summary.valued),
  unvalued: int(summary.unvalued),
  valueTotal: euro(summary.valueTotal, true),
  valueMedian: euro(summary.valueMedian, true),
  "under250.share": pct(valued.filter((s) => s.v < 250000).length, valued.length),
  "c1.count.word": word(cats.c1.count, true),
  "c1.galway.word": word(topOf("c1", "Galway City"), true),
  "c2.count": int(cats.c2.count),
  "c2.total": euro(cats.c2.total, true),
  "c2.share": pct(cats.c2.total, summary.valueTotal),
  "c3.min.count": word(valued.filter((s) => s.v === minValue).length),
  limerick: int(mappedIn("Limerick City and County")),
  "dublin.total": int(dublin.reduce((n, c) => n + mappedIn(c), 0)),
  dated: int(dated.length),
  since2023: `${int(since2023)} (${pct(since2023, dated.length)})`,
  peak: `${int(peakN)} in ${peakYear} alone`,
  "pre2000.word": word(summary.pre2000, true),
  "offline.word": word(summary.unpublished.length, true),
  "offline.lc": word(summary.unpublished.length),
  cavan: int(mappedIn("Cavan")),
  thisYear: String(new Date().getFullYear()),
  "prec.council": `${int(summary.precision.council)} (${pct(summary.precision.council, summary.mapped)})`,
  "prec.exact": int(summary.precision.exact),
  "prec.street": int(summary.precision.street),
  "prec.town": int(summary.precision.town),
  "pre2000.lc": word(summary.pre2000),
  undated: int(sites.length - dated.length),
  mayo: int(mappedIn("Mayo")),
  "mayo.held": int(summary.councils.find((c) => c.council === "Mayo")?.review ?? 0),
  "novalue.word": word(summary.councils.filter((c) => !valued.some((s) => s.council === c.council)).length, true),
};
for (const el of document.querySelectorAll("[data-n]")) {
  if (numbers[el.dataset.n] != null) el.textContent = numbers[el.dataset.n];
}

// ---------- Callouts on the map ----------
const callout = (s, sub, title = siteName(s)) => ({ lon: s.lon, lat: s.lat, title, sub, site: s });
const byValue = (a, b) => b.v - a.v;
const inCat = (key) => {
  const c = CATEGORIES.find((c) => c.key === key);
  return valued.filter((s) => s.v >= c.lo && s.v <= c.hi);
};
const topPerCouncil = (list, n) => {
  const seen = new Set();
  return list
    .slice()
    .sort(byValue)
    .filter((s) => !seen.has(s.council) && seen.add(s.council))
    .slice(0, n);
};
const ANNOTATIONS = {
  all: () => [], // the opening view stays unlabelled; callouts come with each category
  c1: () => topPerCouncil(inCat("c1"), 6).map((s) => callout(s, euro(s.v, true))),
  c2: () =>
    cats.c2.top.map(([council, n]) => {
      const s = inCat("c2").filter((x) => x.council === council).sort(byValue)[0];
      return callout(s, `${int(n)} sites in this bracket`, council);
    }),
  c3: () =>
    valued
      .filter((s) => s.v === minValue)
      .slice(0, 5)
      .map((s) => callout(s, euro(s.v, true))),
  old: () =>
    dated
      .filter((s) => s.date < "2000")
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, 5)
      .map((s) => callout(s, `listed ${monthYear(s.date)}`)),
  council: (name) =>
    topPerCouncil(
      valued.filter((s) => s.council === name),
      1,
    ).map((s) => callout(s, `${euro(s.v, true)}, the most valuable here`)),
};

// ---------- Filter state ----------
const ALL = { lo: null, hi: null, unvalued: true, council: null, era: null, missing: false, cat: null, label: null };
let state = { ...ALL };

const matches = (s) => {
  if (state.council && s.council !== state.council) return false;
  if (state.era === "pre2000" && !(s.date && s.date < "2000")) return false;
  if (s.v == null) return state.unvalued;
  if (state.lo != null && (s.v < state.lo || s.v > state.hi)) return false;
  return true;
};

function annotationsFor(s) {
  if (s.missing) return [];
  if (s.council) return ANNOTATIONS.council(s.council);
  if (s.cat) return ANNOTATIONS[s.cat]();
  if (s.era === "pre2000") return ANNOTATIONS.old();
  if (s.lo == null) return ANNOTATIONS.all();
  return [];
}

const map = createMap({
  container: document.getElementById("map"),
  svgEl: document.getElementById("viz"),
  tipEl: document.getElementById("tip"),
  base,
  sites,
  councilStats: summary.councils,
  onCouncilClick: (c) => setState(state.council === c ? { ...ALL } : { ...ALL, council: c, label: `${c} only` }),
  onBackgroundClick: () => {
    if (state.council) setState({ ...ALL });
  },
});

const CAT_LABELS = {
  c1: "€1 million and over",
  c2: "€100,000 to €1 million",
  c3: "Under €100,000",
};

const scale = createScale(document.getElementById("scale"), {
  sites,
  onBrush: (r) =>
    setState(
      r
        ? {
            ...ALL,
            lo: r.lo,
            hi: r.hi,
            unvalued: false,
            label: `${r.lo ? euro(r.lo) : "Any value"} to ${r.hi === Infinity ? "the top" : euro(r.hi)}`,
          }
        : { ...ALL },
    ),
  onCategory: (key) => explore(key, false),
  onToggle: (on) => setState({ ...state, unvalued: on }),
  onClear: () => setState({ ...ALL }),
  onPreview: (fn) => map.preview(fn),
});

function setState(next) {
  const prevCouncil = state.council;
  state = next;
  map.setView(
    { match: matches, annotations: annotationsFor(state), missing: state.missing },
    { zoomTo: state.council ? [state.council] : null, resetView: !state.council && !!prevCouncil },
  );
  scale.update({ ...state, shown: sites.filter(matches).length });
}

// Scroll up to the map first, then change it, so the change is seen.
function toMapThen(fn) {
  if (window.scrollY < 8) return fn();
  const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({ top: 0, behavior: smooth ? "smooth" : "auto" });
  const started = performance.now();
  const wait = () => {
    if (window.scrollY < 8 || performance.now() - started > 1500) fn();
    else requestAnimationFrame(wait);
  };
  requestAnimationFrame(wait);
}

function explore(key, scroll = true) {
  const apply = () => {
    if (key === "old") setState({ ...ALL, era: "pre2000", label: "Entered before 2000" });
    else if (key === "missing") setState({ ...ALL, missing: true, label: `The ${word(summary.unpublished.length)} registers not published online` });
    else {
      const c = CATEGORIES.find((c) => c.key === key);
      setState({ ...ALL, cat: key, lo: c.lo, hi: c.hi, unvalued: false, label: CAT_LABELS[key] });
    }
  };
  scroll ? toMapThen(apply) : apply();
}
const showCouncil = (c) => toMapThen(() => setState({ ...ALL, council: c, label: `${c} only` }));

for (const b of document.querySelectorAll("[data-explore]")) {
  b.addEventListener("click", () => explore(b.dataset.explore));
}

// Lay the scale out beside the map (wide) or under it.
const layoutScale = () => {
  scale.layout(map.mode === "wide");
  scale.setLegend(map.sizeFor);
};
layoutScale();
new ResizeObserver(layoutScale).observe(document.getElementById("map"));
setState({ ...ALL });

document.getElementById("year").textContent = String(new Date().getFullYear());

// ---------- Search ----------
// Show one site: clear any filter that hides it, then zoom to it and pin it.
const showSite = (s) =>
  toMapThen(() => {
    if (!matches(s)) setState({ ...ALL });
    map.focusSite(s);
  });

// Inline "see it on the map" links in the article name a site by council and ref.
for (const b of document.querySelectorAll("[data-site]")) {
  const [council, ref] = b.dataset.site.split("|");
  const s = sites.find((x) => x.council === council && x.ref === ref);
  if (s) b.addEventListener("click", () => showSite(s));
  else b.hidden = true;
}

createSearch(document.getElementById("search"), {
  sites,
  councils: summary.councils,
  offline: summary.unpublishedSources,
  onSite: showSite,
  onCouncil: (c) => toMapThen(() => setState({ ...ALL, council: c, label: `${c} only` })),
});

// ---------- The logo returns everything to how the page opened ----------
for (const mark of document.querySelectorAll(".mark")) {
  mark.addEventListener("click", (e) => {
    e.preventDefault();
    document.getElementById("search").reset?.();
    scale.collapse();
    toMapThen(() => {
      setState({ ...ALL });
      map.reset();
    });
  });
}

// ---------- The essay ----------
// Everything below the map is built after the map has painted, one piece per
// task, so none of it holds the map back or stalls its opening animation.
const essay = [
  // Lines quoted from the registers, and inline links that name one site.
  () => registerLines(document, { sites, onSite: showSite }),
  () =>
    yearDots(document.getElementById("chart-years"), sites, {
      onSite: showSite,
      ui: {
        root: document.getElementById("fig-years"),
        show: document.getElementById("guess-show"),
        skip: document.getElementById("guess-skip"),
        result: document.querySelector("#fig-years .guess-result"),
        pick: document.getElementById("guess-pick"),
        select: document.getElementById("years-filter"),
      },
    }),
  () =>
    councilDots(document.getElementById("chart-councils"), {
      sites,
      councils: summary.councils,
      offline: summary.unpublishedSources,
      sorterEl: document.querySelector("#fig-councils .sorter"),
      onPick: showCouncil,
      onSite: showSite,
    }),
  () =>
    valueDots(document.getElementById("chart-values"), sites, {
      onSite: showSite,
      levy: { say: document.getElementById("levy-say"), foot: document.getElementById("levy-foot") },
    }),
  () => offlineMap(document.getElementById("offline-map"), { base, sites, offline: summary.unpublishedSources }),
  () => {
    const puller = linePuller(document.getElementById("puller"), { sites, onSite: showSite });
    councilPicker(document.getElementById("council-pick"), { sites, summary, onShow: showCouncil, onChange: puller.setCouncil });
    onceVisible(document.getElementById("puller"), puller.start, 0.2);
  },
  () =>
    councilMultiples(document.getElementById("chart-multiples"), {
      base,
      sites,
      councils: summary.councils,
      offline: summary.unpublishedSources,
      onPick: showCouncil,
    }),
  // The night map lights up, and the council shapes fade in one after another,
  // when they scroll into view (only where motion is welcome).
  () => {
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) document.documentElement.classList.add("motion");
    document.querySelectorAll("#chart-multiples .mult").forEach((m, i) => (m.style.transitionDelay = `${i * 30}ms`));
    for (const id of ["offline-map", "fig-multiples"]) {
      const el = document.getElementById(id);
      onceVisible(el, () => el.classList.add("is-in"), 0.05);
    }
  },
];
const later = window.requestIdleCallback ?? ((fn) => setTimeout(fn, 1));
const arrivedAt = location.hash;
const buildNext = () => {
  const step = essay.shift();
  if (!step) {
    // A link straight to a section (#method) jumped there before the charts
    // above it existed; go back to it now that they do, unless the reader moved.
    if (arrivedAt && location.hash === arrivedAt) document.querySelector(arrivedAt)?.scrollIntoView();
    return;
  }
  step();
  later(buildNext, { timeout: 300 });
};
// The map starts its opening two frames after it's drawn; start the essay
// a frame after that, so the opening isn't held up.
requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => later(buildNext, { timeout: 300 }))));
