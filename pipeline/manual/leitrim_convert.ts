// One-time converter: Leitrim County Council publishes its register as an Excel
// spreadsheet (no coordinates). We convert it to CSV with LibreOffice, then keep
// ref + address + eircode + entry date. The entry date is written in prose in
// the "Action Taken by Council" column ("Entered on Register 19th June 1991").
// The sheet has an Owner/Occupier column which we deliberately never read.
// Requires LibreOffice on PATH.
// Re-run when the register changes:  npx tsx pipeline/manual/leitrim_convert.ts
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "csv-parse/sync";

const XLSX_URL =
  "https://www.leitrim.ie/Council/Services/Planning-Building/Derelict-sites/" +
  "Derelict-Sites-Register-2026-For-Inspection.xlsx";
const XLSX_TMP = "data/manual/leitrim.xlsx";
const CSV_OUT = "data/manual/leitrim.csv";
const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const pad = (n: string | number) => String(n).padStart(2, "0");
// The "Entered on Register" date from the action prose (text or numeric form).
function iso(action: string): string {
  const s = action ?? "";
  let m = s.match(/Entered on Register\D{0,3}(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})/i);
  if (m) { const mo = MONTHS[m[2].toLowerCase()]; if (mo) return `${m[3]}-${pad(mo)}-${pad(m[1])}`; }
  m = s.match(/Entered on Register\D{0,3}(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  return "";
}
function eircode(s: string): string {
  const m = (s ?? "").toUpperCase().match(/\b([A-Z]\d{2})\s?([A-Z0-9]{4})\b/);
  return m ? `${m[1]} ${m[2]}` : "";
}

async function main() {
  const buf = Buffer.from(await (await fetch(XLSX_URL, { headers: { "User-Agent": UA } })).arrayBuffer());
  writeFileSync(XLSX_TMP, buf);

  const outDir = mkdtempSync(join(tmpdir(), "leitrim-"));
  execSync(`libreoffice --headless --convert-to csv --outdir "${outDir}" "${XLSX_TMP}"`, { stdio: "ignore" });
  const raw = readFileSync(join(outDir, "leitrim.csv"), "utf8");

  const rows = parse(raw, { columns: true, skip_empty_lines: true, relax_column_count: true, trim: true }) as Record<string, string>[];
  const keys = Object.keys(rows[0] ?? {});
  const key = (re: RegExp) => keys.find((k) => re.test(k)) ?? "";
  const kRef = key(/Reference No/i);
  const kAddr = key(/Location/i);
  const kFolio = key(/Eircode/i);
  const kAction = key(/Action/i);
  // The Owner/Occupier column (/Owner/) is intentionally never read.

  const out: string[][] = [];
  for (const r of rows) {
    const ref = (r[kRef] ?? "").trim();
    if (!/^DS\s*\d/i.test(ref)) continue;   // skip repeated header rows
    const address = (r[kAddr] ?? "").replace(/\s+/g, " ").trim();
    // Eircode lives in the folio column (the address can contain road numbers
    // like "N16" that look like a routing key).
    out.push([ref.replace(/\s+/g, ""), address, eircode(r[kFolio]), iso(r[kAction] ?? "")]);
  }

  const header = "ref,address,eircode,date_entered";
  const lines = out.map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(","));
  writeFileSync(CSV_OUT, [header, ...lines].join("\n") + "\n");
  console.log(`wrote ${out.length} rows to ${CSV_OUT}`);
}

main();
