import * as d3 from "d3";
import * as topojson from "topojson-client";
import { euro, int, longDate } from "./format.js";

// Shared chart tooltip (position: fixed, follows the pointer).
const ctip = document.getElementById("ctip");
export function showTip(e, html) {
  ctip.innerHTML = html;
  ctip.hidden = false;
  const pad = 14;
  const w = ctip.offsetWidth;
  const h = ctip.offsetHeight;
  let x = e.clientX + pad;
  let y = e.clientY + pad;
  if (x + w > innerWidth - 8) x = e.clientX - w - pad;
  if (y + h > innerHeight - 8) y = e.clientY - h - pad;
  x = Math.max(8, Math.min(x, innerWidth - w - 8));
  y = Math.max(8, y);
  ctip.style.left = `${x}px`;
  ctip.style.top = `${y}px`;
}
export const hideTip = () => (ctip.hidden = true);
export const esc = (t) =>
  String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// Redraw on width changes only.
export function responsive(el, draw) {
  let last = 0;
  const run = () => {
    const w = Math.round(el.clientWidth);
    if (!w || w === last) return;
    last = w;
    el.innerHTML = "";
    draw(w);
  };
  run();
  new ResizeObserver(run).observe(el);
}

// Pointer behaviour shared by every dot chart. With a mouse, hovering shows a
// dot's site and a click goes to it on the map. With a finger, the first tap
// shows the site and a second tap on the same dot goes to it.
export function dotPointer(hit, { find, mark, tip, onPick, canPick = () => true, enabled = () => true }) {
  let kind = "mouse";
  let armed = null;
  const clear = () => {
    armed = null;
    mark(null);
    hideTip();
  };
  hit
    .on("pointerdown.kind", (e) => (kind = e.pointerType || "mouse"))
    .on("pointermove.dots", (e) => {
      if (e.pointerType === "touch" || !enabled(e)) return;
      const d = find(...d3.pointer(e));
      mark(d);
      hit.style("cursor", d && canPick(d) ? "pointer" : null);
      if (d) showTip(e, tip(d));
      else hideTip();
    })
    .on("pointerleave.dots", (e) => {
      if (e.pointerType !== "touch") clear();
    })
    .on("click.dots", (e) => {
      if (!enabled(e)) return;
      const d = find(...d3.pointer(e), kind === "touch" ? 18 : undefined);
      if (!d) return clear();
      if (kind !== "touch" || armed === d) {
        clear();
        if (canPick(d)) onPick?.(d);
        return;
      }
      armed = d;
      mark(d);
      showTip(e, tip(d) + (canPick(d) ? `<i class="tap">Tap again to find it on the map</i>` : ""));
      addEventListener("scroll", clear, { once: true, passive: true });
    });
}

// Size a <select> to the option it shows, so it can sit inside a sentence.
export function fitSelect(select) {
  const probe = document.createElement("span");
  probe.className = "ml-probe";
  probe.textContent = select.selectedOptions[0]?.textContent ?? "";
  select.parentNode.append(probe);
  // + room for the arrow (24px of padding) and a little slack: browsers draw
  // the text inside a menu slightly differently from plain text.
  if (probe.offsetWidth) select.style.width = `${Math.ceil(probe.offsetWidth) + 36}px`;
  probe.remove();
}

// Run once when the element first scrolls into view.
export function onceVisible(el, fn, threshold = 0.3) {
  if (!("IntersectionObserver" in window) || matchMedia("(prefers-reduced-motion: reduce)").matches) return fn(true);
  const io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        fn(false);
      }
    },
    { threshold },
  );
  io.observe(el);
}

// ---------------------------------------------------------------------------
// 1. A dot histogram of every valued site. Sites are binned on a log scale
//    with eight bins per decade, so the edges fall on €10k, €100k and €1m
//    (the category boundaries) and round values never split across bins.
//    Within a bin, dots stack in short rows from the bottom, cheapest first.
// ---------------------------------------------------------------------------
export function valueDots(el, sites, { levy = null, onSite = null } = {}) {
  const valued = sites.filter((s) => s.v != null);
  const median = d3.median(valued, (s) => s.v);
  const PER_DECADE = 8;
  const e0 = 3.5; // first edge at 10^3.5 ≈ €3,162
  const nBins = 25; // last edge at 10^6.625 ≈ €4.2m
  const edge = (i) => 10 ** (e0 + i / PER_DECADE);
  const binOf = (v) => Math.min(nBins - 1, Math.max(0, Math.floor((Math.log10(v) - e0) * PER_DECADE + 1e-9)));
  const bins = d3.range(nBins).map((i) => ({ i, lo: edge(i), hi: edge(i + 1), sites: [] }));
  for (const s of valued) bins[binOf(s.v)].sites.push(s);
  for (const b of bins) b.sites.sort((a, c) => a.v - c.v);
  const cat = (v) => (v >= 1e6 ? "c1" : v >= 1e5 ? "c2" : "c3");
  const groups = [
    { key: "c3", lo: edge(0), hi: 1e5, label: "Under €100,000" },
    { key: "c2", lo: 1e5, hi: 1e6, label: "€100,000 to €1 million" },
    { key: "c1", lo: 1e6, hi: edge(nBins), label: "€1 million+" },
  ];
  for (const g of groups) g.n = valued.filter((s) => cat(s.v) === g.key).length;
  const byValue = [...valued].sort((a, b) => b.v - a.v);
  const lowest = valued.filter((s) => s.v === byValue.at(-1).v);
  const sorted = valued.map((s) => s.v).sort(d3.ascending);
  // The levy marker starts on the median and remembers where it was left.
  let levyValue = median;
  let levyUsed = false; // nothing steps back until the reader moves the marker
  const snap = (v) => {
    const step = v < 20000 ? 1000 : v < 200000 ? 5000 : v < 1e6 ? 25000 : 50000;
    return Math.max(sorted[0], Math.min(sorted.at(-1), Math.round(v / step) * step));
  };

  responsive(el, (W) => {
    const narrow = W < 560;
    const pitch = narrow ? 3.6 : 5.4;
    const r = narrow ? 1.35 : 2.1;
    const m = { t: 58, r: 4, b: levy ? 58 : 44, l: 4 };
    const drop = levy ? 14 : 0; // room under the axis line for the levy handle
    const x = d3.scaleLog().domain([edge(0), edge(nBins)]).range([m.l, W - m.r]);
    const binW = x(edge(1)) - x(edge(0));
    const cols = Math.max(1, Math.floor((binW - (narrow ? 1 : 3)) / pitch));
    const maxRows = Math.ceil(d3.max(bins, (b) => b.sites.length) / cols);
    const plotH = maxRows * pitch;
    const H = m.t + plotH + m.b + (narrow ? 0 : 6);
    const base = m.t + plotH;
    const svg = d3.select(el).append("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("height", H);

    // Place each site in its bin's grid.
    const pos = [];
    for (const b of bins) {
      const x0 = x(b.lo) + (binW - cols * pitch) / 2 + pitch / 2;
      b.sites.forEach((s, k) => {
        pos.push({ s, k, row: Math.floor(k / cols), x: x0 + (k % cols) * pitch, y: base - pitch / 2 - Math.floor(k / cols) * pitch });
      });
    }

    // Category brackets above the stacks.
    const gb = svg.append("g");
    for (const g of groups) {
      const a = x(g.lo) + 2;
      const b = x(g.hi) - 2;
      gb.append("path").attr("class", "bracket").attr("d", `M${a},${m.t - 12}v-5H${b}v5`);
      const t = gb
        .append("text")
        .attr("class", "band-label")
        .attr("x", g.key === "c1" ? b : a)
        .attr("y", m.t - 24)
        .attr("text-anchor", g.key === "c1" ? "end" : "start");
      t.append("tspan").text(narrow && g.key !== "c3" ? (g.key === "c1" ? "€1m+" : "€100k–€1m") : narrow ? "Under €100k" : g.label);
      t.append("tspan").attr("class", "band-count").text(`  ${int(g.n)}`);
    }

    // Axis
    const ticks = narrow ? [1e4, 1e5, 1e6] : [5e3, 1e4, 2.5e4, 5e4, 1e5, 2.5e5, 5e5, 1e6, 2.5e6];
    svg
      .append("g")
      .attr("class", "axis")
      .attr("transform", `translate(0,${base + 4})`)
      .call(
        d3
          .axisBottom(x)
          .tickValues(ticks)
          .tickFormat((v) => euro(v))
          .tickSize(4)
          .tickPadding(3 + drop),
      )
      .call((g) => g.select(".domain").attr("d", `M${m.l},0H${W - m.r}`));

    const dots = svg
      .append("g")
      .selectAll("circle")
      .data(pos)
      .join("circle")
      .attr("class", (d) => `vdot ${cat(d.s.v)}`)
      .attr("cx", (d) => d.x)
      .attr("cy", (d) => d.y)
      .attr("r", 0);

    // Median marker under the axis.
    const mx = x(median);
    const mg = svg.append("g").attr("class", "median");
    mg.append("path").attr("d", `M${mx},${base + 27 + drop}l-4,6h8z`);
    if (!narrow)
      mg.append("text")
        .attr("x", mx + 8)
        .attr("y", base + 36 + drop)
        .text(`Median ${euro(median, true)}`);

    // Labels: the three most valuable sites (from different councils) and the floor.
    const ann = svg.append("g").attr("opacity", 0);
    const dotOf = (s) => pos.find((p) => p.s === s);
    const label = (s, text, sub, ty, side = -1) => {
      const d = dotOf(s);
      if (!d) return;
      const tx = d.x + side * 14;
      ann.append("path").attr("class", "ann-line").attr("d", `M${d.x},${d.y - r - 3}Q${d.x},${ty + 4} ${tx},${ty + 4}`);
      const t = ann
        .append("text")
        .attr("class", "ann-text")
        .attr("x", tx + side * 4)
        .attr("y", ty)
        .attr("text-anchor", side < 0 ? "end" : "start");
      t.append("tspan").attr("class", "b").text(text);
      t.append("tspan").attr("x", tx + side * 4).attr("dy", 15).text(sub);
    };
    const seen = new Set();
    const top3 = byValue.filter((s) => !seen.has(s.council) && seen.add(s.council)).slice(0, 3);
    if (!narrow) {
      const stack = [base - plotH * 0.95, base - plotH * 0.62, base - plotH * 0.29];
      top3.forEach((s, i) => label(s, siteName(s), euro(s.v, true), stack[i]));
      const low = lowest[0];
      label(low, `${lowest.length} sites at ${euro(low.v, true)}`, "the lowest value on any register", base - plotH * 0.55, 1);
    } else {
      label(top3[0], euro(top3[0].v, true), "", base - plotH * 0.6);
    }

    // Hover or tap: the nearest dot.
    const dl = d3.Delaunay.from(pos, (d) => d.x, (d) => d.y);
    const hit = svg
      .append("rect")
      .attr("x", m.l)
      .attr("y", m.t - 4)
      .attr("width", W - m.l - m.r)
      .attr("height", plotH + 8)
      .attr("fill", "transparent");
    dotPointer(hit, {
      find: (px, py, reach = 14) => {
        const d = pos[dl.find(px, py)];
        return Math.hypot(d.x - px, d.y - py) <= reach ? d : null;
      },
      mark: (d) => dots.classed("hot", (o) => o === d),
      tip: (d) =>
        `<b>${euro(d.s.v, true)}</b>${esc(d.s.addr || "Address not published")}<br>${esc(d.s.council)}${d.s.date ? ` · listed ${longDate(d.s.date)}` : ""}`,
      onPick: (d) => onSite?.(d.s),
    });

    // The levy: drag a rule along the axis. Sites worth less than the chosen
    // value step back, and the sentence above works out 7% of it.
    if (levy) {
      const THUMB = 30;
      const rule = svg.insert("path", ":first-child").attr("class", "levy-rule");
      const l0 = Math.log10(edge(0));
      const l1 = Math.log10(edge(nBins));
      const toV = (t) => 10 ** (l0 + (t / 1000) * (l1 - l0));
      const input = document.createElement("input");
      input.type = "range";
      input.min = 0;
      input.max = 1000;
      input.className = "levy-input";
      input.setAttribute("aria-label", "Value of a site, to work out its yearly levy");
      input.style.cssText = `left:${m.l - THUMB / 2}px;width:${W - m.l - m.r + THUMB}px;top:${base + 4 - THUMB / 2}px;height:${THUMB}px`;
      input.value = Math.round(((Math.log10(levyValue) - l0) / (l1 - l0)) * 1000);
      el.append(input);
      const update = (fromUser) => {
        if (fromUser) {
          levyValue = snap(toV(+input.value));
          levyUsed = true;
        }
        const lx = x(fromUser ? Math.max(sorted[0], Math.min(sorted.at(-1), toV(+input.value))) : levyValue);
        rule.attr("d", `M${lx},${base + 4}V${m.t - 4}`);
        dots.classed("below", (d) => levyUsed && d.s.v < levyValue);
        const owes = levyValue * 0.07;
        const atLeast = sorted.length - d3.bisectLeft(sorted, levyValue);
        levy.say.innerHTML = `A site valued at <b>${euro(levyValue, true)}</b> owes <b class="hot">${euro(owes, true)}</b> a year`;
        levy.foot.textContent = `${int(atLeast)} of the ${int(sorted.length)} valued sites are worth at least that.`;
        input.setAttribute("aria-valuetext", `${euro(levyValue, true)}: levy ${euro(owes, true)} a year`);
      };
      input.addEventListener("input", () => update(true));
      update(false);
    }

    // Stack the dots up, bin by bin, when the chart scrolls into view.
    onceVisible(el, (now) => {
      (now
        ? dots
        : dots
            .transition()
            .duration(260)
            .delay((d) => ((d.x - m.l) / (W - m.l - m.r)) * 500 + d.row * 14)
            .ease(d3.easeBackOut)
      ).attr("r", r);
      ann.transition().delay(now ? 0 : 1300).duration(now ? 0 : 400).attr("opacity", 1);
    });
  });
}

export function siteName(s) {
  const ref = s.addr.match(/register ref (\S+)/);
  if (ref) return `${s.council}, ref ${ref[1]}`;
  const parts = s.addr
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p && !/^Co\.?\s/i.test(p) && !/^[A-Z]\d{2}\b/.test(p));
  let t = parts.slice(0, 2).join(", ");
  if (t.length > 34) t = parts[0] ?? t;
  if (t === t.toUpperCase()) t = t.toLowerCase().replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase());
  return t.length > 38 ? `${t.slice(0, 36)}…` : t;
}

// ---------------------------------------------------------------------------
// 2. Small multiples: each council's area and its sites.
// ---------------------------------------------------------------------------
export function councilMultiples(el, { base, sites, councils, offline, onPick }) {
  const geoms = base.objects.councils.geometries;
  const shape = (name) =>
    topojson.merge(
      base,
      geoms.filter((g) => g.properties.council === name),
    );
  const bySite = d3.group(sites, (s) => s.council);
  const vMax = d3.max(sites, (s) => s.v) ?? 1;
  const r = d3.scaleSqrt().domain([0, vMax]).range([0, 7]);
  const items = [
    ...councils.map((c) => ({ name: c.council, n: c.mapped, offline: false })),
    ...offline.map((o) => ({ name: o.council, n: 0, offline: true })),
  ];

  // One hidden <svg> holds the hatch pattern every multiple references.
  el.insertAdjacentHTML(
    "beforebegin",
    `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><pattern id="m-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="var(--land)"/><line y2="5" stroke="var(--accent)" stroke-opacity="0.45" stroke-width="1"/></pattern></defs></svg>`,
  );

  for (const it of items) {
    const btn = document.createElement(it.offline ? "div" : "button");
    btn.className = `mult${it.offline ? " offline" : ""}`;
    if (!it.offline) {
      btn.type = "button";
      btn.addEventListener("click", () => onPick(it.name));
    }
    const geo = { type: "Feature", geometry: shape(it.name) };
    const W = 150;
    const H = 120;
    const proj = d3.geoTransverseMercator().rotate([8, -53.5]).fitExtent(
      [
        [4, 4],
        [W - 4, H - 4],
      ],
      geo,
    );
    const p = d3.geoPath(proj);
    const svg = d3.create("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("aria-hidden", "true");
    svg.append("path").attr("class", "m-shape").attr("d", p(geo));
    const list = (bySite.get(it.name) ?? []).slice().sort((a, b) => (b.v ?? 0) - (a.v ?? 0));
    // Scale dots with the zoom of each little map so big councils don't drown.
    const k = Math.min(1.6, Math.max(0.6, proj.scale() / 9000));
    svg
      .append("g")
      .selectAll("circle")
      .data(list)
      .join("circle")
      .attr("class", (s) => (s.v == null ? "m-u" : "m-v"))
      .attr("transform", (s) => `translate(${proj([s.lon, s.lat])})`)
      .attr("r", (s) => (s.v == null ? 1.4 : Math.max(1.4, r(s.v) * k)));
    btn.append(svg.node());
    btn.insertAdjacentHTML(
      "beforeend",
      `<span class="m-name">${esc(it.name)}</span><span class="m-count">${it.offline ? "Register offline" : `${int(it.n)} sites`}</span>`,
    );
    el.append(btn);
  }
}
