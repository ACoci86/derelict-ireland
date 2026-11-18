# Derelict Ireland

Every council in Ireland has to keep a public register of derelict sites. The trouble is they're scattered across PDFs, spreadsheets, web tables and map portals, each in its own format. This project gathers them up and puts every site on one map.

**Live site:** https://acoci86.github.io/derelict-ireland/

![Screenshot of the Derelict Ireland site](docs/screenshot.png)

27 of the 31 councils publish their register online, and they're all here: 2,364 sites on the map, with about 260 more I couldn't place yet. Kerry, Longford, Clare and Galway County keep theirs offline (you have to ask or visit the office), so they're blank on the map. Cavan joined in September 2026.

On the site you can click any site for its details, filter by council, see what's changed recently at `/history`, and download everything as CSV or GeoJSON.

## How the data gets made

`npm run pipeline` reads every council's register through its own adapter in `pipeline/adapters/` and writes `public/sites.geojson` and `public/stats.json`.

Some councils publish map layers with coordinates, so those sites land exactly where the council puts them. The rest only give addresses. Their registers get scraped into a CSV once (the converters are in `pipeline/manual/`), and each address is looked up on OpenStreetMap: Nominatim first, then Photon if that finds nothing.

Photon is fuzzy. It once put "Main Street, Ringaskiddy" near the Limerick border. So every result has to land in the right county, and a Photon result also has to be within 5 km of a town the address names, or the site goes to that town instead. Anything I can't place sensibly is held back, not guessed. Lookups are cached in `data/cache/`, so re-runs are quick.

I never read owner or occupier details, even where a register includes them. Only the location, reference, dates and value.

`npm run check` asks each council whether its register has changed since my copy and logs the answer to `public/history.json`. Pulling an update in is still a manual step: re-run that council's converter, then the pipeline.

## Running it

```sh
npm install
npm run dev        # the site, at http://localhost:4321
npm run check      # has any register changed?
npm run pipeline   # rebuild the data
npm run build      # static site in ./dist
```

Pushing to `main` deploys to GitHub Pages.

## Adding a council

Write an adapter in `pipeline/adapters/` (and a converter in `pipeline/manual/` if the register is a PDF or spreadsheet), add it to `ADAPTERS` in `pipeline/run.ts`, give it a county hint and bounding box in `pipeline/geocode.ts` if it needs geocoding, drop its logo in `public/logos/`, and run the pipeline.

## Licence and a warning

The code is MIT. The data comes from the councils' registers, and the positions and boundaries come from OpenStreetMap (© OpenStreetMap contributors, ODbL), so please credit them if you reuse it.

This isn't an official source. Check the council's own register before relying on anything here.

Built with [Astro](https://astro.build), [MapLibre](https://maplibre.org), [OpenStreetMap](https://www.openstreetmap.org), a [CARTO](https://carto.com) basemap, boundaries from [click_that_hood](https://github.com/codeforgermany/click_that_hood) and icons from [Feather](https://github.com/feathericons/feather).
