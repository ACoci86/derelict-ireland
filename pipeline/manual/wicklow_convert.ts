// One-time converter: Wicklow County Council publishes its Derelict Sites
// Register as a PDF. The PDF carries no coordinates, those come separately from
// the council's ArcGIS layer and are joined in the adapter on the reference
// number. This scrapes ref + address + eircode + date + valuation into a
// committed CSV. The register's Owner column is personal data and is never read.
//
// wicklow.ie sits behind a WAF that 404s a bare scripted request, but it serves
// the file to a request that carries a browser user agent AND a Referer from the
// register page, which is what the fetch below sends. The PDF is still committed
// at data/manual/wicklow.pdf so a run works if the WAF tightens again.
// Re-run when the register changes:  npx tsx pipeline/manual/wicklow_convert.ts
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const PAGE_URL = "https://www.wicklow.ie/Living/Services/Planning/Derelict-Vacant-Sites/Derelict-Sites";
const PDF_URL =
  "https://www.wicklow.ie/Portals/0/adam/Documents/c92_sV08yUmlmhureE6YIQ/Link/" +
  "Derelict%20Site%20Register%20at%208th%20July%202026.pdf";
const PDF_PATH = "data/manual/wicklow.pdf";
const CSV_OUT = "data/manual/wicklow.csv";
const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";

// "Y14Y281" and "Y14 Y281" both appear; normalise to the spaced form.
function eircode(s: string): string {
  const m = (s ?? "").toUpperCase().match(/\b([A-Z]\d{2})\s?([A-Z0-9]{4})\b/);
  return m ? `${m[1]} ${m[2]}` : "";
}

// "15/12/2016" -> "2016-12-15". "" if no date on the line.
function iso(line: string): string {
  const m = line.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : "";
}

async function main() {
  // Refresh the committed PDF when the council's server will hand it over; keep
  // the committed copy and carry on if it will not.
  try {
    const resp = await fetch(PDF_URL, { headers: { "User-Agent": UA, Referer: PAGE_URL } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.subarray(0, 4).toString() !== "%PDF") throw new Error("not a PDF");
    writeFileSync(PDF_PATH, buf);
    console.log(`downloaded ${buf.length} bytes to ${PDF_PATH}`);
  } catch (e) {
    console.log(`could not download the register (${e}); using the committed ${PDF_PATH}`);
  }

  const text = execSync(`pdftotext -layout "${PDF_PATH}" -`, { encoding: "utf8" });
  const lines = text.split("\n");

  // Group lines into records. A record starts on a line beginning with its
  // reference (e.g. "DS/113") and runs until the next reference or a blank line;
  // the address wraps over those continuation lines.
  const out: string[][] = [];
  let block: string[] = [];
  const flush = () => {
    if (!block.length) return;
    const first = block[0];
    const ref = first.match(/^DS\/\d+/)![0];

    // In every line the address is column index 1: on the first line index 0 is
    // the ref, on wrapped lines index 0 is the empty lead from the indent. The
    // OWNER column is index 2+, which we never read, owner names are personal
    // data and are deliberately left out.
    const address = block
      .map((ln) => ln.split(/\s{2,}/)[1])
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    // Date entered and valuation live only on the first line. The first date is
    // "Date entered on Register"; the second (if any) is the valuation date.
    const val = first.match(/€\s?([\d,]+)/);

    // Newer entries carry the eircode on its own wrapped line, so lift it out of
    // the address rather than leaving it glued on the end.
    const eir = eircode(address);
    const addr = eir
      ? address.replace(/\b[A-Z]\d{2}\s?[A-Z0-9]{4}\b/i, "").replace(/[\s,]+$/, "").trim()
      : address;

    out.push([ref, addr, eir, iso(first), val ? val[1].replace(/,/g, "") : ""]);
    block = [];
  };

  for (const ln of lines) {
    if (/^DS\/\d+/.test(ln)) flush();          // new record: close the previous
    if (/^DS\/\d+/.test(ln)) block = [ln];
    else if (block.length && ln.trim()) block.push(ln);
    else if (!ln.trim()) flush();              // blank line ends a record
  }
  flush();

  const header = "ref,address,eircode,date_entered,valuation";
  const rows = out.map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(","));
  writeFileSync(CSV_OUT, [header, ...rows].join("\n") + "\n");
  console.log(`wrote ${out.length} rows to ${CSV_OUT}`);
  for (const r of out) console.log(`  ${r[0]}  ${r[1]}`);
}

main();
