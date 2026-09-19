// CodeMind Academy — the small fetch/loading hook the Phase F screens share.
//
// WHY THIS EXISTS
// ===============
// The admin dashboard has its own private `useApi`; the Phase F screens are
// separate components in separate files and must not import a component module
// to get a hook. This is deliberately minimal (one GET, explicit reload,
// loading/error state) so every new screen shows the SAME tri-state behavior
// the UI contract requires: loading skeleton → data | error-with-retry.

"use client";

import * as React from "react";

export type JsonState<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
  /** Optimistic local patch (e.g. after a POST) without a full refetch. */
  setData: React.Dispatch<React.SetStateAction<T | null>>;
};

export function useJson<T>(url: string | null, deps: unknown[] = []): JsonState<T> {
  const [data, setData] = React.useState<T | null>(null);
  const [loading, setLoading] = React.useState<boolean>(Boolean(url));
  const [error, setError] = React.useState<string | null>(null);
  const [nonce, setNonce] = React.useState(0);
  // Serializes overlapping requests so a slow first response cannot overwrite
  // a newer one (the classic stale-render bug on a fast filter change).
  const requestId = React.useRef(0);

  React.useEffect(() => {
    if (!url) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    const id = ++requestId.current;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(url)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (cancelled || id !== requestId.current) return;
        if (!res.ok) {
          setError(String(body?.error ?? "error"));
          setData(null);
        } else {
          setData(body as T);
        }
      })
      .catch(() => {
        if (cancelled || id !== requestId.current) return;
        setError("network");
        setData(null);
      })
      .finally(() => {
        if (cancelled || id !== requestId.current) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, nonce, ...deps]);

  const reload = React.useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, error, reload, setData };
}

/** POST/PUT/PATCH/DELETE helper that always returns `{ ok, status, body }`. */
export async function sendJson(
  url: string,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  body?: unknown
): Promise<{ ok: boolean; status: number; body: any }> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body: parsed };
}
