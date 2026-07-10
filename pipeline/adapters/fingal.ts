import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import { makeSite, type Site } from "../schema";

// "Derelict Sites Register 2025 FCC" on the ArcGIS item store.
// This endpoint returns the raw CSV the dataset was published from.
const CSV_URL =
  "https://www.arcgis.com/sharing/rest/content/items/" +
  "1393e90e46f1415dae47133c4bc8595a/data";
// Human-facing dataset page (the CSV_URL above is a raw data download).
const SOURCE_URL = "https://hub.arcgis.com/datasets/1393e90e46f1415dae47133c4bc8595a_0";

const RAW_DIR = "data/raw/fingal";
const COUNCIL = "Fingal";

export async function load(): Promise<Site[]> {
  const today = new Date().toISOString().slice(0, 10);

  // 1. Download the CSV.
  const resp = await fetch(CSV_URL);
  if (!resp.ok) throw new Error(`Fingal download failed: HTTP ${resp.status}`);
  const text = await resp.text();

  // 2. Archive one dated copy per day.
  mkdirSync(RAW_DIR, { recursive: true });
  writeFileSync(`${RAW_DIR}/${today}.csv`, text);

  // 3. Parse the CSV (bom:true strips the leading BOM this file has).
  const rows = parse(text, {
    columns: (headers: string[]) => headers.map((h) => h.trim()),
    skip_empty_lines: true,
    bom: true,
    trim: true,
  }) as Record<string, string>[];

  // 4. De-duplicate. Fingal's file is a running log: one row per MONTHLY
  //    update, so the same site appears ~5 times (134 rows, ~33 real sites).
  //    Keep only the most recent row per reference.
  const latest = new Map<string, Record<string, string>>();
  for (const row of rows) {
    const raw = row["DS File Reference"]?.trim() ?? "";
    if (!/^DS\s/i.test(raw)) continue;   // skips the "Last updated ..." footer
    const seen = latest.get(raw);
    if (!seen || rowDate(row) >= rowDate(seen)) latest.set(raw, row);
  }

  // 5. Turn each surviving row into a Site. Fingal gives no coordinates, so
  //    lat/lon stay null here and geocode.ts fills them in from the address.
  return [...latest.values()].map((row, i) => {
    const address = row["Site Address"]?.trim() ?? "";

    // "DS 19.16" -> "DS-19.16"
    const raw = row["DS File Reference"]?.trim();
    const ref = raw ? raw.replace(/\s+/g, "-") : null;

    return makeSite({
      id: ref ? `fingal-${ref}` : `fingal-${stableHash(address) || `row${i}`}`,
      council: COUNCIL,
      address,
      register_ref: ref,
      // No coordinates in the source -> left for the geocoder.
      source_url: SOURCE_URL,
      retrieved: today,
    });
  });
}

// Sortable number for a row's "Year" + "Updated Month", e.g. 2025 + "March"
// -> 202503. Used to pick the newest row for each site.
const MONTHS = ["january", "february", "march", "april", "may", "june", "july",
  "august", "september", "october", "november", "december"];
const rowDate = (row: Record<string, string>): number => {
  const year = Number(row["Year"]) || 0;
  const month = MONTHS.indexOf((row["Updated Month"]?.trim() ?? "").toLowerCase()) + 1;
  return year * 100 + month;
};

const stableHash = (value: string): string =>
  value ? createHash("sha1").update(value).digest("hex").slice(0, 10) : "";

// Run directly:  npx tsx pipeline/adapters/fingal.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  load().then((sites) => {
    for (const s of sites) {
      console.log(`${s.id.padEnd(16)} ${s.address}`);
    }
    console.log(`\n${sites.length} sites loaded (all need geocoding)`);
  });
}
