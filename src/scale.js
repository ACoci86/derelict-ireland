import * as d3 from "d3";
import { euro, int } from "./format.js";
import { icon } from "./icons.js";

// The valuation panel beside the map: a log axis with a histogram of how many
// sites sit at each value, a brush to filter, hover-to-preview, and the three
// categories the essay talks about. Vertical next to the map on wide screens,
// horizontal under it otherwise.
export const DOMAIN = [4e3, 4e6];
export const CATEGORIES = [
  { key: "c1", label: "1", pill: "€1 million+", lo: 1e6, hi: Infinity },
  { key: "c2", label: "2", pill: "€100k to €1m", lo: 1e5, hi: 1e6 - 0.01 },
  { key: "c3", label: "3", pill: "Under €100k", lo: 0, hi: 1e5 - 0.01 },
];

export function createScale(el, { sites, onBrush, onCategory, onToggle, onClear, onPreview }) {
  const valued = sites.filter((s) => s.v != null);
  const unvaluedCount = sites.length - valued.length;
  let state = null;
  let silent = false;
  let orient = null;
  let brush, pos, brushG, bars, bins;

  // Folded by default: just the key to the circles and a button that opens
  // the histogram and the categories (it opens by itself when a filter is on).
  el.innerHTML = `
    <div class="scale-head">
      <h3>Valuation</h3>
    </div>
    <div class="size-key">
      <svg class="key" aria-hidden="true"></svg>
    </div>
    <button type="button" class="scale-toggle" aria-expanded="false" aria-controls="scale-body">
      <span>Filter by value</span>${icon("chevron")}
    </button>
    <div class="scale-body" id="scale-body" inert>
    <div class="scale-body-inner">
    <p class="hint">Drag on the chart to filter</p>
    <svg class="hist"></svg>
    <div class="cats">
      ${CATEGORIES.map(
        (c) =>
          `<button type="button" class="row-btn" data-cat="${c.key}" aria-pressed="false"><span class="rb-label"><i class="rb-num">${c.label}</i>${c.pill}</span><span class="rb-n">${int(valued.filter((s) => s.v >= c.lo && s.v <= c.hi).length)}</span></button>`,
      ).join("")}
      <button type="button" class="row-btn toggle" aria-pressed="true"><span class="rb-label"><span class="ring"></span>Not valued</span><span class="rb-n">${int(unvaluedCount)}</span></button>
    </div>
    <div class="count" aria-live="polite"></div>
    </div>
    </div>
    <div class="active" hidden>
      <span class="active-label"></span>
      <button type="button" class="btn quiet clear">Show all</button>
    </div>`;
  const svg = d3.select(el).select("svg.hist");
  const body = el.querySelector(".scale-body");
  const fold = el.querySelector(".scale-toggle");
  // Opens with a height transition (CSS grid rows 0fr -> 1fr); while closed it
  // is inert, so keyboard and screen readers skip it.
  const isOpen = () => el.classList.contains("is-open");
  const setOpen = (open) => {
    body.inert = !open;
    fold.setAttribute("aria-expanded", String(open));
    el.classList.toggle("is-open", open);
    fold.querySelector("span").textContent = open ? "Hide the filters" : "Filter by value";
  };
  fold.addEventListener("click", () => setOpen(!isOpen()));
  const toggle = el.querySelector(".toggle");
  const count = el.querySelector(".count");
  const active = el.querySelector(".active");
  const activeLabel = el.querySelector(".active-label");
  const pills = [...el.querySelectorAll("[data-cat]")];
  toggle.addEventListener("click", () => onToggle(toggle.getAttribute("aria-pressed") !== "true"));
  el.querySelector(".clear").addEventListener("click", onClear);
  for (const p of pills) {
    p.addEventListener("click", () => onCategory(p.dataset.cat));
    const c = CATEGORIES.find((c) => c.key === p.dataset.cat);
    p.addEventListener("pointerenter", () => onPreview((s) => s.v != null && s.v >= c.lo && s.v <= c.hi));
    p.addEventListener("pointerleave", () => onPreview(null));
  }

  const clampV = (v) => Math.min(DOMAIN[1], Math.max(DOMAIN[0], v));

  function build(vertical) {
    orient = vertical ? "v" : "h";
    svg.selectAll("*").remove();
    const width = vertical ? 172 : Math.max(260, el.clientWidth - 32);
    const height = vertical ? 330 : 104;
    svg.attr("width", width).attr("height", height);

    const along = d3.scaleLog().domain(DOMAIN);
    if (vertical) along.range([height - 4, 4]);
    else along.range([4, width - 18]);
    pos = along;

    bins = d3
      .bin()
      .thresholds(d3.range(0, 31).map((i) => Math.exp(Math.log(DOMAIN[0]) + (i / 30) * Math.log(DOMAIN[1] / DOMAIN[0]))))
      .domain(DOMAIN)
      .value((s) => clampV(s.v))(valued);
    const barMax = vertical ? 60 : 48;
    const len = d3.scaleLinear().domain([0, d3.max(bins, (b) => b.length)]).range([0, barMax]);

    const axisPos = vertical ? 44 : height - 44;
    const g = svg.append("g");
    bars = g.append("g").selectAll("rect").data(bins).join("rect").attr("class", "bar-h");
    if (vertical) {
      bars
        .attr("x", axisPos + 3)
        .attr("y", (b) => along(b.x1) + 0.5)
        .attr("height", (b) => Math.max(0, along(b.x0) - along(b.x1) - 1))
        .attr("width", (b) => len(b.length));
    } else {
      bars
        .attr("x", (b) => along(b.x0) + 0.5)
        .attr("width", (b) => Math.max(0, along(b.x1) - along(b.x0) - 1))
        .attr("y", (b) => axisPos - 3 - len(b.length))
        .attr("height", (b) => len(b.length));
    }

    const axis = (vertical ? d3.axisLeft(along) : d3.axisBottom(along))
      .tickValues([1e4, 1e5, 1e6])
      .tickFormat((v) => euro(v))
      .tickSizeOuter(0)
      .tickSize(4);
    g.append("g")
      .attr("class", "axis")
      .attr("transform", vertical ? `translate(${axisPos},0)` : `translate(0,${axisPos})`)
      .call(axis);

    // Category brackets
    const catOff = vertical ? axisPos + barMax + 14 : axisPos + 30;
    for (const c of CATEGORIES) {
      const a = along(clampV(Math.max(c.lo, DOMAIN[0])));
      const b = along(clampV(Math.min(c.hi, DOMAIN[1])));
      const cg = g
        .append("g")
        .attr("class", "cat")
        .attr("role", "button")
        .attr("tabindex", 0)
        .attr("aria-label", `Category ${c.label}`)
        .on("click", () => onCategory(c.key))
        .on("pointerenter", () => onPreview((s) => s.v != null && s.v >= c.lo && s.v <= c.hi))
        .on("pointerleave", () => onPreview(null))
        .on("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onCategory(c.key);
          }
        });
      const inset = 3;
      if (vertical) {
        const [y0, y1] = [Math.min(a, b) + inset, Math.max(a, b) - inset];
        cg.append("path").attr("d", `M${catOff - 4},${y0}h4V${y1}h-4`).attr("fill", "none").attr("stroke", "var(--ink-55)");
        cg.append("text").attr("x", catOff + 8).attr("y", (y0 + y1) / 2).attr("dy", "0.35em").text(c.label);
        cg.append("rect").attr("x", catOff - 6).attr("y", y0).attr("width", 28).attr("height", y1 - y0).attr("fill", "transparent");
      } else {
        const [x0, x1] = [Math.min(a, b) + inset, Math.max(a, b) - inset];
        cg.append("path").attr("d", `M${x0},${catOff - 4}v4H${x1}v-4`).attr("fill", "none").attr("stroke", "var(--ink-55)");
        cg.append("text").attr("x", (x0 + x1) / 2).attr("y", catOff + 16).attr("text-anchor", "middle").text(c.label);
        cg.append("rect").attr("x", x0).attr("y", catOff - 6).attr("width", x1 - x0).attr("height", 28).attr("fill", "transparent");
      }
    }

    brush = (vertical ? d3.brushY() : d3.brushX())
      .extent(
        vertical
          ? [
              [axisPos - 2, 0],
              [axisPos + barMax + 6, height],
            ]
          : [
              [0, axisPos - barMax - 6],
              [width - 14, axisPos + 2],
            ],
      )
      .on("start", () => onPreview(null))
      .on("brush end", (e) => {
        if (silent || !e.sourceEvent) return;
        if (!e.selection) {
          if (e.type === "end") onBrush(null);
          return;
        }
        const vals = e.selection.map((p) => along.invert(p)).sort((x, y) => x - y);
        // Snap the ends of the domain to "everything beyond".
        const lo = vals[0] <= DOMAIN[0] * 1.02 ? 0 : vals[0];
        const hi = vals[1] >= DOMAIN[1] * 0.98 ? Infinity : vals[1];
        onBrush({ lo, hi });
      });
    brushG = g.append("g").attr("class", "brush").call(brush);

    // Hovering the histogram previews that bin's sites on the map.
    brushG
      .on("pointermove.preview", (e) => {
        if (e.buttons) return;
        const [px, py] = d3.pointer(e, brushG.node());
        const v = along.invert(vertical ? py : px);
        const bin = bins.find((b) => v >= b.x0 && v < b.x1);
        bars.classed("pv", (b) => b === bin);
        onPreview(bin ? (s) => s.v != null && clampV(s.v) >= bin.x0 && clampV(s.v) < bin.x1 : null);
      })
      .on("pointerleave.preview", () => {
        bars.classed("pv", false);
        onPreview(null);
      });
    if (state) update(state);
  }

  function update(s) {
    state = s;
    const range = s.lo != null ? [clampV(Math.max(s.lo, DOMAIN[0])), clampV(Math.min(s.hi, DOMAIN[1]))] : null;
    silent = true;
    if (brushG) brushG.call(brush.move, range ? [pos(range[0]), pos(range[1])].sort((x, y) => x - y) : null);
    silent = false;
    bars?.classed("in", (b) => !range || (b.x1 > range[0] && b.x0 < range[1]));
    for (const p of pills) p.setAttribute("aria-pressed", String(p.dataset.cat === s.cat));
    toggle.setAttribute("aria-pressed", String(s.unvalued));
    count.innerHTML = `Showing <strong>${int(s.shown)}</strong> of ${int(sites.length)} sites`;
    active.hidden = !s.label;
    activeLabel.textContent = s.label ?? "";
    if ((s.lo != null || s.cat || !s.unvalued) && !isOpen()) setOpen(true);
  }

  let lastW = 0;
  function layout(vertical) {
    const w = el.clientWidth;
    if (orient === (vertical ? "v" : "h") && (vertical || w === lastW)) return;
    lastW = w;
    build(vertical);
  }

  // A key to the map's circles at their real sizes: nested circles for three
  // values, and a hollow ring for sites with no published value.
  function setLegend(sizeFor) {
    const keySvg = d3.select(el).select("svg.key");
    keySvg.selectAll("*").remove();
    const vals = [3.5e6, 1e6, 1e5];
    const rs = vals.map((v) => sizeFor(v));
    const R = Math.max(...rs);
    if (!R) return;
    const ringR = sizeFor(null);
    const base = 2 * R + 4;
    const labelX = 2 * R + 14;
    const H = base + 26;
    keySvg.attr("width", "100%").attr("height", H);
    const g = keySvg.append("g").attr("transform", "translate(1,0)");
    vals.forEach((v, i) => {
      const r = rs[i];
      const top = base - 2 * r;
      g.append("circle").attr("class", "k-disc").attr("cx", R).attr("cy", base - r).attr("r", r);
      g.append("path").attr("class", "k-lead").attr("d", `M${R},${top}H${labelX - 4}`);
      g.append("text").attr("class", "k-text").attr("x", labelX).attr("y", top).attr("dy", "0.35em").text(euro(v));
    });
    const ry = base + 16;
    g.append("circle").attr("class", "k-ring").attr("cx", R).attr("cy", ry).attr("r", Math.max(2.5, ringR));
    g.append("text").attr("class", "k-text").attr("x", labelX).attr("y", ry).attr("dy", "0.35em").text("no value published");
  }

  return { update, layout, setLegend, collapse: () => setOpen(false) };
}
