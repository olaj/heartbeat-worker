import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            PING_TOKEN: "test-ping-token",
            READ_TOKEN: "test-read-token",
            CLOUDFLARE_WEBHOOK_SECRET: "test-webhook-secret",
            SLACK_WEBHOOK_URL: "https://hooks.slack.test/services/TEST",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/apply-migrations.ts"] },
  };
});
