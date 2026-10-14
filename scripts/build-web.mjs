// Build the extension's browser assets into public/, which the plugin serves
// as a top-level static route at /plotterext/signalk-livedepth-plugin/.
//
// The pages are the extension's background runtime (renderer), its settings
// panel, and the render Worker. They are TypeScript, bundled here so the
// browser never sees a module graph. The plugin's Node code (dist/) is built
// separately by tsc.

import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const web = join(root, "src", "web");
const pub = join(root, "public");

rmSync(pub, { recursive: true, force: true });
mkdirSync(join(pub, "js"), { recursive: true });

// One bundle per page, plus the render Worker as its own entry (a Worker is a
// separate script, not part of the page bundle).
await build({
  entryPoints: [
    join(web, "renderer.ts"),
    join(web, "config.ts"),
    join(web, "render-worker.ts"),
  ],
  bundle: true,
  format: "esm",
  outdir: join(pub, "js"),
  sourcemap: true,
  target: ["es2022"],
  logLevel: "info",
});

cpSync(join(web, "styles.css"), join(pub, "styles.css"));

const page = (name, title, extraHead = "") => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="styles.css">
${extraHead}
</head>
<body class="${name}">
<div id="root"></div>
<script type="module" src="js/${name}.js"></script>
</body>
</html>
`;

writeFileSync(
  join(pub, "renderer.html"),
  page("renderer", "LiveDepth renderer"),
);
writeFileSync(join(pub, "config.html"), page("config", "LiveDepth settings"));
writeFileSync(
  join(pub, "index.html"),
  `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>LiveDepth</title>
<link rel="stylesheet" href="styles.css"></head>
<body class="config">
<div id="root">
<h2>LiveDepth</h2>
<p class="status">This package provides the LiveDepth chart layer and its
server-side bathymetry tile store for chartplotters that support the Signal K
<code>plotterExtensions</code> resource type (e.g. Freeboard-SK). Open your
chartplotter; the LiveDepth layer appears in its layer controls, and its
settings are behind the LiveDepth toolbar button.</p>
</div>
</body>
</html>
`,
);

console.error("public/ extension assets written");
