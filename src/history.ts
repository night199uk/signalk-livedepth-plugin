import { Path, ServerAPI } from "@signalk/server-api";
import {
  ContextsRequest,
  ContextsResponse,
  HistoryApi,
  PathsRequest,
  PathsResponse,
  ValuesRequest,
  ValuesResponse,
} from "@signalk/server-api/history";
import { Temporal } from "@js-temporal/polyfill";
import { BATHY_EPOCH } from "./constants.js";
import fetch from "./fetch.js";

export type HistoryAPIOptions = {
  app: ServerAPI;
  host?: string;
  /** How long to wait for a provider to register, in milliseconds. */
  waitMs?: number;
  /** Delay between provider checks, in milliseconds. */
  pollMs?: number;
};

const DEFAULT_PROVIDER_WAIT_MS = 30_000;
const DEFAULT_PROVIDER_POLL_MS = 500;

// URLSearchParams thinks it needs strings, but will work with anything that can be converted to a string.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type URLSearchParamsOptions = Record<string, any>;

/**
 * The History Provider API is new and may not be available. This uses a provider if available,
 * and otherwise falls back to direct HTTP access if available.
 */
export async function getHistoryAPI({
  app,
  // @ts-expect-error: app.config is not a public API
  port = Number(process.env.PORT) || app.config?.settings?.port || 3000,
  host = process.env.SIGNALK_HOST ?? `http://localhost:${port}/`,
  waitMs = DEFAULT_PROVIDER_WAIT_MS,
  pollMs = DEFAULT_PROVIDER_POLL_MS,
}: HistoryAPIOptions): Promise<HistoryApi | undefined> {
  // Plugins start in an unspecified order, so this plugin can reach the History
  // API before the provider plugin has registered. Wait briefly for it instead
  // of falling through to the HTTP path, which may not be reachable from the
  // server's own network namespace.
  const api = await waitForProvider();
  if (api) {
    app.debug("Using built-in history provider");
    return api;
  }

  try {
    await getContexts({
      from: BATHY_EPOCH,
      to: Temporal.Now.instant(),
    });
    app.debug("Using History API available at %s", host);
  } catch {
    app.debug("History API is not available");
    return;
  }

  return { getValues, getContexts, getPaths };

  async function waitForProvider(): Promise<HistoryApi | undefined> {
    if (typeof app.getHistoryApi !== "function") return undefined;
    const deadline = Date.now() + waitMs;
    for (;;) {
      try {
        return await app.getHistoryApi();
      } catch {
        if (Date.now() >= deadline) return undefined;
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    }
  }

  async function get(path: string, params: URLSearchParamsOptions = {}) {
    const url = new URL(path, new URL("/signalk/v2/api/history/", host));
    url.search = new URLSearchParams(params).toString();

    app.debug("Fetching %s", url.toString());

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        `Failed to fetch ${url}: ${res.status} ${res.statusText}`,
      );
    }

    return res.json();
  }

  function getValues({
    pathSpecs,
    ...query
  }: ValuesRequest): Promise<ValuesResponse> {
    return get("values", {
      ...query,
      paths: pathSpecs
        .map(({ path, aggregate }) => [path, aggregate].join(":"))
        .join(","),
    });
  }

  function getContexts(query?: ContextsRequest): Promise<ContextsResponse> {
    return get("contexts", query);
  }

  function getPaths(query?: PathsRequest): Promise<PathsResponse> {
    return get("paths", query);
  }
}

/**
 * Build a lookup from SignalK path to its column index in a history `DataRow`.
 *
 * `values[i]` describes data column `i + 1` (column 0 is always the timestamp),
 * so the returned index can be used directly against a `DataRow`. The response's
 * `values` metadata is authoritative — v2+ providers may reorder or drop columns
 * — but providers that omit it fall back to the requested path order. When a
 * path appears more than once the first matching column wins.
 */
export function columnsByPath(
  values: ValuesResponse["values"] | undefined,
  requested: readonly { path: Path }[],
): Map<string, number> {
  const source = values && values.length ? values : requested;
  const columns = new Map<string, number>();
  source.forEach((column, i) => {
    if (!columns.has(column.path)) columns.set(column.path, i + 1);
  });
  return columns;
}
