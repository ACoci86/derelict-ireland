// One-time converter: Galway City publishes its register as a PDF. Every record
// carries an ITM grid coordinate, which is all we need to map it precisely, so
// this scrapes ref + coordinate + eircode + valuation into a committed CSV.
// The address column in the PDF is messily interleaved with OWNER names, so we
// only keep the address when it clearly looks like a place (never an owner).
// Re-run when the register changes:  npx tsx pipeline/manual/galway_convert.ts
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const PDF_URL =
  "https://files.galwaycity.ie/gccfiles/?r=/download&path=" +
  "L0RlcGFydG1lbnRzL0Vudmlyb25tZW50L0RlcmVsaWN0IFNpdGVzL0RlcmVsaWN0IFNpdGUgUmVnaXN0ZXIgMDguMDcuMjAyNi5wZGY%3D";
const PDF_TMP = "data/manual/galway.pdf";
const CSV_OUT = "data/manual/galway.csv";

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

// "30/10/2024" or "24th April, 2019" -> ISO. Best-effort; "" if unparseable.
function iso(line: string): string {
  const slash = line.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (slash) {
    const [, dd, mm, yyyy] = slash;
    return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }
  const named = line.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Z][a-z]+),?\s+(\d{4})/);
  if (named && MONTHS[named[2].toLowerCase()]) {
    const [, dd, mon, yyyy] = named;
    return `${yyyy}-${String(MONTHS[mon.toLowerCase()]).padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }
  return "";
}

// An address-ish field mentions a place; an owner-ish field is a person/company.
const PLACEY = /\d|road|street|\bst\b|lane|park|avenue|\bave\b|terrace|drive|hill|quay|court|manor|place|cross|house|lodge|villa|salthill|renmore|docks|newcastle|castlepark|monalee|ballybane|rahoon|newtownsmith|galway/i;
const OWNERY = /\bltd\b|\bllp\b|limited|council|executive|developments|properties|unknown|diagnostic|\bhse\b/i;

async function main() {
  // 1. Download the PDF and extract its text.
  const buf = Buffer.from(await (await fetch(PDF_URL)).arrayBuffer());
  writeFileSync(PDF_TMP, buf);
  const text = execSync(`pdftotext -layout "${PDF_TMP}" -`, { encoding: "utf8" });

  // 2. A record is any line carrying an ITM coordinate. Everything we need is on
  //    that line and is pattern-matchable; the noisy "Notices" lines have none.
  const out: string[][] = [];
  for (const ln of text.split("\n")) {
    const itm = ln.match(/E:(\d+),\s*N:(\d+)/);
    if (!itm) continue;
    const [, e, n] = itm;

    const parts = ln.trim().split(/\s{2,}/).filter(Boolean);
    const ref = parts[0];
    if (!/^\d+$/.test(ref)) continue;                 // must start with a numeric ref

    const eir = ln.match(/\bH\d{2}\s?[A-Z0-9]{4}\b/);
    const val = ln.match(/([\d,]+)\.\d{2}/);

    // Address = the field after the ref, but only if it reads like a place and
    // not like an owner. Otherwise leave blank (never risk showing an owner).
    const cand = parts[1] ?? "";
    const address = PLACEY.test(cand) && !OWNERY.test(cand) ? cand : "";

    out.push([
      ref,
      address,
      eir ? eir[0].replace(/\s+/g, " ") : "",
      e,
      n,
      iso(ln),
      val ? val[1].replace(/,/g, "") : "",
    ]);
  }

  // 3. Write the CSV (quote every field so commas are safe).
  const header = "ref,address,eircode,itm_e,itm_n,date_entered,valuation";
  const lines = out.map((r) =>
    r.map((v) => `"${v.replace(/"/g, '""')}"`).join(","));
  writeFileSync(CSV_OUT, [header, ...lines].join("\n") + "\n");
  console.log(`wrote ${out.length} rows to ${CSV_OUT}`);
}

main();
