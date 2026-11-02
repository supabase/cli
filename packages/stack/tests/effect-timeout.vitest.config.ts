import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    hookTimeout: 5_000,
    include: [fileURLToPath(new URL("./effect-timeout.fixture.ts", import.meta.url))],
    testTimeout: 100,
  },
});
