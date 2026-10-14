import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerAPI } from "@signalk/server-api";
import { ASSET_BASE, PLUGIN_ID, buildManifest } from "./manifest.js";

/** The server API the plugin receives also carries Express's `use` and the
 * resource-provider registry, which the typed interface does not declare. */
interface ExtensionApp extends ServerAPI {
  use?: (path: string, handler: unknown) => void;
}

let registered = false;
let mounted = false;

/** Offer the plotter extension: register the read-only `plotterExtensions`
 * resource and mount the extension's pages. Safe to call on every start — the
 * provider is registered and the assets mounted once; `isRunning` reflects the
 * plugin's current state so the extension leaves when the plugin is disabled. */
export function registerPlotterExtension(
  app: ServerAPI,
  isRunning: () => boolean,
): void {
  const a = app as ExtensionApp;

  if (!registered) {
    if (typeof a.registerResourceProvider === "function") {
      a.registerResourceProvider({
        type: "plotterExtensions",
        methods: {
          listResources: async () =>
            isRunning() ? { [PLUGIN_ID]: buildManifest() } : {},
          getResource: async (id: string) => {
            if (!isRunning() || id !== PLUGIN_ID) {
              throw new Error(`No such plotterExtensions resource: ${id}`);
            }
            return buildManifest();
          },
          setResource: async () => {
            throw new Error(`${PLUGIN_ID} is a read-only provider`);
          },
          deleteResource: async () => {
            throw new Error(`${PLUGIN_ID} is a read-only provider`);
          },
        },
      });
      registered = true;
      a.debug(`${PLUGIN_ID}: plotter extension offered`);
    } else {
      a.debug(`${PLUGIN_ID}: server has no resource provider registry`);
    }
  }

  mountAssets(a);
}

/** Serve the extension's pages as a top-level static route. Express is provided
 * by the server, so requiring it adds no runtime dependency of our own. */
function mountAssets(app: ExtensionApp): void {
  if (mounted || typeof app.use !== "function") {
    return;
  }
  let serveStatic: ((dir: string) => unknown) | undefined;
  try {
    serveStatic = createRequire(import.meta.url)("express").static as (
      dir: string,
    ) => unknown;
  } catch {
    app.debug(`${PLUGIN_ID}: express unavailable; cannot serve ${ASSET_BASE}`);
    return;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  app.use(ASSET_BASE, serveStatic(join(here, "..", "..", "public")));
  mounted = true;
  app.debug(`${PLUGIN_ID}: extension assets served at ${ASSET_BASE}`);
}
