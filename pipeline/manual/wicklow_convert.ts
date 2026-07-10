// One-time converter: Wicklow County Council publishes its Derelict Sites
// Register as a PDF (currently just two sites, both in Baltinglass). The PDF
// carries no coordinates, those come separately from the council's ArcGIS
// layer and are joined in the adapter on the reference number. This scrapes
// ref + address + date + valuation into a committed CSV.
//
// The PDF is committed at data/manual/wicklow.pdf because wicklow.ie sits behind
// a WAF that 404s plain scripted requests; it was downloaded in a browser
// session from the "Derelict Sites" page:
//   https://www.wicklow.ie/Living/Services/Planning/Derelict-Vacant-Sites/Derelict-Sites
// Re-run after replacing that PDF:  npx tsx pipeline/manual/wicklow_convert.ts
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const PDF_PATH = "data/manual/wicklow.pdf";
const CSV_OUT = "data/manual/wicklow.csv";

// "15/12/2016" -> "2016-12-15". "" if no date on the line.
function iso(line: string): string {
  const m = line.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : "";
}

function main() {
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

    out.push([ref, address, iso(first), val ? val[1].replace(/,/g, "") : ""]);
    block = [];
  };

  for (const ln of lines) {
    if (/^DS\/\d+/.test(ln)) flush();          // new record: close the previous
    if (/^DS\/\d+/.test(ln)) block = [ln];
    else if (block.length && ln.trim()) block.push(ln);
    else if (!ln.trim()) flush();              // blank line ends a record
  }
  flush();

  const header = "ref,address,date_entered,valuation";
  const rows = out.map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(","));
  writeFileSync(CSV_OUT, [header, ...rows].join("\n") + "\n");
  console.log(`wrote ${out.length} rows to ${CSV_OUT}`);
  for (const r of out) console.log(`  ${r[0]}  ${r[1]}`);
}

main();
