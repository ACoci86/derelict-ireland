// The essay's smaller pieces: lines quoted from the registers, a sentence
// that rewrites itself for any council, and the night map of the gaps.
import * as d3 from "d3";
import * as topojson from "topojson-client";
import { euro, int, longDate, monthYear } from "./format.js";
import { icon } from "./icons.js";
import { fitSelect } from "./charts.js";

const esc = (t) =>
  String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const WORDS = "no one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty".split(" ");
const word = (n) => (n <= 20 ? WORDS[n] : int(n));

// "Leitrim" -> "Leitrim County Council"
const authority = (c) => (/City|County$/.test(c) ? `${c} Council` : `${c} County Council`);

const siteText = (s) => (/register ref/.test(s.addr) ? "No address given" : s.addr.replace(/,?\s*Co\.?\s+\w+(\s+[A-Z]\d{2})?$/, ""));
function rowHTML(s, { i = 0, mixed = false, levy = false, quiet = false } = {}) {
  const value = s.v == null ? "no value published" : `valued at ${euro(s.v, true)}`;
  const label = `${s.ref}: ${siteText(s)}, ${authority(s.council)}. ${s.date ? `Entered ${longDate(s.date)}` : "No entry date"}, ${value}. Find it on the map.`;
  const attrs = quiet ? `aria-hidden="true" tabindex="-1"` : `aria-label="${esc(label)}"`;
  return `<button type="button" class="reg-r" data-i="${i}" ${attrs}>
    <span class="r-ref">${esc(s.ref)}</span>
    <span class="r-site">${esc(siteText(s))}${mixed ? `<small>${esc(authority(s.council))}</small>` : ""}</span>
    <span class="r-date">${s.date ? esc(longDate(s.date)) : "No date"}</span>
    <span class="r-val${s.v == null ? " none" : ""}">${s.v == null ? "None published" : euro(s.v, true)}</span>
    ${levy ? `<span class="r-levy">${s.v == null ? "" : euro(s.v * 0.07, true)}</span>` : ""}
    <span class="r-go">${icon("toMap")}<i>map</i></span>
  </button>`;
}
const HEAD = (levy) =>
  `<div class="reg-h" aria-hidden="true"><span>Ref.</span><span>Site</span><span>Entered</span><span>Value</span>${levy ? "<span>Levy a year</span>" : ""}<span></span></div>`;

// ---------------------------------------------------------------------------
// A line from a register, set out the way the registers set them out:
// reference, site, date entered, value. Each row finds its site on the map.
//   <div data-reg="Leitrim|DS30"></div>                 one entry
//   <div data-reg="Galway City|760;Mayo|DS19/59" data-levy></div>   several, with the levy
// ---------------------------------------------------------------------------
export function registerLines(root, { sites, onSite }) {
  for (const el of root.querySelectorAll("[data-reg]")) {
    const picked = el.dataset.reg
      .split(";")
      .map((k) => k.split("|"))
      .map(([council, ref]) => sites.find((s) => s.council === council && s.ref === ref))
      .filter(Boolean);
    if (!picked.length) {
      el.remove();
      continue;
    }
    const levy = "levy" in el.dataset;
    const mixed = new Set(picked.map((s) => s.council)).size > 1;
    const source = mixed ? "From the councils' registers of derelict sites" : `From ${authority(picked[0].council)}'s register of derelict sites`;
    el.classList.add("reg");
    if (levy) el.classList.add("reg-wide");
    el.innerHTML = `
      <p class="reg-src">${esc(source)}</p>
      <div class="reg-t${levy ? " has-levy" : ""}">${HEAD(levy)}${picked.map((s, i) => rowHTML(s, { i, mixed, levy })).join("")}</div>`;
    for (const b of el.querySelectorAll(".reg-r")) b.addEventListener("click", () => onSite(picked[+b.dataset.i]));
  }
}

// ---------------------------------------------------------------------------
// "Your council": one sentence that starts with a council you choose.
// ---------------------------------------------------------------------------
export function councilPicker(el, { sites, summary, onShow, onChange }) {
  const names = [...summary.councils.map((c) => c.council), ...summary.unpublishedSources.map((o) => o.council)].sort((a, b) =>
    a.localeCompare(b),
  );
  const byName = new Map(summary.councils.map((c) => [c.council, c]));
  el.innerHTML = `<span class="ml-sel"><select aria-label="Choose a council">${names
    .map((n) => `<option${n === "Dublin City" ? " selected" : ""}>${esc(n)}</option>`)
    .join("")}</select></span> <span class="ml-out" aria-live="polite"></span>`;
  const select = el.querySelector("select");
  const out = el.querySelector(".ml-out");
  const fit = () => fitSelect(select);
  const update = () => {
    fit();
    const name = select.value;
    const c = byName.get(name);
    onChange?.(name);
    if (!c) {
      out.innerHTML = `keeps a register, but it can only be seen at the council's offices or on request, so none of its sites are on the map.`;
      return;
    }
    const mine = sites.filter((s) => s.council === name);
    const valued = mine.filter((s) => s.v != null);
    const dated = mine.filter((s) => s.date);
    let t = `has <b>${int(c.mapped)}</b> derelict sites on the map`;
    t += valued.length
      ? `, ${int(valued.length)} of them valued at <b>${euro(d3.sum(valued, (s) => s.v), true)}</b> in all.`
      : `, and doesn't publish a value for any of them.`;
    if (dated.length) {
      const old = d3.least(dated, (s) => s.date);
      const byYear = d3.rollup(dated, (v) => v.length, (s) => s.date.slice(0, 4));
      const [y, n] = [...byYear].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
      const where = old.addr && !/register ref/.test(old.addr) ? `, ${esc(old.addr.split(",")[0])},` : "";
      t += ` Its oldest entry${where} went on in ${monthYear(old.date)}, and its busiest year was ${y}, with ${word(n)} new ${n === 1 ? "site" : "sites"}.`;
    } else {
      t += " Its register gives no entry dates.";
    }
    out.innerHTML = `${t} <button type="button" class="inl">show them</button>`;
    out.querySelector(".inl").addEventListener("click", () => onShow(name));
  };
  select.addEventListener("change", update);
  document.fonts?.ready.then(fit);
  update();
}

// ---------------------------------------------------------------------------
// Pull a line: a random entry from the chosen council's register. The row
// spins through other entries like a slot machine and stops on one, beside a
// street map of where it is.
// ---------------------------------------------------------------------------
const TILE = 256;
function streetCrop(s, z = 16) {
  const n = 2 ** z * TILE;
  const x = ((s.lon + 180) / 360) * n;
  const sin = Math.sin((s.lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * n;
  const [W, H] = [420, 320];
  let imgs = "";
  for (let tx = Math.floor((x - W / 2) / TILE); tx <= Math.floor((x + W / 2) / TILE); tx++)
    for (let ty = Math.floor((y - H / 2) / TILE); ty <= Math.floor((y + H / 2) / TILE); ty++)
      imgs += `<img src="https://tile.openstreetmap.org/${z}/${tx}/${ty}.png" alt="" decoding="async" style="left:${Math.round(tx * TILE - x)}px;top:${Math.round(ty * TILE - y)}px">`;
  return imgs;
}
const PRECISION = {
  c: "Where the council's own coordinates put it.",
  a: "Placed from its full address.",
  s: "Placed on its street, not at the building.",
  t: "Placed in its town or townland only: the register gives no exact spot.",
};

export function linePuller(el, { sites, onSite }) {
  const reduce = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const byCouncil = d3.group(sites, (s) => s.council);
  el.innerHTML = `
    <div class="pull-map" aria-hidden="true"><div class="pull-tiles"></div><span class="pull-dot"></span></div>
    <div class="pull-body">
      <p class="reg-src"></p>
      <div class="reg-t">${HEAD(false)}<div class="pull-win"></div></div>
      <p class="pull-note"></p>
      <button type="button" class="gbtn pull-go">${icon("reset")}<span>Pull another line</span></button>
    </div>`;
  const win = el.querySelector(".pull-win");
  const src = el.querySelector(".reg-src");
  const note = el.querySelector(".pull-note");
  const go = el.querySelector(".pull-go");
  const tiles = el.querySelector(".pull-tiles");
  const mapEl = el.querySelector(".pull-map");
  let council = null;
  let bag = [];
  let current = null;
  let spinning = false;
  let seen = false;

  // Draw entries without repeats until the council's list runs out.
  const next = () => {
    if (!bag.length) bag = d3.shuffle([...(byCouncil.get(council) ?? [])]);
    let s = bag.pop();
    if (s === current && bag.length) s = bag.pop();
    return s;
  };
  const land = (s) => {
    current = s;
    win.style.height = "";
    win.innerHTML = rowHTML(s);
    win.querySelector(".reg-r").addEventListener("click", () => onSite(s));
    note.textContent = PRECISION[s.p] ?? "";
    tiles.innerHTML = streetCrop(s);
    mapEl.classList.remove("ping");
    void mapEl.offsetWidth; // restart the ripple
    mapEl.classList.add("ping");
    mapEl.classList.remove("fading");
  };
  const pull = (animate) => {
    const list = byCouncil.get(council);
    if (!list?.length || spinning) return;
    const target = next();
    if (!animate || reduce() || list.length < 2) return land(target);
    // Measure the landing row, then spin a strip of others above it.
    spinning = true;
    go.disabled = true;
    win.innerHTML = rowHTML(target, { quiet: true });
    const h = win.firstElementChild.offsetHeight;
    const decoys = d3.range(13).map(() => d3.shuffle([...list])[0]);
    win.style.height = `${h}px`;
    win.innerHTML = `<div class="pull-strip">${[...decoys, target]
      .map((s) => `<div class="pull-cell" style="height:${h}px">${rowHTML(s, { quiet: true })}</div>`)
      .join("")}</div>`;
    const strip = win.firstElementChild;
    mapEl.classList.add("fading");
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        strip.style.transform = `translateY(${-decoys.length * h}px)`;
      }),
    );
    strip.addEventListener(
      "transitionend",
      () => {
        spinning = false;
        go.disabled = false;
        land(target);
      },
      { once: true },
    );
  };
  go.addEventListener("click", () => pull(true));

  return {
    // Called by the council sentence whenever its council changes.
    setCouncil(name) {
      if (name === council) return;
      council = name;
      bag = [];
      const n = byCouncil.get(name)?.length ?? 0;
      el.classList.toggle("is-empty", !n);
      if (!n) {
        src.textContent = `${authority(name)}'s register isn't online, so there's no line to pull.`;
        win.innerHTML = "";
        note.textContent = "";
        tiles.innerHTML = "";
        go.disabled = true;
        return;
      }
      go.disabled = false;
      src.textContent = `A line from ${authority(name)}'s register, one of ${int(n)} on the map`;
      if (seen) pull(true);
    },
    // The first line only loads its street map once the reader gets here.
    start() {
      seen = true;
      if (council && byCouncil.get(council)?.length) pull(false);
    },
  };
}

// ---------------------------------------------------------------------------
// The island at night: every mapped site as a faint light, the councils
// with no register online hatched and named.
// ---------------------------------------------------------------------------
export function offlineMap(el, { base, sites, offline }) {
  const geoms = base.objects.councils.geometries;
  const off = new Set(offline.map((o) => o.council));
  const all = topojson.feature(base, base.objects.councils);
  const ni = base.objects.context.geometries.filter((g) => g.properties.kind === "ni");
  const W = 400;
  const H = 500;
  const proj = d3.geoTransverseMercator().rotate([8, -53.5]).fitExtent(
    [
      [10, 10],
      [W - 10, H - 10],
    ],
    ni.length ? { type: "FeatureCollection", features: [...all.features, topojson.feature(base, { type: "GeometryCollection", geometries: ni })] } : all,
  );
  const path = d3.geoPath(proj);
  const svg = d3
    .select(el)
    .append("svg")
    .attr("viewBox", `0 0 ${W} ${H}`)
    .attr("role", "img")
    .attr("aria-label", `Map of Ireland: ${offline.map((o) => o.council).join(", ")} have no sites on the map because their registers aren't online.`);
  svg
    .append("defs")
    .html(
      `<pattern id="o-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line y2="6" stroke="var(--accent-soft)" stroke-width="1.6"/></pattern>`,
    );
  if (ni.length) svg.append("path").attr("class", "o-context").attr("d", path(topojson.merge(base, ni)));
  svg.append("path").attr("class", "o-land").attr("d", path(topojson.merge(base, geoms)));
  svg.append("path").attr("class", "o-borders").attr("d", path(topojson.mesh(base, base.objects.councils, (a, b) => a !== b)));
  // The sites come on in five scattered batches: five groups fading in one
  // after another look like lights coming on, and cost far less than
  // animating 2,400 dots one by one.
  const BATCHES = 5;
  const batch = d3.range(BATCHES).map(() => []);
  sites.forEach((s) => batch[Math.floor(Math.random() * BATCHES)].push(s));
  svg
    .append("g")
    .selectAll("g")
    .data(batch)
    .join("g")
    .attr("class", "o-sites")
    .style("transition-delay", (d, i) => `${i * 90}ms`)
    .selectAll("circle")
    .data((d) => d)
    .join("circle")
    .attr("class", "o-site")
    .attr("r", 1.3)
    .attr("transform", (s) => `translate(${proj([s.lon, s.lat])})`);
  for (const name of off) {
    const shape = topojson.merge(
      base,
      geoms.filter((g) => g.properties.council === name),
    );
    svg.append("path").attr("class", "o-off").attr("pathLength", 1).attr("d", path(shape));
    const [x, y] = path.centroid(shape);
    // Galway County's centroid sits over Galway City; nudge the label west.
    const dx = name === "Galway County" ? -26 : 0;
    svg
      .append("text")
      .attr("class", "o-label")
      .attr("x", x + dx)
      .attr("y", y)
      .attr("dy", "0.35em")
      .attr("text-anchor", "middle")
      .text(name.replace(" County", ""));
  }
}
