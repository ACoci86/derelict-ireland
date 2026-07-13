// One-time converter: Tipperary County Council publishes its register as an
// Excel spreadsheet. About a fifth of the rows carry an Irish Grid coordinate
// (Easting/Northing); the rest have only an address. We convert the sheet to CSV
// with LibreOffice (same system-tool approach as Mayo) and keep
// ref + address + eircode + date + easting/northing. The sheet has no owner
// column. Requires LibreOffice on PATH.
// Re-run when the register changes:  npx tsx pipeline/manual/tipperary_convert.ts
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "csv-parse/sync";

const XLSX_URL =
  "https://www.tipperarycoco.ie/sites/default/files/2026-06/" +
  "260608_Derelict%20Sites%20register_Published.xlsx";
const XLSX_TMP = "data/manual/tipperary.xlsx";
const CSV_OUT = "data/manual/tipperary.csv";
const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";

// "14/07/1998" -> "1998-07-14". "" if no date.
function iso(d: string): string {
  const m = (d ?? "").match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : "";
}

// An Irish eircode embedded in the address, spaced as "E34 TR58".
function eircode(s: string): string {
  const m = (s ?? "").toUpperCase().match(/\b([A-Z]\d{2})\s?([A-Z0-9]{4})\b/);
  return m ? `${m[1]} ${m[2]}` : "";
}

async function main() {
  const buf = Buffer.from(await (await fetch(XLSX_URL, { headers: { "User-Agent": UA } })).arrayBuffer());
  writeFileSync(XLSX_TMP, buf);

  const outDir = mkdtempSync(join(tmpdir(), "tipp-"));
  execSync(`libreoffice --headless --convert-to csv --outdir "${outDir}" "${XLSX_TMP}"`, { stdio: "ignore" });
  const raw = readFileSync(join(outDir, "tipperary.csv"), "utf8");

  const rows = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  }) as Record<string, string>[];

  const keys = Object.keys(rows[0] ?? {});
  const key = (re: RegExp) => keys.find((k) => re.test(k)) ?? "";
  const kRef = key(/SiteID/i);
  const kAddr = key(/Address/i);
  const kDate = key(/8\(7\)/i);
  const kE = key(/Easting/i);
  const kN = key(/Northing/i);

  const num = (v: string) => {
    const n = Number(String(v ?? "").replace(/[^\d.]/g, ""));
    return Number.isFinite(n) && n > 0 ? String(n) : "";
  };

  const out: string[][] = [];
  for (const r of rows) {
    const ref = (r[kRef] ?? "").trim();
    if (!ref) continue;
    const address = (r[kAddr] ?? "").replace(/\s+/g, " ").trim();
    out.push([ref, address, eircode(address), iso(r[kDate] ?? ""), num(r[kE]), num(r[kN])]);
  }

  const header = "ref,address,eircode,date_entered,easting,northing";
  const lines = out.map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(","));
  writeFileSync(CSV_OUT, [header, ...lines].join("\n") + "\n");
  const withCoords = out.filter((r) => r[4] && r[5]).length;
  console.log(`wrote ${out.length} rows to ${CSV_OUT} (${withCoords} with coordinates, ${out.length - withCoords} to geocode)`);
}

main();
