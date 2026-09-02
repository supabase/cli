import { rmSync } from "node:fs";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";
import {
  makeWorkersProject,
  setupLegacyWorkers,
} from "../../../../../tests/helpers/legacy-workers.ts";
import { legacyWorkersDelete } from "./delete/delete.handler.ts";
import { legacyWorkersList } from "./list/list.handler.ts";
import { legacyWorkersLogs } from "./logs/logs.handler.ts";
import { legacyWorkersPush } from "./push/push.handler.ts";
import { legacyWorkersStatus } from "./status/status.handler.ts";

const CONFIG = 'project_id = "demo"\n\n[workers.api]\nruntime = "node"\n';

function project() {
  const created = makeWorkersProject({
    "supabase/config.toml": CONFIG,
    "supabase/workers/api/index.js": "export default {};\n",
  });
  return { dir: created.dir, cleanup: () => rmSync(created.dir, { recursive: true, force: true }) };
}

/**
 * Every project-scoped command, with only the flags the run needs to get as far
 * as resolving a ref.
 */
const COMMANDS = [
  ["list", () => legacyWorkersList({ projectRef: Option.none() })],
  ["status", () => legacyWorkersStatus({ name: "api", projectRef: Option.none() })],
  ["delete", () => legacyWorkersDelete({ name: "api", projectRef: Option.none() })],
  [
    "push",
    () =>
      legacyWorkersPush({
        names: ["api"],
        instances: Option.none(),
        wait: false,
        projectRef: Option.none(),
      }),
  ],
  [
    "logs",
    () =>
      legacyWorkersLogs({
        name: "api",
        projectRef: Option.none(),
        kind: Option.none(),
        follow: false,
        tail: 100,
      }),
  ],
] as const;

/**
 * The ordering `legacyWorkersRun` exists to hold.
 *
 * The command has run by the time an unlinked checkout fails inside `resolve`,
 * so its post-run event still has to be written. Four of these resolved the ref
 * above the finalizer and wrote nothing.
 */
describe("legacyWorkersRun", () => {
  for (const [name, run] of COMMANDS) {
    it.live(`flushes telemetry when ${name} cannot resolve a project ref`, () => {
      const repo = project();
      const { layer, telemetry, http } = setupLegacyWorkers({
        workdir: repo.dir,
        linked: false,
        routes: {},
      });

      return Effect.gen(function* () {
        const exit = yield* (run() as Effect.Effect<unknown, unknown, never>).pipe(Effect.exit);

        expect(Exit.isFailure(exit)).toBe(true);
        expect(telemetry.flushed).toBe(true);
        // Nothing was spent before the ref failed to resolve.
        expect(http.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
    });
  }
});
