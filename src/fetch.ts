/**
 * Fetch wrapper that adds a User-Agent, used by the History API HTTP fallback.
 */
export default function (url: string | URL, init: RequestInit = {}) {
  return fetch(url, {
    ...init,
    headers: {
      ...init.headers,
      "User-Agent": "signalk-livedepth-plugin",
    },
  });
}
