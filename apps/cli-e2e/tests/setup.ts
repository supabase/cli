import type { ProvidedContext } from "vitest";
import { startReplayServer } from "../src/server/replay-server.ts";

// Resolve fixtures/ relative to this file:
// apps/cli-e2e/tests/setup.ts -> ../fixtures = apps/cli-e2e/fixtures
const FIXTURES_DIR = new URL("../fixtures", import.meta.url).pathname;

declare module "vitest" {
  export interface ProvidedContext {
    replayServerUrl: string;
  }
}

export async function setup({
  provide,
}: {
  provide: <K extends keyof ProvidedContext>(key: K, value: ProvidedContext[K]) => void;
}) {
  const server = await startReplayServer({ fixturesDir: FIXTURES_DIR });
  provide("replayServerUrl", server.url);
  return async () => {
    await server.stop();
  };
}
