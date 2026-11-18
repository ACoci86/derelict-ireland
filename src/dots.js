// Charts made of the same dots as the map: one dot, one site. They are drawn
// on a canvas (a few thousand dots move at once) with an SVG on top for the
// axes, labels and pointer events.
import * as d3 from "d3";
import { hideTip, esc, responsive, onceVisible, fitSelect, dotPointer } from "./charts.js";
import { euro, int, longDate } from "./format.js";

const reduce = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const mix = (a, b, t) => d3.interpolateRgb(a, b)(t);

function palette() {
  const [accent, ink, paper] = ["--accent", "--ink", "--paper"].map(token);
  return {
    accent,
    ink,
    pale: mix(paper, accent, 0.3), // a site with no published value
    part: mix(paper, accent, 0.5), // the year still under way
    faded: mix(paper, ink, 0.14), // stepped back while another group is picked out
    ring: mix(paper, ink, 0.5),
    grid: mix(paper, ink, 0.09),
    axis: mix(paper, ink, 0.3),
  };
}

// A canvas of dots that can glide to new positions. Each dot carries where it
// is (x, y, a) and where it is going (tx, ty, ta), plus an optional delay.
function field(host) {
  host.classList.add("dc");
  const canvas = host.appendChild(document.createElement("canvas"));
  canvas.setAttribute("aria-hidden", "true");
  const svg = d3.select(host).append("svg");
  const ctx = canvas.getContext("2d");
  const inkColour = token("--ink");
  let W = 0;
  let H = 0;
  let dots = [];
  let hot = null;
  let timer = null;
  let under = null;
  let index = null;

  const api = {
    svg,
    size(w, h) {
      W = w;
      H = h;
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      svg.attr("viewBox", `0 0 ${w} ${h}`).attr("width", w).attr("height", h);
    },
    underlay(fn) {
      under = fn;
    },
    set(list) {
      dots = list;
      index = null;
      api.draw();
    },
    get moving() {
      return !!timer;
    },
    go({ dur = 650, ease = d3.easeCubicInOut, done } = {}) {
      timer?.stop();
      timer = null;
      index = null;
      hot = null;
      const finish = () => {
        for (const d of dots) {
          d.x = d.tx;
          d.y = d.ty;
          d.a = d.ta;
        }
        api.draw();
        done?.();
      };
      if (reduce() || !dur) return finish();
      for (const d of dots) {
        d.sx = d.x;
        d.sy = d.y;
        d.sa = d.a;
      }
      const total = dur + (d3.max(dots, (d) => d.delay ?? 0) ?? 0);
      timer = d3.timer((t) => {
        for (const d of dots) {
          const p = (t - (d.delay ?? 0)) / dur;
          if (p <= 0) continue;
          const e = ease(Math.min(1, p));
          d.x = d.sx + (d.tx - d.sx) * e;
          d.y = d.sy + (d.ty - d.sy) * e;
          d.a = d.sa + (d.ta - d.sa) * e;
        }
        api.draw();
        if (t >= total) {
          timer.stop();
          timer = null;
          finish();
        }
      });
    },
    draw() {
      ctx.clearRect(0, 0, W, H);
      under?.(ctx);
      for (const d of dots) {
        if (d.a < 0.02) continue;
        ctx.globalAlpha = d.a;
        ctx.beginPath();
        if (d.ring) {
          ctx.arc(d.x, d.y, d.r - d.ring / 2, 0, 6.2832);
          ctx.lineWidth = d.ring;
          ctx.strokeStyle = d.c;
          ctx.stroke();
        } else {
          ctx.arc(d.x, d.y, d.r, 0, 6.2832);
          ctx.fillStyle = d.c;
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      if (hot) {
        ctx.beginPath();
        ctx.arc(hot.x, hot.y, hot.r + 2.5, 0, 6.2832);
        ctx.lineWidth = 1.8;
        ctx.strokeStyle = inkColour;
        ctx.stroke();
      }
    },
    // The dot nearest a point, if it is close enough to mean it.
    find(px, py, reach = 11) {
      if (timer) return null;
      if (!index) {
        const live = dots.filter((d) => d.a > 0.1);
        index = { live, tri: live.length ? d3.Delaunay.from(live, (d) => d.x, (d) => d.y) : null };
      }
      if (!index.tri) return null;
      const d = index.live[index.tri.find(px, py)];
      return d && Math.hypot(d.x - px, d.y - py) <= reach ? d : null;
    },
    hot(d) {
      if (hot === d) return;
      hot = d;
      api.draw();
    },
  };
  return api;
}

const siteTip = (s) =>
  `<b>${esc(s.addr || "Address not published")}</b>${esc(s.council)} · ${s.v == null ? "no value published" : euro(s.v, true)}${
    s.date ? `<br>On the register since ${longDate(s.date)}` : ""
  }`;

// A label joined to its target by a short curve.
function note(g, { at, to, lines, anchor = "start" }) {
  const [tx, ty] = at;
  const out = g.append("g");
  if (to) {
    const [x, y] = to;
    const sx = anchor === "end" ? tx + 6 : anchor === "middle" ? tx : tx - 6;
    out.append("path").attr("class", "ann-line").attr("d", `M${sx},${ty - 4}Q${x},${ty - 4} ${x},${y}`);
  }
  const t = out.append("text").attr("class", "ann-text").attr("text-anchor", anchor).attr("x", tx).attr("y", ty);
  lines.forEach((l, i) =>
    t
      .append("tspan")
      .attr("x", tx)
      .attr("dy", i ? 15 : 0)
      .attr("class", i ? null : "b")
      .text(l),
  );
  return out;
}

// ---------------------------------------------------------------------------
// 1. Sites by the year they went on a register, with the last ten years left
//    blank for the reader to draw first. On "show me" the real dots fall in.
// ---------------------------------------------------------------------------
export function yearDots(el, sites, { ui, onSite, guessFrom = 2016 }) {
  const thisYear = new Date().getFullYear();
  const dated = sites.filter((s) => s.date).sort((a, b) => a.date.localeCompare(b.date));
  const yearOf = (s) => +s.date.slice(0, 4);
  const first = yearOf(dated[0]);
  const years = d3.range(first, thisYear + 1);
  const byYear = d3.group(dated, yearOf);
  const count = (y, list = dated) => (list === dated ? (byYear.get(y)?.length ?? 0) : list.filter((s) => yearOf(s) === y).length);
  const fullYears = years.filter((y) => y < thisYear);
  const peak = fullYears.reduce((a, b) => (count(b) > count(a) ? b : a));
  const TOP = Math.ceil((count(peak) * 1.04) / 100) * 100;
  const guessYears = d3.range(guessFrom, thisYear);
  const since = (y) => dated.filter((s) => yearOf(s) >= y).length;
  const C = palette();

  let revealed = false;
  let seen = false;
  let key = "";
  const guess = new Map();
  let chart = null;

  const councils = d3
    .rollups(dated, (v) => v.length, (s) => s.council)
    .sort((a, b) => b[1] - a[1]);
  ui.select.innerHTML =
    `<option value="">all councils</option>` + councils.map(([c, n]) => `<option value="${esc(c)}">${esc(c)} (${int(n)})</option>`).join("");
  ui.select.addEventListener("change", () => {
    key = ui.select.value;
    fitSelect(ui.select);
    chart?.restack(true);
  });

  function reveal() {
    if (revealed) return;
    revealed = true;
    ui.root.classList.add("is-revealed");
    ui.pick.hidden = false;
    fitSelect(ui.select);
    const g = guess.get(peak);
    const n = count(peak);
    const head =
      g == null
        ? `<b>${int(n)}</b> sites went on in ${peak}, the most of any year.`
        : `You drew about <b>${int(Math.round(g))}</b> for ${peak}. The registers say <b>${int(n)}</b>${
            Math.abs(g - n) / n < 0.2 ? ". Close." : g < n ? ", far more." : ", fewer."
          }`;
    ui.result.innerHTML = `${head} Of the ${int(dated.length)} sites with an entry date, ${int(since(2023))} (${Math.round(
      (since(2023) / dated.length) * 100,
    )}%) were added since the start of 2023.`;
    chart?.reveal();
  }
  ui.show.addEventListener("click", reveal);
  ui.skip.addEventListener("click", reveal);
  responsive(el, (W) => {
    const narrow = W < 560;
    const m = { t: 30, r: narrow ? 4 : 8, b: 26, l: narrow ? 28 : 36 };
    const colW = (W - m.l - m.r) / years.length;
    const gap = narrow ? 1.5 : 3;
    // As many dots across each year as it takes to keep the chart a sane height.
    let per = 2;
    while ((TOP * (colW - gap)) / (per * per) > 340) per++;
    const pitch = (colW - gap) / per;
    const r = Math.max(0.95, pitch * 0.4);
    const plotH = Math.ceil(TOP / per) * pitch;
    const H = m.t + plotH + m.b;
    const base = m.t + plotH;
    const colX = (y) => m.l + (y - first) * colW;
    const dx = (y, k) => colX(y) + gap / 2 + pitch / 2 + (k % per) * pitch;
    const dy = (k) => base - pitch / 2 - Math.floor(k / per) * pitch;
    const yOf = (n) => base - (n / per) * pitch;

    const f = field(el);
    f.size(W, H);
    const svg = f.svg.attr("role", "img").attr(
      "aria-label",
      `Sites on the registers by the year they were entered, ${first} to ${thisYear}. Few entries survive from before 2016; the most, ${int(count(peak))}, were added in ${peak}.`,
    );
    const ticks = d3.range(100, TOP + 1, 100);
    f.underlay((ctx) => {
      ctx.lineWidth = 1;
      ctx.strokeStyle = C.grid;
      for (const t of ticks) {
        ctx.beginPath();
        ctx.moveTo(m.l, Math.round(yOf(t)) + 0.5);
        ctx.lineTo(W - m.r, Math.round(yOf(t)) + 0.5);
        ctx.stroke();
      }
      ctx.strokeStyle = C.axis;
      ctx.beginPath();
      ctx.moveTo(m.l, Math.round(base) + 0.5);
      ctx.lineTo(W - m.r, Math.round(base) + 0.5);
      ctx.stroke();
    });

    // Axes
    const axis = svg.append("g").attr("class", "axis");
    for (const t of ticks)
      axis
        .append("text")
        .attr("x", m.l - 6)
        .attr("y", yOf(t))
        .attr("dy", "0.32em")
        .attr("text-anchor", "end")
        .text(t === TOP ? `${t}` : t);
    axis.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", m.t - 14).text("sites entered that year");
    const step = narrow ? 10 : 5;
    for (const y of years.filter((y) => y === first || y % step === 0))
      axis
        .append("text")
        .attr("x", colX(y) + colW / 2)
        .attr("y", base + 17)
        .attr("text-anchor", "middle")
        .text(y);

    // Every dated site, in its year's stack.
    const dots = [];
    for (const yr of years) for (const s of byYear.get(yr) ?? []) dots.push({ s, yr, r, c: C.accent, k: 0 });
    const place = () => {
      const next = new Map();
      // The chosen council's sites sink to the bottom of each year.
      const ordered = key ? [...dots].sort((a, b) => (b.s.council === key) - (a.s.council === key)) : dots;
      for (const d of ordered) {
        const k = next.get(d.yr) ?? 0;
        next.set(d.yr, k + 1);
        d.k = k;
        d.tx = dx(d.yr, k);
        d.ty = dy(k);
        // This year isn't over, so its dots are lighter.
        d.c = key && d.s.council !== key ? C.faded : d.yr === thisYear ? C.part : C.accent;
        d.ta = revealed || d.yr < guessFrom ? 1 : 0;
      }
    };
    place();
    for (const d of dots) {
      d.x = d.tx;
      d.y = seen ? d.ty : d.ty - 26;
      d.a = seen ? d.ta : 0;
    }
    f.set(dots);

    // The blank years, and the reader's line across them.
    const zx0 = colX(guessFrom);
    const zx1 = colX(thisYear);
    const zone = svg
      .append("rect")
      .attr("class", "guess-zone")
      .attr("x", zx0)
      .attr("y", m.t)
      .attr("width", zx1 - zx0)
      .attr("height", plotH)
      .style("display", revealed ? "none" : null);
    const hint = svg
      .append("text")
      .attr("class", "guess-hint")
      .attr("text-anchor", "middle")
      .attr("x", (zx0 + zx1) / 2)
      .attr("y", m.t + plotH / 2)
      .style("display", revealed || guess.size ? "none" : null);
    hint.append("tspan").attr("x", (zx0 + zx1) / 2).text(narrow ? "Draw" : "Draw your guess");
    hint
      .append("tspan")
      .attr("x", (zx0 + zx1) / 2)
      .attr("dy", 17)
      .attr("class", "sub")
      .text(narrow ? "here" : `${guessFrom} to ${thisYear - 1}`);
    const gLine = svg.append("path").attr("class", "guess-line");
    const gDots = svg.append("g");
    const gLabel = svg.append("text").attr("class", "guess-label").attr("text-anchor", "end");
    const drawGuess = () => {
      const pts = guessYears.filter((y) => guess.has(y)).map((y) => [colX(y) + colW / 2, yOf(guess.get(y))]);
      gLine.attr("d", pts.length > 1 ? d3.line().curve(d3.curveMonotoneX)(pts) : null);
      gDots
        .selectAll("circle")
        .data(pts)
        .join("circle")
        .attr("class", "guess-dot")
        .attr("r", narrow ? 2.4 : 3)
        .attr("cx", (p) => p[0])
        .attr("cy", (p) => p[1]);
      const mid = pts[Math.floor(pts.length / 2)];
      gLabel
        .attr("x", mid ? mid[0] - 10 : 0)
        .attr("y", mid ? mid[1] - 10 : 0)
        .text(mid && revealed && !key ? "Your guess" : "");
      const show = !key;
      gLine.style("display", show ? null : "none");
      gDots.style("display", show ? null : "none");
      ui.show.disabled = guess.size < Math.ceil(guessYears.length / 2);
    };

    // Notes that arrive with the answer.
    const ann = svg.append("g").attr("class", "ann").style("opacity", 0);
    const annotate = () => {
      ann.selectAll("*").remove();
      const list = key ? dated.filter((s) => s.council === key) : dated;
      const top = fullYears.reduce((a, b) => (count(b, list) > count(a, list) ? b : a));
      const n = count(top, list);
      if (n) {
        const px = colX(top) + colW / 2;
        const py = yOf(n) - 5;
        const left = px > m.l + (narrow ? 130 : 190);
        note(ann, {
          at: [left ? px - 26 : px + 26, Math.max(m.t + 12, py - 14)],
          to: [px, py],
          anchor: left ? "end" : "start",
          lines: [`${int(n)} in ${top}`, key ? `${key}'s busiest year` : "the most of any year"],
        });
      }
      if (!key) {
        const oldest = dots.find((d) => d.s === dated[0]);
        if (oldest && !narrow)
          note(ann, {
            at: [colX(first) + 30, yOf(TOP * 0.42)],
            to: [oldest.tx, oldest.ty - r - 4],
            lines: ["Commons Lane, Manorhamilton", `on Leitrim's register since ${first}`],
          });
      }
    };

    // Pointer: draw inside the blank years, hover and click everywhere else.
    const hit = svg.append("rect").attr("class", "hit").attr("x", 0).attr("y", 0).attr("width", W).attr("height", H).attr("fill", "transparent");
    let drawing = false;
    let prev = null;
    const inZone = (px) => px >= zx0 && px < zx1;
    const setAt = (e) => {
      const [px, py] = d3.pointer(e, svg.node());
      const y = first + Math.floor((px - m.l) / colW);
      if (y < guessFrom || y >= thisYear) return;
      const v = Math.max(0, Math.min(TOP, ((base - py) / pitch) * per));
      if (prev && Math.abs(y - prev.y) > 1) {
        const dir = Math.sign(y - prev.y);
        for (let k = prev.y + dir; k !== y; k += dir) guess.set(k, prev.v + ((v - prev.v) * (k - prev.y)) / (y - prev.y));
      }
      guess.set(y, v);
      prev = { y, v };
      hint.style("display", "none");
      drawGuess();
    };
    hit
      .on("pointermove.cursor", (e) => {
        if (!revealed) hit.style("cursor", inZone(d3.pointer(e)[0]) ? "crosshair" : null);
      })
      .on("pointerdown", (e) => {
        if (revealed || !inZone(d3.pointer(e)[0])) return;
        drawing = true;
        prev = null;
        hit.node().setPointerCapture?.(e.pointerId);
        hideTip();
        setAt(e);
        e.preventDefault();
      })
      .on("pointermove.draw", (e) => drawing && setAt(e))
      .on("pointerup pointercancel", () => (drawing = false));
    // Keep the page from scrolling while a finger draws.
    hit.node().addEventListener("touchmove", (e) => drawing && e.preventDefault(), { passive: false });
    hit.node().addEventListener(
      "touchstart",
      (e) => {
        const box = svg.node().getBoundingClientRect();
        if (!revealed && inZone(e.touches[0].clientX - box.left)) e.preventDefault();
      },
      { passive: false },
    );
    dotPointer(hit, {
      find: f.find,
      mark: f.hot,
      tip: (d) => siteTip(d.s),
      onPick: (d) => onSite?.(d.s),
      enabled: (e) => !drawing && (revealed || !inZone(d3.pointer(e)[0])),
    });

    const settle = () => {
      annotate();
      ann.transition().duration(reduce() ? 0 : 400).style("opacity", revealed ? 1 : 0);
      drawGuess();
    };
    if (seen) settle();
    drawGuess();

    onceVisible(el, () => {
      if (seen) return;
      seen = true;
      for (const d of dots) d.delay = (d.yr - first) * 14;
      f.go({ dur: 500, ease: d3.easeCubicOut, done: settle });
    });

    chart = {
      // The answer: the missing years' dots fall into their stacks, oldest year first.
      reveal() {
        seen = true;
        zone.style("display", "none");
        hint.style("display", "none");
        for (const d of dots) {
          d.ta = 1;
          d.delay = 0;
          if (d.yr >= guessFrom) {
            d.y = d.ty - 70 - Math.random() * 50;
            d.a = 0;
            d.delay = (d.yr - guessFrom) * 85 + Math.floor(d.k / per) * 5;
          }
        }
        f.go({ dur: 620, ease: d3.easeCubicOut, done: settle });
      },
      // Pick out one council: its dots drop to the base of every year.
      restack(animate) {
        ann.interrupt().style("opacity", 0);
        place();
        for (const d of dots) d.delay = (d.yr - first) * 9;
        f.go({ dur: animate ? 620 : 0, done: settle });
      },
    };
  });
}

// ---------------------------------------------------------------------------
// 2. One row of dots per council: filled where the register gives a value,
//    pale where it doesn't, outlined for entries that couldn't be mapped.
// ---------------------------------------------------------------------------
export function councilDots(el, { sites, councils, offline, sorterEl, onPick, onSite }) {
  const C = palette();
  const bySite = d3.group(sites, (s) => s.council);
  const rows = councils.map((c) => {
    const list = (bySite.get(c.council) ?? []).slice().sort((a, b) => (b.v ?? -1) - (a.v ?? -1));
    const valued = list.filter((s) => s.v != null);
    return { name: c.council, list, mapped: list.length, held: c.review ?? 0, value: d3.sum(valued, (s) => s.v), nValued: valued.length };
  });
  const offlineNames = offline.map((o) => o.council).sort((a, b) => a.localeCompare(b));
  const mostHeld = rows.reduce((a, b) => (b.held > a.held ? b : a));
  let sort = "sites";
  const ordered = () =>
    [...rows].sort((a, b) => (sort === "value" ? b.value - a.value || b.mapped - a.mapped : b.mapped - a.mapped));
  let chart = null;
  let seen = false;
  for (const b of sorterEl.querySelectorAll("button")) {
    b.addEventListener("click", () => {
      if (sort === b.dataset.sort) return;
      sort = b.dataset.sort;
      for (const o of sorterEl.querySelectorAll("button")) o.setAttribute("aria-pressed", String(o === b));
      chart?.resort();
    });
  }

  responsive(el, (W) => {
    const narrow = W < 620;
    const labelW = narrow ? 0 : 178;
    const tailW = narrow ? 0 : 122;
    const plotW = W - labelW - tailW;
    const most = d3.max(rows, (r) => r.mapped + r.held);
    let high = 3;
    while (plotW / Math.ceil(most / high) < (narrow ? 3.5 : 4.2) && high < 8) high++;
    const pitch = Math.min(narrow ? 4.4 : 5.4, plotW / Math.ceil(most / high));
    const r = pitch * 0.39;
    const band = high * pitch;
    const rowH = band + (narrow ? 27 : 10);
    const top0 = narrow ? 20 : 2;
    const H = top0 + rows.length * rowH + 30;
    const rowTop = (i) => top0 + i * rowH;

    const f = field(el);
    f.size(W, H);
    const svg = f.svg.attr("role", "img").attr(
      "aria-label",
      `Sites on each council's register. ${ordered()
        .slice(0, 5)
        .map((r) => `${r.name} ${r.mapped}`)
        .join(", ")}, and ${rows.length - 5} more councils.`,
    );

    const dots = [];
    for (const row of rows) {
      row.list.forEach((s, k) => dots.push({ row, s, k, r, c: s.v == null ? C.pale : C.accent }));
      for (let k = 0; k < row.held; k++) dots.push({ row, s: null, k: row.mapped + k, r, c: C.ring, ring: Math.max(0.8, r * 0.45) });
    }
    const place = () => {
      ordered().forEach((row, i) => (row.i = i));
      for (const d of dots) {
        d.col = Math.floor(d.k / high);
        d.tx = labelW + d.col * pitch + pitch / 2;
        d.ty = rowTop(d.row.i) + (d.k % high) * pitch + pitch / 2;
        d.ta = 1;
      }
    };
    place();
    for (const d of dots) {
      d.x = d.tx;
      d.y = d.ty;
      d.a = seen ? 1 : 0;
    }
    f.set(dots);

    const hit = svg.append("rect").attr("x", 0).attr("y", 0).attr("width", W).attr("height", H).attr("fill", "transparent");
    dotPointer(hit, {
      find: f.find,
      mark: f.hot,
      tip: (d) =>
        d.s
          ? siteTip(d.s)
          : `<b>Not on the map</b>One of ${int(d.row.held)} ${esc(d.row.name)} entries that couldn't be placed with confidence`,
      canPick: (d) => !!d.s,
      onPick: (d) => onSite?.(d.s),
    });

    // Names and totals ride along with their rows.
    const g = svg
      .append("g")
      .selectAll("g")
      .data(rows)
      .join("g")
      .attr("class", "row")
      .attr("transform", (d) => `translate(0,${rowTop(d.i)})`);
    g.append("text")
      .attr("class", "row-label")
      .attr("x", narrow ? 0 : labelW - 12)
      .attr("y", narrow ? -7 : band / 2)
      .attr("dy", narrow ? 0 : "0.35em")
      .attr("text-anchor", narrow ? "start" : "end")
      .attr("tabindex", 0)
      .attr("role", "button")
      .text((d) => d.name)
      .on("click", (e, d) => onPick(d.name))
      .on("keydown", (e, d) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPick(d.name);
        }
      })
      .append("title")
      .text((d) => `Show ${d.name} on the map`);
    const tail = g
      .append("text")
      .attr("class", "row-tail")
      .attr("x", (d) => (narrow ? W : labelW + Math.ceil((d.mapped + d.held) / high) * pitch + 8))
      .attr("y", narrow ? -7 : band / 2)
      .attr("dy", narrow ? 0 : "0.35em")
      .attr("text-anchor", narrow ? "end" : "start");
    tail.append("tspan").attr("class", "b").text((d) => int(d.mapped));
    tail.append("tspan").text((d) => (d.value ? `  ${euro(d.value)}` : ""));
    // One note for the outlined dots, on the row that has most of them.
    if (!narrow && mostHeld.held) {
      const row = g.filter((d) => d === mostHeld);
      const cols = Math.ceil((mostHeld.mapped + mostHeld.held) / high);
      const x0 = labelW + (Math.ceil(mostHeld.mapped / high) + (cols - Math.ceil(mostHeld.mapped / high)) / 2) * pitch;
      const tx = labelW + cols * pitch + 96;
      row.append("path").attr("class", "ann-line").attr("d", `M${tx - 6},${band + 18}Q${x0},${band + 18} ${x0},${band + 3}`);
      const t = row.append("text").attr("class", "ann-text").attr("x", tx).attr("y", band + 22);
      t.append("tspan").attr("class", "b").text(`${int(mostHeld.held)} more ${mostHeld.name} entries`);
      t.append("tspan").attr("x", tx).attr("dy", 15).text("couldn't be placed on the map");
    }
    svg
      .append("text")
      .attr("class", "offline-text")
      .attr("x", narrow ? 0 : labelW)
      .attr("y", rowTop(rows.length) + 12)
      .text(
        narrow
          ? `Not online: ${offlineNames.map((n) => n.replace(" County", "")).join(", ")}`
          : `Register not online: ${offlineNames.join(", ")}`,
      );

    onceVisible(el, () => {
      if (seen) return;
      seen = true;
      for (const d of dots) {
        d.y = d.ty + 5;
        d.delay = d.row.i * 20 + d.col * 5;
      }
      f.go({ dur: 380, ease: d3.easeCubicOut });
    }, 0.12);

    chart = {
      resort() {
        place();
        for (const d of dots) d.delay = 0;
        f.go({ dur: 700 });
        g.transition()
          .duration(reduce() ? 0 : 700)
          .ease(d3.easeCubicInOut)
          .attr("transform", (d) => `translate(0,${rowTop(d.i)})`);
      },
    };
  });
}
