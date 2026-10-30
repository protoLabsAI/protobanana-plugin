import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// The DS plugin-kit (tokens + the slug-aware iframe handshake) is a HOST asset
// served at a fixed root path — not part of this bundle. Inject its <link>/<script>
// verbatim AFTER Vite's own HTML transforms (order: "post") so `base: "./"` never
// rewrites the root-absolute `/_ds/...` URLs. This is rule 1 of
// building-react-plugin-views.md: load /_ds/plugin-kit.css|js.
function injectPluginKit(): Plugin {
  return {
    name: "protobanana-inject-plugin-kit",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        return {
          html,
          tags: [
            // api.ts imports the host ES module and starts the ready handshake.
            { tag: "link", injectTo: "head-prepend", attrs: { rel: "stylesheet", href: "/_ds/plugin-kit.css" } },
            { tag: "link", injectTo: "head-prepend", attrs: { rel: "modulepreload", href: "/_ds/plugin-kit.js" } },
          ],
        };
      },
    },
  };
}

export default defineConfig({
  // Relative asset paths (design R7): the built page + its hashed assets are
  // served by the plugin router under /plugins/protobanana/studio, which the
  // fleet proxy mounts behind a per-member slug prefix. Root-absolute asset URLs
  // would break under that prefix; "./" keeps every bundle asset relative.
  base: "./",
  plugins: [react(), injectPluginKit()],
  build: {
    outDir: "dist",
    assetsDir: "assets",
    emptyOutDir: true,
    // One small bundle — no need to split a single-view app into vendor chunks.
    chunkSizeWarningLimit: 900,
  },
});
