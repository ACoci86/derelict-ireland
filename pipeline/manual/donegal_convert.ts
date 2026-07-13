// One-time converter: Donegal County Council publishes its register as an Excel
// spreadsheet (no coordinates). We convert it to CSV with LibreOffice and keep
// ref + address + eircode + date + valuation. The sheet has owner name / owner
// address / occupier columns (personal data) which we deliberately never read.
// Requires LibreOffice on PATH.
// Re-run when the register changes:  npx tsx pipeline/manual/donegal_convert.ts
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "csv-parse/sync";

const XLSX_URL = "https://www.donegalcoco.ie/media/ymhnhbjd/02-public-derelict-sites-register-donegal-county-council.xlsx";
const XLSX_TMP = "data/manual/donegal.xlsx";
const CSV_OUT = "data/manual/donegal.csv";
const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";

function iso(d: string): string {
  const m = (d ?? "").match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : "";
}
function eircode(s: string): string {
  const m = (s ?? "").toUpperCase().match(/\b([A-Z]\d{2})\s?([A-Z0-9]{4})\b/);
  return m ? `${m[1]} ${m[2]}` : "";
}
function money(s: string): string {
  const n = Number(String(s ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? String(Math.round(n)) : "";
}

async function main() {
  const buf = Buffer.from(await (await fetch(XLSX_URL, { headers: { "User-Agent": UA } })).arrayBuffer());
  writeFileSync(XLSX_TMP, buf);

  const outDir = mkdtempSync(join(tmpdir(), "donegal-"));
  execSync(`libreoffice --headless --convert-to csv --outdir "${outDir}" "${XLSX_TMP}"`, { stdio: "ignore" });
  const raw = readFileSync(join(outDir, "donegal.csv"), "utf8");

  const rows = parse(raw, { columns: true, skip_empty_lines: true, relax_column_count: true, trim: true }) as Record<string, string>[];
  const keys = Object.keys(rows[0] ?? {});
  const key = (re: RegExp) => keys.find((k) => re.test(k.trim())) ?? "";
  const kRef = key(/^REF/i);
  const kDate = key(/DATE OF ENTRY/i);
  const kAddr = key(/PROPERTY ADDRESS/i);
  const kVal = key(/^VALUATION$/i);
  // OWNER'S NAME / OWNER'S ADDRESS / OCCUPIER columns are never read.

  const out: string[][] = [];
  for (const r of rows) {
    const ref = (r[kRef] ?? "").trim();
    if (!ref || /^REF/i.test(ref)) continue;
    const address = (r[kAddr] ?? "").replace(/\s+/g, " ").trim().replace(/\.\s*$/, ".");
    if (!address) continue;
    out.push([ref, address, eircode(address), iso(r[kDate] ?? ""), money(r[kVal])]);
  }

  const header = "ref,address,eircode,date_entered,valuation";
  const lines = out.map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(","));
  writeFileSync(CSV_OUT, [header, ...lines].join("\n") + "\n");
  console.log(`wrote ${out.length} rows to ${CSV_OUT}`);
}

main();
