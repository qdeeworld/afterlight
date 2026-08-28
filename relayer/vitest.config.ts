import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      // Unit tests intentionally exercise the inert preflight surface. The
      // production config is validated separately by Wrangler dry-run.
      wrangler: { configPath: "./wrangler.staging.jsonc" },
    }),
  ],
});
