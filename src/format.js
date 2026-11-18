const intFmt = new Intl.NumberFormat("en-IE");

export const int = (n) => intFmt.format(n);

// €3.5M / €850k for compact places; "€1.5 million" / "€85,000" in prose.
export function euro(n, prose = false) {
  if (n == null) return "—";
  if (prose) {
    if (n >= 1e6) return `€${trim(n / 1e6)} million`;
    return `€${intFmt.format(Math.round(n))}`;
  }
  if (n >= 1e6) return `€${trim(n / 1e6)}M`;
  if (n >= 1e3) return `€${Math.round(n / 1e3)}k`;
  return `€${Math.round(n)}`;
}

const trim = (x) => (Math.round(x * 10) / 10).toString();

const dateFmt = new Intl.DateTimeFormat("en-IE", { day: "numeric", month: "short", year: "numeric" });
const monthFmt = new Intl.DateTimeFormat("en-IE", { month: "long", year: "numeric" });
const shortMonthFmt = new Intl.DateTimeFormat("en-IE", { month: "short", year: "numeric" });
const asDate = (iso) => new Date(`${iso}T12:00:00Z`);

export const longDate = (iso) => dateFmt.format(asDate(iso));
export const monthYear = (iso) => monthFmt.format(asDate(iso));
export const shortMonth = (iso) => shortMonthFmt.format(asDate(iso));

// "A, B and C"
export function list(items) {
  if (items.length < 2) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
