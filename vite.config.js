import { defineConfig } from "vite";

// SITE_URL (e.g. https://example.ie/) makes the sharing-preview tags absolute,
// which WhatsApp, X and LinkedIn need. Without it they stay relative.
const siteUrl = (process.env.SITE_URL ?? "").replace(/\/?$/, (m) => (process.env.SITE_URL ? "/" : ""));

export default defineConfig({
  base: "./",
  build: { target: "es2022" },
  plugins: [
    {
      name: "site-url",
      transformIndexHtml: (html) => html.replaceAll("%SITE_URL%", siteUrl),
    },
  ],
});
