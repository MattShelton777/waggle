import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Keep the cache out of the repo folder: Dropbox sync locks files in it.
  cacheDir: join(tmpdir(), "waggle-vitest-cache"),
  test: {
    fsModuleCachePath: join(tmpdir(), "waggle-vitest-modules"),
    include: ["packages/*/test/**/*.test.ts", "sim/test/**/*.test.ts", "supabase/test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
