# Derelict Ireland

An interactive map of derelict sites in Ireland, built from public council registers.

![Screenshot of the Derelict Ireland site](docs/screenshot.png)

> Work in progress. 15 councils are covered so far (1,283 sites mapped), and things may change.

Irish councils must keep a register of derelict sites. This project pulls those registers together and puts every site on a map. Click a pin to see the address, council, and register reference.

## How it works

- **Pipeline** (`pipeline/`): downloads each council's register, cleans it into one common format, looks up map coordinates, and writes `public/sites.geojson`, a `public/stats.json` summary, and `docs/not-yet-mapped.md`.
- **Website** (`src/pages/index.astro`): an Astro page that loads that file and draws the sites on a MapLibre map, with a coverage-by-council table.

Each council has an adapter in `pipeline/adapters/`. The 15 councils covered so far are: Dún Laoghaire-Rathdown, South Dublin, Fingal, Dublin City, Cork City, Cork County, Galway City, Limerick City and County, Wicklow, Roscommon, Meath, Kilkenny, Offaly, Waterford, and Kildare.

Councils publish their registers in two ways, and the adapters handle both:

- **Coordinate-ready** (ArcGIS / open-data layers): coordinates come straight from the council, so sites map precisely with no geocoding.
- **PDF only**: the register is scraped into a CSV (see `pipeline/manual/`), and OpenStreetMap's Nominatim geocodes each address (cached in `data/cache/`). Vaguer addresses that can't be placed are held for review in `docs/not-yet-mapped.md`.

Owner and other personal data is deliberately never read, even when a source exposes it. Adding a council means one new adapter file plus one line in `run.ts`.

## Commands

```sh
npm install        # install dependencies
npm run pipeline   # rebuild public/sites.geojson from the registers
npm run dev        # start the local site at localhost:4321
npm run build      # build the production site to ./dist/
```
