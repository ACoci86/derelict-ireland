## Layout

- `pipeline/`: reads every council's register and writes `public/sites.geojson`, `public/stats.json` (`npm run pipeline`) and `public/history.json` (`npm run check`). TypeScript, run with tsx.
- `scripts/prepare-data.mjs`: turns those files into `public/data/` (gitignored), which the page loads. Applies `data/place-fixes.json`.
- `index.html` + `src/`: the site, plain JavaScript with d3, built by Vite. `src/map.js` is the map, `src/dots.js` and `src/charts.js` the essay's charts, `src/style.css` and `src/story.css` the styles.

## Development

`npm run dev` prepares the data and serves the site with Vite. `npm run build` writes a static site to `dist/`. Pushing to `main` deploys to GitHub Pages.

Numbers in the essay come from the data through `data-n` attributes. A few sentences and register lines in `index.html` name specific sites, so check them after a data refresh.
