import type { Embedder } from "./context";

// Fail fast (run 1 user test, 2026-11-16): 3 of 24 calls hung for ~150 s until the
// Edge runtime killed them (504/546). A slow embedding falls back to text search;
// anything else slow ends the call with a clear, retryable error.

export const EMBED_TIMEOUT_MS = 3_000;
export const TOOL_TIMEOUT_MS = 12_000;

export class WaggleTimeout extends Error {
  constructor(readonly ms: number) {
    super(`timed out after ${ms} ms`);
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new WaggleTimeout(ms)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** An embedder that gives up after `ms` and returns null, so callers fall back to text search. */
export function timedEmbedder(inner: Embedder, ms = EMBED_TIMEOUT_MS): Embedder {
  return {
    async embed(text: string) {
      try {
        return await withTimeout(inner.embed(text), ms);
      } catch (err) {
        if (err instanceof WaggleTimeout) console.error(`embedding timed out after ${ms} ms; using text search`);
        else console.error("embedding failed; using text search", err);
        return null;
      }
    },
  };
}
