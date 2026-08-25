// Update checker. Probes every council's published register, compares it with
// the copy this site currently carries, and appends one dated run to
// public/history.json, which the /history page renders.
//
// A run only ever REPORTS. It never touches sites.geojson or the committed
// registers in data/. Taking an update in is still a separate, deliberate step:
// re-run the council's converter in pipeline/manual/ against the new file, then
// `npm run pipeline`.
//
//   npm run check
//
// Councils publish in four ways, and each needs a different probe:
//   arcgis    a live feature layer: ask it for editingInfo.lastEditDate and a
//             row count, and compare with our last archived snapshot.
//   download  a fixed CSV/GeoJSON URL: hash it against our last snapshot.
//   document  a PDF/spreadsheet: hash the known file, AND re-read the council's
//             page, because a new register is usually posted at a NEW url with
//             a new date in its name rather than replacing the old file.
//   scrape    an on-page HTML table: re-read it and count the register rows.
import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import * as cheerio from "cheerio";
import { parse as parseCsv } from "csv-parse/sync";

const HISTORY = "public/history.json";
const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";
const TIMEOUT = 60_000;

type Kind = "arcgis" | "download" | "document" | "scrape";

interface Source {
  council: string;
  kind: Kind;
  /** Page a human would visit. Also re-read for `document` councils. */
  page?: string;
  /** arcgis: the FeatureServer layer, without a /query suffix. */
  layer?: string;
  /** download: the direct file url. */
  file?: string;
  /** arcgis + download: data/raw/<dir>, where the pipeline archives snapshots. */
  snapshots?: string;
  /** document: the file url we last converted, and our committed copy of it. */
  doc?: string;
  local?: string;
  /** scrape + document: our committed CSV, and how to recognise a register row. */
  csv?: string;
  ref?: RegExp;
  /** Sligo's server presents an incomplete TLS chain. */
  insecureTls?: boolean;
  /** Wicklow's WAF serves the register only to a request that carries one. */
  referer?: string;
  /**
   * download: the column holding the register reference. Fingal publishes a
   * running log with one row per monthly update, so the same site appears half
   * a dozen times and a raw row count is not an entry count. Counting distinct
   * references makes the number mean the same thing as every other council's.
   */
  refColumn?: string;
}

// Keep these in step with the adapters in pipeline/adapters/ and the converters
// in pipeline/manual/, which hold the same urls privately.
const SOURCES: Source[] = [
  // --- live feature layers -------------------------------------------------
  { council: "Roscommon", kind: "arcgis", snapshots: "roscommon",
    layer: "https://services1.arcgis.com/0g8o874l5un2eDgz/arcgis/rest/services/DerelictSitesRegister/FeatureServer/0",
    page: "https://data-roscoco.opendata.arcgis.com/datasets/RosCoCo::derelict-sites-register-roscommon" },
  { council: "Waterford", kind: "arcgis", snapshots: "waterford",
    layer: "https://services-eu1.arcgis.com/eivETUtIaP8x2Pdh/arcgis/rest/services/Derelict_Sites_Register_Public_View/FeatureServer/0" },
  // Cork City is a hybrid: the layer carries the coordinates, the PDF the
  // addresses, so a change in either is worth knowing about.
  { council: "Cork City", kind: "arcgis", snapshots: "cork_city",
    layer: "https://services-eu1.arcgis.com/f0ZQOHXBIeLonX0V/arcgis/rest/services/DerelictSites/FeatureServer/0",
    doc: "https://www.corkcity.ie/media/qjyg4get/220726-derelict-sites-register.pdf",
    local: "data/manual/cork_city.pdf",
    page: "https://www.corkcity.ie/en/council-services/services/planning/derelict-vacant-sites-rzlt-and-grants/derelict-sites/" },
  // Wicklow's layer holds only the polygons; the entries live in a PDF beside it.
  { council: "Wicklow", kind: "arcgis", snapshots: "wicklow",
    layer: "https://services.arcgis.com/hQOfkHGHCu8mgDpG/arcgis/rest/services/Derelict_Sites_Register/FeatureServer/16",
    doc: "https://www.wicklow.ie/Portals/0/adam/Documents/c92_sV08yUmlmhureE6YIQ/Link/Derelict%20Site%20Register%20at%208th%20July%202026.pdf",
    local: "data/manual/wicklow.pdf",
    page: "https://www.wicklow.ie/Living/Services/Planning/Derelict-Vacant-Sites/Derelict-Sites",
    referer: "https://www.wicklow.ie/Living/Services/Planning/Derelict-Vacant-Sites/Derelict-Sites" },
  { council: "Kilkenny", kind: "arcgis", snapshots: "kilkenny",
    layer: "https://services-eu1.arcgis.com/ciqs2VrgJ6vG8Jqb/arcgis/rest/services/Derelict_Sites/FeatureServer/0" },
  { council: "Meath", kind: "arcgis", snapshots: "meath",
    layer: "https://services-eu1.arcgis.com/33tCl0taHHdVAN9O/arcgis/rest/services/DerelictSitesRegister/FeatureServer/0" },
  { council: "Offaly", kind: "arcgis", snapshots: "offaly",
    layer: "https://services-eu1.arcgis.com/GoYdY5OITUvNLuuX/arcgis/rest/services/Planning_Register_Editable/FeatureServer/16" },

  // --- fixed open-data downloads ------------------------------------------
  { council: "Dublin City", kind: "download", snapshots: "dublin_city",
    file: "https://data.smartdublin.ie/dataset/83b08920-50c6-45b0-b562-8f68940cadf4/resource/7bdcf921-e0ed-4219-a4ac-2172e6b32dd9/download/dublin_city_council_derelict_sites_register_260427.geojson",
    page: "https://data.smartdublin.ie/dataset/83b08920-50c6-45b0-b562-8f68940cadf4" },
  { council: "Dún Laoghaire-Rathdown", kind: "download", snapshots: "dlr",
    file: "https://data.smartdublin.ie/dataset/f991ba64-ab1f-47c4-af28-d1c0bc1be4a5/resource/969d35e5-e686-49e2-babc-3b66457d54e5/download/derelict-sites-register-dlr.csv",
    page: "https://data.smartdublin.ie/dataset/f991ba64-ab1f-47c4-af28-d1c0bc1be4a5" },
  { council: "Fingal", kind: "download", snapshots: "fingal", refColumn: "DS File Reference",
    file: "https://www.arcgis.com/sharing/rest/content/items/1393e90e46f1415dae47133c4bc8595a/data",
    page: "https://hub.arcgis.com/datasets/1393e90e46f1415dae47133c4bc8595a_0" },
  { council: "South Dublin", kind: "download", snapshots: "south_dublin",
    file: "https://hub.arcgis.com/api/v3/datasets/8ff1b797804145b1ae236d0a6ae98076_0/downloads/data?format=geojson&spatialRefId=4326&where=1%3D1",
    page: "https://hub.arcgis.com/datasets/8ff1b797804145b1ae236d0a6ae98076_0" },

  // --- documents (PDF / spreadsheet) --------------------------------------
  { council: "Galway City", kind: "document", csv: "data/manual/galway.csv", ref: /E:\d+,\s?N:\d+/g,
    doc: "https://files.galwaycity.ie/gccfiles/?r=/download&path=L0RlcGFydG1lbnRzL0Vudmlyb25tZW50L0RlcmVsaWN0IFNpdGVzL0RlcmVsaWN0IFNpdGUgUmVnaXN0ZXIgMTMuMDguMjAyNi5wZGY%3D",
    local: "data/manual/galway.pdf",
    page: "https://www.galwaycity.ie/services/housing/housing-services/vacant-and-derelict-properties/derelict-sites" },
  { council: "Kildare", kind: "document", csv: "data/manual/kildare.csv", ref: /\bDS[ -]?\d/gi,
    doc: "https://kildarecoco.ie/AllServices/Housing/DerelictSites/Derelict%20Sites%20Register%20%2017.07.2026.pdf",
    local: "data/manual/kildare.pdf",
    page: "https://kildarecoco.ie/AllServices/Housing/DerelictSites/" },
  { council: "Louth", kind: "document", csv: "data/manual/louth.csv", ref: /\bDS[ /-]?\d/g,
    doc: "https://www.louthcoco.ie/media/mxib4re2/derelict-sites-register-july-2026.pdf",
    local: "data/manual/louth.pdf",
    page: "https://www.louthcoco.ie/en/services/planning/derelict-sites-dangerous-structures/" },
  { council: "Monaghan", kind: "document", csv: "data/manual/monaghan.csv", ref: /DSN ?\d+\/\d+/g,
    doc: "https://monaghan.ie/planning/wp-content/uploads/sites/4/2026/07/Derelict-Sites-Online-Register-July-2026.pdf",
    local: "data/manual/monaghan.pdf",
    page: "https://monaghan.ie/planning/derelict-sites/" },
  { council: "Carlow", kind: "document", csv: "data/manual/carlow.csv", ref: /\bDS\d+/g,
    doc: "https://carlow.ie/media/1863/download?inline", local: "data/manual/carlow.pdf",
    page: "https://carlow.ie/planning-2/dangerous-buildings-derelict-sites/" },
  { council: "Laois", kind: "document", csv: "data/manual/laois.csv",
    doc: "https://laois.ie/sites/default/files/2026-07/Derelict%20Site%20Register%20updated%20July%202026_1.pdf",
    local: "data/manual/laois.pdf", page: "https://laois.ie/departments/planning/derelict-sites/" },
  { council: "Limerick City and County", kind: "document", csv: "data/manual/limerick.csv", ref: /\bDS-\d+-\d+/g,
    doc: "https://www.limerick.ie/sites/default/files/media/documents/2026-03/derelict-site-register-2026.pdf",
    local: "data/manual/limerick.pdf", page: "https://www.limerick.ie/council/services/planning-and-property/derelict-sites" },
  { council: "Wexford", kind: "document", csv: "data/manual/wexford.csv", ref: /\bDER\d{4}-\d+/g,
    doc: "https://www.wexfordcoco.ie/sites/default/files/content/Planning/Derelict%20Site%20Register%20March%202026.pdf",
    local: "data/manual/wexford.pdf", page: "https://www.wexfordcoco.ie/planning/building-control/derelict-and-vacant-sites" },
  { council: "Westmeath", kind: "document", csv: "data/manual/westmeath.csv",
    doc: "https://www.westmeathcoco.ie/en/media/CopyOfCountyDerelictSitesRegisterAsAt110626.pdf",
    local: "data/manual/westmeath.pdf", page: "https://www.westmeathcoco.ie/en/ourservices/planning/derelictsites/" },
  { council: "Donegal", kind: "document", csv: "data/manual/donegal.csv",
    doc: "https://www.donegalcoco.ie/media/ymhnhbjd/02-public-derelict-sites-register-donegal-county-council.xlsx",
    local: "data/manual/donegal.xlsx", page: "https://www.donegalcoco.ie/services/planning/derelictsites/" },
  { council: "Leitrim", kind: "document", csv: "data/manual/leitrim.csv",
    doc: "https://www.leitrim.ie/Council/Services/Planning-Building/Derelict-sites/Derelict-Sites-Register-2026-For-Inspection.xlsx",
    local: "data/manual/leitrim.xlsx", page: "https://www.leitrim.ie/Council/Services/Planning-Building/Derelict-sites/" },
  { council: "Mayo", kind: "document", csv: "data/manual/mayo.csv",
    doc: "https://www.mayo.ie/getmedia/6022062e-8bd9-48ce-9a40-3c47fe06d89f/Derelict-Site-Register-06032026.xlsx",
    local: "data/manual/mayo.xlsx", page: "https://www.mayo.ie/environment/derelict-sites" },
  { council: "Tipperary", kind: "document", csv: "data/manual/tipperary.csv",
    doc: "https://www.tipperarycoco.ie/sites/default/files/2026-06/260608_Derelict%20Sites%20register_Published.xlsx",
    local: "data/manual/tipperary.xlsx", page: "https://www.tipperarycoco.ie/planning-and-building/derelict-sites-register" },

  // --- on-page HTML tables -------------------------------------------------
  { council: "Cork County", kind: "scrape", csv: "data/manual/cork_county.csv", ref: /\/DS\//,
    page: "https://www.corkcoco.ie/en/resident/municipal-districts/derelict-sites-dangerous-structures/derelict-sites-register-list" },
  { council: "Sligo", kind: "scrape", csv: "data/manual/sligo.csv", ref: /^DS\s?\d/i, insecureTls: true,
    page: "https://www.sligococo.ie/planning/Enforcement/DerelictSites/" },
];

// ---------------------------------------------------------------------------

interface Check {
  council: string;
  kind: Kind;
  /** "updated" = the council has published something we have not taken in. */
  status: "updated" | "unchanged" | "unreachable";
  /** Register entries: what we carry, and what the source now publishes. */
  before: number | null;
  after: number | null;
  /** When the source says it was last published, before and now. */
  publishedBefore: string | null;
  publishedNow: string | null;
  /** A new file url, when the council posted the update at a new address. */
  newDoc: string | null;
  /** Whether the link the coverage table shows still resolves. */
  link: "ok" | "broken" | "blocked" | "unchecked";
  detail: string;
}

const today = new Date().toISOString().slice(0, 10);
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const iso = (ms?: number) => (ms ? new Date(ms).toISOString().slice(0, 10) : null);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One fetch, retried on the transient failures council and hub servers throw
 * often enough to matter: a 502 from an open-data host would otherwise be
 * logged as "unreachable" and read like the register had vanished.
 */
async function get(url: string, insecureTls = false, referer?: string): Promise<Response> {
  // Node reads this at socket time, so flipping it around the call is enough.
  const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (insecureTls) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    let last: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(2000 * attempt);
      try {
        last = await fetch(url, {
          headers: {
            "User-Agent": UA,
            Accept: "text/html,application/pdf,*/*",
            ...(referer ? { Referer: referer } : {}),
          },
          redirect: "follow",
          signal: AbortSignal.timeout(TIMEOUT),
        });
        // 4xx is a real answer about the url, so take it and stop.
        if (last.status < 500) return last;
      } catch (e) {
        if (attempt === 2) throw e;
      }
    }
    return last!;
  } finally {
    if (insecureTls) {
      if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
    }
  }
}

/** Rows in a committed CSV, i.e. how many register entries we currently carry. */
function csvRows(path: string): number | null {
  if (!path || !existsSync(path)) return null;
  return readFileSync(path, "utf8").trim().split("\n").length - 1;
}

/** Records in the newest snapshot the pipeline archived for a council. */
function snapshotCount(dir: string): { count: number | null; date: string | null } {
  const d = `data/raw/${dir}`;
  if (!existsSync(d)) return { count: null, date: null };
  const files = readdirSync(d).sort();
  const last = files.at(-1);
  if (!last) return { count: null, date: null };
  const text = readFileSync(`${d}/${last}`, "utf8");
  const count = last.endsWith(".geojson")
    ? (JSON.parse(text).features ?? []).length
    : text.trim().split(/\r?\n/).length - 1;
  return { count, date: last.slice(0, 10) };
}

/** Entries in a PDF, counted by the council's own reference format. */
function pdfEntries(path: string, ref?: RegExp): number | null {
  if (!ref || !path.endsWith(".pdf") || !existsSync(path)) return null;
  try {
    const text = execSync(`pdftotext -layout ${JSON.stringify(path)} -`, {
      encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    });
    return (text.match(new RegExp(ref.source, ref.flags.includes("g") ? ref.flags : ref.flags + "g")) ?? []).length;
  } catch {
    return null;    // pdftotext missing or the PDF is an image scan
  }
}

/**
 * Pull a publication date out of a register's file name. Councils date their
 * registers in the file name far more reliably than in any HTTP header:
 * "…17.07.2026.pdf", "…register-july-2026.pdf", "…As At 110626.pdf".
 */
const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];
function dateFromName(name: string): string | null {
  const s = decodeURIComponent(name).toLowerCase();
  let m = s.match(/(\d{1,2})[.\-_/](\d{1,2})[.\-_/](20\d{2})/);          // 17.07.2026
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = s.match(/(\d{1,2})[\s\-_]*(?:st|nd|rd|th)?[\s\-_]+([a-z]+)[\s\-_]+(20\d{2})/);   // 4-june-2026
  if (m && MONTHS.includes(m[2])) return `${m[3]}-${String(MONTHS.indexOf(m[2]) + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = s.match(/([a-z]+)[\s\-_]+(20\d{2})/);                              // july-2026
  if (m && MONTHS.includes(m[1])) return `${m[2]}-${String(MONTHS.indexOf(m[1]) + 1).padStart(2, "0")}`;
  m = s.match(/(20\d{2})[\-_/](\d{2})/);                                 // /2026-07/
  if (m) return `${m[1]}-${m[2]}`;
  m = s.match(/\b(\d{2})(\d{2})(20\d{2})\b/);                            // 06032026
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  // A bare 6-digit run, which councils write with no separator at all and often
  // with no word boundary in front of it: "…RegisterAsAt110626.pdf".
  m = s.match(/(?<!\d)(\d{2})(\d{2})(2[0-9])(?!\d)/);
  if (m) return `20${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

/**
 * A register url can hide its file name in a base64 query parameter, the way
 * Galway City's file server does, so decode that before reading the date.
 */
function readableName(url: string): string {
  try {
    const path = new URL(url).searchParams.get("path");
    if (path) return Buffer.from(decodeURIComponent(path), "base64").toString("utf8");
  } catch { /* not a url with a base64 path; fall through */ }
  return url;
}

/** Register links on a council's page, absolute, most likely first. */
function registerLinks(html: string, pageUrl: string): string[] {
  const $ = cheerio.load(html);
  const out: string[] = [];
  $("a[href]").each((_, a) => {
    const href = $(a).attr("href") ?? "";
    const text = $(a).text().replace(/\s+/g, " ").trim();
    const hay = `${decodeURIComponent(readableName(href))} ${text}`;
    if (!/derelict/i.test(hay)) return;
    if (!/register|\.pdf|\.xlsx?|download/i.test(hay)) return;
    if (/complaint|form|policy|infographic|vacant[ -]site|faq|grant|guidance|leaflet/i.test(hay)) return;
    try { out.push(new URL(href, pageUrl).href); } catch { /* skip bad href */ }
  });
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------

/**
 * Look on a council's page for a register newer than the one we converted.
 * Shared by the document probe and the hybrid layer councils (Wicklow, Cork
 * City), which publish the entries as a PDF and only the geometry as a layer:
 * probing the layer alone missed Wicklow's July 2026 register entirely.
 */
async function newerOnPage(
  pageUrl: string,
  knownDoc: string | undefined,
  knownDate: string | null,
  insecureTls = false,
): Promise<{ link: Check["link"]; candidate: { url: string; date: string | null } | null }> {
  try {
    const r = await get(pageUrl, insecureTls);
    const link: Check["link"] = r.ok ? "ok" : r.status === 403 ? "blocked" : "broken";
    if (!r.ok) return { link, candidate: null };
    let candidate: { url: string; date: string | null } | null = null;
    for (const url of registerLinks(await r.text(), pageUrl)) {
      if (url === knownDoc) continue;
      const d = dateFromName(readableName(url));
      // Only a link whose own name says it is newer counts as an update.
      if (d && (!knownDate || d > knownDate)) {
        if (!candidate || (candidate.date && d > candidate.date)) candidate = { url, date: d };
      }
    }
    return { link, candidate };
  } catch {
    return { link: "broken", candidate: null };
  }
}

async function checkArcgis(s: Source): Promise<Check> {
  const base: Check = {
    council: s.council, kind: s.kind, status: "unchanged", before: null, after: null,
    publishedBefore: null, publishedNow: null, newDoc: null, link: "unchecked", detail: "",
  };
  const meta = await (await get(`${s.layer}?f=json`)).json();
  if (meta?.error) return { ...base, status: "unreachable", detail: `layer error: ${meta.error.message}` };
  const cnt = await (await get(`${s.layer}/query?where=1%3D1&returnCountOnly=true&f=json`)).json();

  const snap = snapshotCount(s.snapshots!);
  base.before = snap.count;
  base.after = typeof cnt?.count === "number" ? cnt.count : null;
  base.publishedBefore = snap.date;
  base.publishedNow = iso(meta?.editingInfo?.lastEditDate);

  // The layer's own edit stamp is the honest signal: a council can correct a
  // record without the row count moving at all.
  const movedCount = base.after !== null && base.before !== null && base.after !== base.before;
  const movedDate = !!(base.publishedNow && base.publishedBefore && base.publishedNow > base.publishedBefore);
  base.status = movedCount || movedDate ? "updated" : "unchanged";
  base.detail = base.status === "updated"
    ? `layer last edited ${base.publishedNow}, ${base.before} to ${base.after} records`
    : `layer unchanged since ${base.publishedNow ?? "an unknown date"} (${base.after} records)`;

  // Cork City and Wicklow publish the entries as a PDF and only the geometry in
  // the layer, so the PDF has to be checked too: a layer that has not been
  // touched says nothing about the register beside it.
  if (s.doc && s.local) {
    const r = await get(s.doc, false, s.referer);
    const buf = Buffer.from(await r.arrayBuffer());
    const same = r.ok && existsSync(s.local) && sha(readFileSync(s.local)) === sha(buf);
    base.detail += same ? "; register PDF unchanged" : "; register PDF has changed";
    if (!same) base.status = "updated";
  }
  if (s.page) {
    const { link, candidate } = await newerOnPage(s.page, s.doc, dateFromName(readableName(s.doc ?? "")));
    base.link = link;
    if (candidate) {
      base.status = "updated";
      base.newDoc = candidate.url;
      base.detail += `; a newer register (${candidate.date}) is linked from the council's page`;
    }
  }
  return base;
}

async function checkDownload(s: Source): Promise<Check> {
  const base: Check = {
    council: s.council, kind: s.kind, status: "unchanged", before: null, after: null,
    publishedBefore: null, publishedNow: null, newDoc: null, link: "unchecked", detail: "",
  };
  const r = await get(s.file!);
  if (!r.ok) return { ...base, status: "unreachable", detail: `download returned HTTP ${r.status}` };
  const text = await r.text();

  const dir = `data/raw/${s.snapshots}`;
  const files = existsSync(dir) ? readdirSync(dir).sort() : [];
  const last = files.at(-1);
  if (!last) return { ...base, detail: "no archived snapshot to compare against" };
  const old = readFileSync(`${dir}/${last}`, "utf8");

  const rows = (t: string): number => {
    if (last.endsWith(".geojson")) return (JSON.parse(t).features ?? []).length;
    if (!s.refColumn) return t.trim().split(/\r?\n/).length - 1;
    const parsed = parseCsv(t, {
      columns: (h: string[]) => h.map((x) => x.trim()),
      skip_empty_lines: true, bom: true, trim: true,
    }) as Record<string, string>[];
    const refs = new Set(
      parsed.map((r) => r[s.refColumn!]?.trim()).filter((r) => r && /^DS\s/i.test(r)));
    return refs.size;
  };
  base.before = rows(old);
  base.after = rows(text);
  base.publishedBefore = last.slice(0, 10);
  const changed = sha(old) !== sha(text);
  base.status = changed ? "updated" : "unchanged";
  base.publishedNow = changed ? today : base.publishedBefore;
  const unit = s.refColumn ? "entries" : "records";
  base.detail = changed
    ? `download differs from our ${base.publishedBefore} copy, ${base.before} to ${base.after} ${unit}`
    : `download identical to our ${base.publishedBefore} copy (${base.after} ${unit})`;
  return base;
}

async function checkDocument(s: Source): Promise<Check> {
  const base: Check = {
    council: s.council, kind: s.kind, status: "unchanged", before: csvRows(s.csv ?? ""), after: null,
    publishedBefore: dateFromName(readableName(s.doc!)), publishedNow: null, newDoc: null,
    link: "unchecked", detail: "",
  };
  base.after = base.before;
  base.publishedNow = base.publishedBefore;

  // 1. Has the file we converted been replaced in place?
  let known: { ok: boolean; status: number; same: boolean } = { ok: false, status: 0, same: true };
  try {
    const r = await get(s.doc!, false, s.referer);
    const buf = Buffer.from(await r.arrayBuffer());
    known = { ok: r.ok, status: r.status, same: r.ok && existsSync(s.local!) && sha(readFileSync(s.local!)) === sha(buf) };
  } catch {
    known = { ok: false, status: 0, same: true };
  }

  // 2. Has the council posted a NEWER register at a different url? This is the
  //    common case: the old file stays put and a new one appears beside it.
  const { link, candidate } = await newerOnPage(
    s.page!, s.doc, base.publishedBefore, s.insecureTls);
  base.link = link;
  const pageOk = link === "ok";

  if (candidate) {
    base.status = "updated";
    base.newDoc = candidate.url;
    base.publishedNow = candidate.date;
    // Count the new file's entries so the delta is real rather than asserted.
    const tmp = `data/manual/.check-${s.council.replace(/\W+/g, "_")}.pdf`;
    if (s.ref && readableName(candidate.url).toLowerCase().includes(".pdf")) {
      try {
        const buf = Buffer.from(await (await get(candidate.url)).arrayBuffer());
        writeFileSync(tmp, buf);
        base.after = pdfEntries(tmp, s.ref) ?? base.before;
        rmSync(tmp, { force: true });
      } catch { /* leave `after` at the count we carry */ }
    }
    base.detail = `new register published ${candidate.date}` +
      (base.after !== base.before ? `, ${base.before} to ${base.after} entries` : "");
  } else if (!known.same && known.ok) {
    base.status = "updated";
    base.publishedNow = today;
    base.detail = "the register file was replaced in place";
  } else if (!known.ok) {
    base.status = "unreachable";
    base.detail = `register file returned HTTP ${known.status || "no response"}` +
      (pageOk ? ", and no replacement was linked from the council's page" : ", and the council's page did not load either");
  } else {
    base.detail = `still the register of ${base.publishedBefore ?? "an unstated date"} (${base.before} entries)`;
    if (base.link !== "ok") base.detail += `; the linked page returned ${base.link === "blocked" ? "403" : "404"}`;
  }
  return base;
}

async function checkScrape(s: Source): Promise<Check> {
  const base: Check = {
    council: s.council, kind: s.kind, status: "unchanged", before: csvRows(s.csv!), after: null,
    publishedBefore: null, publishedNow: null, newDoc: null, link: "unchecked", detail: "",
  };
  let html: string;
  try {
    const r = await get(s.page!, s.insecureTls);
    base.link = r.ok ? "ok" : r.status === 403 ? "blocked" : "broken";
    if (!r.ok) return { ...base, status: "unreachable", detail: `page returned HTTP ${r.status}` };
    html = await r.text();
  } catch (e) {
    return { ...base, status: "unreachable", link: "broken", detail: `page did not load: ${String(e).slice(0, 60)}` };
  }

  const $ = cheerio.load(html);
  let rows = 0;
  $("table tr").each((_, tr) => {
    const cells = $(tr).find("td").map((_i, td) => $(td).text().replace(/\s+/g, " ").trim()).get();
    if (cells.length < 5) return;
    if (cells.some((c) => s.ref!.test(c))) rows++;
  });
  base.after = rows;
  base.status = rows !== base.before ? "updated" : "unchanged";
  // A page table carries no publication date of its own, so the only honest
  // stamp is the day we read it.
  base.publishedNow = today;
  base.detail = base.status === "updated"
    ? `the register table now lists ${rows} entries, up from the ${base.before} we carry`
    : `the register table still lists ${rows} entries`;
  return base;
}

async function check(s: Source): Promise<Check> {
  try {
    if (s.kind === "arcgis") return await checkArcgis(s);
    if (s.kind === "download") return await checkDownload(s);
    if (s.kind === "document") return await checkDocument(s);
    return await checkScrape(s);
  } catch (e) {
    return {
      council: s.council, kind: s.kind, status: "unreachable", before: null, after: null,
      publishedBefore: null, publishedNow: null, newDoc: null, link: "broken",
      detail: `check failed: ${String(e).slice(0, 80)}`,
    };
  }
}

async function main() {
  console.log(`checking ${SOURCES.length} council registers...`);
  const councils = await Promise.all(SOURCES.map(check));
  councils.sort((a, b) =>
    Number(b.status === "updated") - Number(a.status === "updated") || a.council.localeCompare(b.council));

  for (const c of councils) {
    const mark = c.status === "updated" ? "UPDATED " : c.status === "unreachable" ? "?       " : "        ";
    console.log(`${mark}${c.council.padEnd(26)} ${c.detail}`);
  }

  const run = {
    date: today,
    checked: councils.length,
    updated: councils.filter((c) => c.status === "updated").length,
    unreachable: councils.filter((c) => c.status === "unreachable").length,
    councils,
  };

  // Newest first. A re-run on the same day replaces an earlier one that found
  // nothing, so repeated checks do not pile up. But an earlier run that DID find
  // updates is kept: taking those updates in and re-checking is the normal way a
  // day goes, and collapsing the two would erase the record of what moved.
  const prev = existsSync(HISTORY) ? JSON.parse(readFileSync(HISTORY, "utf8")) : { runs: [] };
  const kept = (prev.runs ?? []).filter(
    (r: { date: string; updated: number }) => r.date !== today || r.updated > 0);
  const runs = [run, ...kept];
  writeFileSync(HISTORY, JSON.stringify({ runs }, null, 2) + "\n");

  console.log(`\n${run.updated} of ${run.checked} councils have published an update we have not taken in.`);
  console.log(`wrote ${HISTORY} (${runs.length} run${runs.length === 1 ? "" : "s"})`);
}

main();
