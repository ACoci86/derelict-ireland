// One-time converter: Mayo County Council publishes its register as an Excel
// spreadsheet (no coordinates). We convert it to CSV with LibreOffice (headless,
// same "system tool" approach as pdftotext for the PDF councils), then keep only
// ref + address + eircode + date + valuation. The spreadsheet has an owner
// name/address column which we deliberately never read. Sites have no
// coordinates here, so geocode.ts places them from the address later.
// Requires LibreOffice on PATH. Re-run when the register changes:
//   npx tsx pipeline/manual/mayo_convert.ts
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "csv-parse/sync";

const XLSX_URL =
  "https://www.mayo.ie/getmedia/6022062e-8bd9-48ce-9a40-3c47fe06d89f/" +
  "Derelict-Site-Register-06032026.xlsx";
const XLSX_TMP = "data/manual/mayo.xlsx";
const CSV_OUT = "data/manual/mayo.csv";
const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";

// "16/10/2019" -> "2019-10-16". "" if no date.
function iso(d: string): string {
  const m = (d ?? "").match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : "";
}

// An Irish eircode embedded in the address, spaced as "F26 X5P9".
function eircode(s: string): string {
  const m = (s ?? "").toUpperCase().match(/\b([A-Z]\d{2})\s?([A-Z0-9]{4})\b/);
  return m ? `${m[1]} ${m[2]}` : "";
}

async function main() {
  // 1. Download the spreadsheet.
  const buf = Buffer.from(await (await fetch(XLSX_URL, { headers: { "User-Agent": UA } })).arrayBuffer());
  writeFileSync(XLSX_TMP, buf);

  // 2. Convert xlsx -> csv with LibreOffice (output is named after the input).
  const outDir = mkdtempSync(join(tmpdir(), "mayo-"));
  execSync(`libreoffice --headless --convert-to csv --outdir "${outDir}" "${XLSX_TMP}"`, { stdio: "ignore" });
  const raw = readFileSync(join(outDir, "mayo.csv"), "utf8");

  // 3. Parse. Column headers are long and messy, so match them by substring.
  const rows = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  }) as Record<string, string>[];

  const keys = Object.keys(rows[0] ?? {});
  const key = (re: RegExp) => keys.find((k) => re.test(k)) ?? "";
  const kRef = key(/Reference/i);
  const kAddr = key(/Location of site/i);
  const kVal = key(/Market value/i);
  const kDate = key(/Section 8\(7\)/i);   // "entered on the register" notice
  // The owner column (key matches /Owner/) is intentionally never read.

  const out: string[][] = [];
  for (const r of rows) {
    const ref = (r[kRef] ?? "").trim();
    if (!ref) continue;
    const address = (r[kAddr] ?? "").replace(/\s+/g, " ").trim();
    const valuation = (r[kVal] ?? "").replace(/[^\d]/g, "");
    out.push([ref, address, eircode(address), iso(r[kDate] ?? ""), valuation]);
  }

  const header = "ref,address,eircode,date_entered,valuation";
  const lines = out.map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(","));
  writeFileSync(CSV_OUT, [header, ...lines].join("\n") + "\n");
  console.log(`wrote ${out.length} rows to ${CSV_OUT}`);
}

main();
