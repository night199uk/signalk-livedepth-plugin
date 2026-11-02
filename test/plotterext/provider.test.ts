import { beforeEach, expect, test, vi } from "vitest";
import type { ServerAPI } from "@signalk/server-api";

interface ProviderLike {
  type: string;
  methods: {
    listResources(): Promise<Record<string, unknown>>;
    getResource(id: string): Promise<unknown>;
    setResource(): Promise<unknown>;
    deleteResource(): Promise<unknown>;
  };
}

/** A server whose resource registry replaces by resource type and drops a
 * plugin's providers when it stops. */
function fakeApp() {
  const providers = new Map<string, ProviderLike>();
  const mounts: string[] = [];
  const app = {
    registerResourceProvider: (p: unknown) => {
      const provider = p as ProviderLike;
      providers.set(provider.type, provider);
    },
    use: (path: string) => mounts.push(path),
    debug: () => {},
  } as unknown as ServerAPI;
  return { app, providers, mounts };
}

beforeEach(() => vi.resetModules());

test("registers a read-only provider and mounts the assets once per app", async () => {
  const { registerPlotterExtension } =
    await import("../../src/plotterext/provider.js");
  const { ASSET_BASE, PLUGIN_ID } =
    await import("../../src/plotterext/manifest.js");
  const { app, providers, mounts } = fakeApp();
  let running = true;

  registerPlotterExtension(app, () => running);
  registerPlotterExtension(app, () => running);

  expect(providers.size).toBe(1);
  expect(mounts.filter((p) => p === ASSET_BASE)).toHaveLength(1);

  const provider = providers.get("plotterExtensions")!;
  expect(provider.type).toBe("plotterExtensions");
  expect(await provider.methods.listResources()).toHaveProperty(PLUGIN_ID);
  expect(await provider.methods.getResource(PLUGIN_ID)).toMatchObject({
    apiVersion: "1",
  });

  await expect(provider.methods.setResource()).rejects.toThrow(/read-only/);
  await expect(provider.methods.deleteResource()).rejects.toThrow(/read-only/);

  // While the plugin is stopped the extension leaves the collection.
  running = false;
  expect(await provider.methods.listResources()).toEqual({});
  await expect(provider.methods.getResource(PLUGIN_ID)).rejects.toThrow();
});

test("re-registers after the server unregisters the provider on stop", async () => {
  const { registerPlotterExtension } =
    await import("../../src/plotterext/provider.js");
  const { ASSET_BASE, PLUGIN_ID } =
    await import("../../src/plotterext/manifest.js");
  const { app, providers, mounts } = fakeApp();
  const running = true;

  registerPlotterExtension(app, () => running);
  expect(providers.size).toBe(1);

  // Stopping the plugin unregisters its resource providers.
  providers.clear();
  expect(providers.size).toBe(0);

  // Starting it again must advertise the extension, and must not re-mount.
  registerPlotterExtension(app, () => running);
  expect(providers.size).toBe(1);
  expect(mounts.filter((p) => p === ASSET_BASE)).toHaveLength(1);
  expect(
    await providers.get("plotterExtensions")!.methods.listResources(),
  ).toHaveProperty(PLUGIN_ID);
});
