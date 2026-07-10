import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import proj4 from "proj4";
import { parse } from "csv-parse/sync";
import { makeSite, type Site } from "../schema";

const CSV_URL =
  "https://data.smartdublin.ie/dataset/" +
  "f991ba64-ab1f-47c4-af28-d1c0bc1be4a5/resource/" +
  "969d35e5-e686-49e2-babc-3b66457d54e5/download/derelict-sites-register-dlr.csv";

const RAW_DIR = "data/raw/dlr";
const COUNCIL = "Dún Laoghaire-Rathdown";

// Irish Transverse Mercator, EPSG:2157, used by DLR for X_CORD / Y_CORD.
proj4.defs(
  "EPSG:2157",
  "+proj=tmerc +lat_0=53.5 +lon_0=-8 +k=0.99982 +x_0=600000 +y_0=750000 " +
    "+ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs"
);
const itmToWgs84 = proj4("EPSG:2157", "WGS84");

export async function load(): Promise<Site[]> {
  const today = new Date().toISOString().slice(0, 10);   // "2026-07-08"

  // 1. Download the CSV.
  const resp = await fetch(CSV_URL);
  if (!resp.ok) throw new Error(`DLR download failed: HTTP ${resp.status}`);
  const text = await resp.text();

  // 2. Archive one dated copy per day. Re-running on the same day refreshes it.
  mkdirSync(RAW_DIR, { recursive: true });
  writeFileSync(`${RAW_DIR}/${today}.csv`, text);

  // 3. Parse the CSV, a real parser, so quoted commas can't break rows.
  const rows = parse(text, {
    columns: (headers: string[]) => headers.map((h) => h.trim()),
    skip_empty_lines: true,
    bom: true,
    trim: true,
  }) as Record<string, string>[];

  // 4. Turn each row into a Site.
  return rows.map((row) => {
    const address = [row.ADDRESS_1, row.ADDRESS_2, row.ADDRESS_3]
      .map((part) => part?.trim())
      .filter(Boolean)
      .join(", ");

    // "DS 1223" -> "DS-1223",  "DS 1450/51" -> "DS-1450-51"
    const match = (row.DerelictSi ?? "").match(/(\d[\d/]*)/);
    const ref = match ? `DS-${match[1].replace(/\//g, "-")}` : null;

    // Convert Irish grid metres -> lon/lat when both coords are valid numbers.
    let lat: number | null = null;
    let lon: number | null = null;
    let confidence: Site["geocode_confidence"] = "none";
    const x = Number(row.X_CORD);
    const y = Number(row.Y_CORD);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      [lon, lat] = itmToWgs84.forward([x, y]);
      lon = round6(lon);
      lat = round6(lat);
      confidence = "council";
    }

    return makeSite({
      id: ref ? `dlr-${ref}` : `dlr-${stableHash(address)}`,
      council: COUNCIL,
      address,
      register_ref: ref,
      lat,
      lon,
      geocode_confidence: confidence,
      source_url: CSV_URL,
      retrieved: today,
    });
  });
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const stableHash = (value: string): string =>
  createHash("sha1").update(value).digest("hex").slice(0, 10);

// Run directly:  npx tsx pipeline/adapters/dlr.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  load().then((sites) => {
    for (const s of sites) {
      console.log(`${s.id.padEnd(16)} ${s.lat}, ${s.lon}  ${s.address}`);
    }
    console.log(`\n${sites.length} sites loaded`);
  });
}