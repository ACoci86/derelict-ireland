import { icon } from "./icons.js";
import { euro, int } from "./format.js";

// Search over site addresses (which carry street and town names), register
// references and council names. Every typed word must match; accents and
// punctuation are ignored, so "dun laoghaire" finds "Dún Laoghaire".
const norm = (t) =>
  String(t ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const esc = (t) =>
  String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const MAX = 8;

export function createSearch(el, { sites, councils, offline, onSite, onCouncil, onClear }) {
  // Clearing from outside (the logo resets the whole page).
  el.reset = () => {
    const input = el.querySelector("input");
    input.value = "";
    input.dispatchEvent(new Event("input"));
  };
  el.innerHTML = `
    <label class="sr" for="q">Search the map for a street, town or council</label>
    <div class="search-box">
      ${icon("search")}
      <input id="q" type="search" placeholder="Find a street, town or council" autocomplete="off"
        spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="q-results" />
      <button type="button" class="q-clear" aria-label="Clear search" hidden>${icon("close")}</button>
    </div>
    <ul id="q-results" class="search-results" role="listbox" hidden></ul>`;
  const input = el.querySelector("input");
  const list = el.querySelector("ul");
  const clear = el.querySelector(".q-clear");
  const syncClear = () => (clear.hidden = !input.value);
  clear.addEventListener("click", () => {
    input.value = "";
    syncClear();
    close();
    input.focus();
    onClear?.();
  });

  const siteIdx = sites.map((s) => ({ s, text: norm(`${s.addr} ${s.council} ${s.ref}`), addr: norm(s.addr) }));
  const councilIdx = [
    ...councils.map((c) => ({ name: c.council, n: c.mapped, offline: false })),
    ...offline.map((o) => ({ name: o.council, offline: true })),
  ].map((c) => ({ ...c, text: norm(c.name) }));

  let results = [];
  let active = -1;

  function close() {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    active = -1;
  }

  function run() {
    const q = norm(input.value);
    if (q.length < 2) return close();
    const tokens = q.split(" ");
    const hit = (text) => tokens.every((t) => text.includes(t));
    const cm = councilIdx.filter((c) => hit(c.text)).slice(0, 3);
    const sm = siteIdx.filter((it) => hit(it.text));
    // Addresses where a typed word starts a word come first.
    const starts = (it) => tokens.filter((t) => it.addr.startsWith(t) || it.addr.includes(` ${t}`)).length;
    sm.sort((a, b) => starts(b) - starts(a));
    results = [
      ...cm.map((c) => ({ type: "council", ...c })),
      ...sm.slice(0, MAX - cm.length).map((it) => ({ type: "site", s: it.s })),
    ];
    active = results.length ? 0 : -1;
    render(sm.length, cm.length);
  }

  function render(siteMatches, councilMatches) {
    if (!results.length) {
      list.innerHTML = `<li class="q-empty" role="presentation">No sites match. Try a town or street name.</li>`;
    } else {
      list.innerHTML =
        results
          .map((r, i) => {
            const id = `q-opt-${i}`;
            const sel = i === active ? "true" : "false";
            if (r.type === "council") {
              const sub = r.offline ? "Register not published online" : `Council · ${int(r.n)} sites`;
              return `<li id="${id}" role="option" aria-selected="${sel}" aria-disabled="${r.offline}" class="q-opt${r.offline ? " q-off" : ""}" data-i="${i}"><b>${esc(r.name)}</b><span>${sub}</span></li>`;
            }
            const s = r.s;
            const val = s.v == null ? "no value published" : euro(s.v, true);
            return `<li id="${id}" role="option" aria-selected="${sel}" class="q-opt" data-i="${i}"><b>${esc(s.addr || `${s.council}, ref ${s.ref}`)}</b><span>${esc(s.council)} · ${val}</span></li>`;
          })
          .join("") +
        (siteMatches > MAX - councilMatches
          ? `<li class="q-more" role="presentation">${int(siteMatches)} sites match. Keep typing to narrow it down.</li>`
          : "");
    }
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    if (active >= 0) input.setAttribute("aria-activedescendant", `q-opt-${active}`);
  }

  function highlight(i) {
    active = i;
    for (const li of list.querySelectorAll(".q-opt")) li.setAttribute("aria-selected", String(+li.dataset.i === i));
    input.setAttribute("aria-activedescendant", `q-opt-${i}`);
    list.querySelector(`#q-opt-${i}`)?.scrollIntoView({ block: "nearest" });
  }

  function choose(i) {
    const r = results[i];
    if (!r || (r.type === "council" && r.offline)) return;
    if (r.type === "council") {
      input.value = r.name;
      onCouncil(r.name);
    } else {
      input.value = r.s.addr || r.s.council;
      onSite(r.s);
    }
    syncClear();
    close();
    input.blur();
  }

  input.addEventListener("input", () => {
    syncClear();
    run();
  });
  input.addEventListener("focus", () => input.value && run());
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" && results.length) {
      e.preventDefault();
      highlight(Math.min(results.length - 1, active + 1));
    } else if (e.key === "ArrowUp" && results.length) {
      e.preventDefault();
      highlight(Math.max(0, active - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(active >= 0 ? active : 0);
    } else if (e.key === "Escape") {
      close();
    }
  });
  list.addEventListener("pointerdown", (e) => {
    const li = e.target.closest(".q-opt");
    if (!li) return;
    e.preventDefault(); // keep focus until the choice is made
    choose(+li.dataset.i);
  });
  list.addEventListener("pointermove", (e) => {
    const li = e.target.closest(".q-opt");
    if (li && +li.dataset.i !== active) highlight(+li.dataset.i);
  });
  document.addEventListener("pointerdown", (e) => {
    if (!el.contains(e.target)) close();
  });
}
