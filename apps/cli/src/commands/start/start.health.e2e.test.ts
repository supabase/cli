import { BunServices } from "@effect/platform-bun";
import { Data, Effect, FileSystem, Path } from "effect";
import { describe, expect, it } from "@effect/vitest";

import {
  overrideStackPorts,
  requireCliSuccess,
  runSupabaseEffect,
  runDockerEffect,
} from "../../../tests/helpers/cli.ts";
import { sanitizeProjectId, serviceContainerName } from "../../command-internal/docker-ids.ts";
import { getRegistryImageUrl } from "../../command-internal/docker-registry.ts";
import { SERVICE_CATALOG } from "../../command-internal/service-catalog.ts";
import { dockerfileServiceImage } from "../../shared/services/dockerfile-images.ts";
import { slimImagesEnabled } from "../../shared/services/slim-images.ts";

class StartE2eSetupError extends Data.TaggedError("StartE2eSetupError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
const overridePorts = (dir: string) =>
  Effect.tryPromise({
    try: () => overrideStackPorts(dir),
    catch: (cause) => new StartE2eSetupError({ message: "failed to override stack ports", cause }),
  });
const makeProject = Effect.fnUntraced(function* (prefix: string) {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix });
  // Best-effort: a leaked local stack would otherwise pollute the CI runner for later jobs.
  yield* Effect.addFinalizer(() =>
    runSupabaseEffect(["stop", "--no-backup"], { cwd: dir }).pipe(Effect.ignore),
  );
  return dir;
});

const START_TIMEOUT_MS = 280_000;
const SHORT_E2E_TIMEOUT_MS = 30_000;
const LIFECYCLE_OVERHEAD_MS = 90_000;
const CLEANUP_TIMEOUT_MS = 120_000;

// `start`'s correctness genuinely depends on a real Docker daemon — real label filtering and
// container lifecycle, not just CLI exit codes. See `stop.e2e.test.ts` and AGENTS.md's "e2e
// tests" section for the runner-gating convention.
describe("supabase start health (e2e)", () => {
  // The health watch inspects and dumps logs by container name against a real daemon and derives
  // recovery advice from real log bytes — not observable through in-process mocks. Reproduces
  // supabase/cli#5952: a locally cached image that cannot be executed.
  it.live(
    "names the container and its image when a cached image cannot be executed",
    () =>
      Effect.gen(function* () {
        const projectDir = yield* makeProject("sb-start-e2e-exec-");
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        const projectId = sanitizeProjectId(path.basename(projectDir));
        const mailpitContainer = serviceContainerName("inbucket", projectId);
        // The exact tag `start` resolves for Mailpit, so its already-cached check finds this
        // broken build without reaching a registry.
        const mailpitImage = yield* getRegistryImageUrl(
          dockerfileServiceImage("mailpit", yield* slimImagesEnabled),
        );

        const init = yield* runSupabaseEffect(["init"], {
          cwd: projectDir,
          exitTimeoutMs: SHORT_E2E_TIMEOUT_MS,
        });
        requireCliSuccess(init, "init setup");
        yield* overridePorts(projectDir);

        // A `scratch` image whose entrypoint is not an executable binary — the
        // kernel refuses it with exactly the "exec format error" this diagnoses.
        const buildDir = path.join(projectDir, "broken-image");
        yield* fs.makeDirectory(buildDir, { recursive: true });
        yield* fs.writeFileString(path.join(buildDir, "mailpit"), "not an executable\n", {
          mode: 0o755,
        });
        yield* fs.writeFileString(
          path.join(buildDir, "Dockerfile"),
          'FROM scratch\nCOPY mailpit /mailpit\nENTRYPOINT ["/mailpit"]\n',
        );
        yield* Effect.acquireRelease(
          runDockerEffect([
            "build",
            "-q",
            "--label",
            "com.supabase.cli.e2e.broken-image=true",
            "-t",
            mailpitImage,
            buildDir,
          ]).pipe(Effect.as(mailpitImage)),
          // Never leave a poisoned tag behind for later jobs on this runner.
          (image) => runDockerEffect(["image", "rm", "-f", image]).pipe(Effect.ignore),
        );

        // Everything except Postgres and Mailpit is excluded: this scenario only
        // needs one container that cannot start.
        const excludeArgs = SERVICE_CATALOG.flatMap((entry) =>
          entry.excludeKey === undefined || entry.excludeKey === "mailpit"
            ? []
            : ["--exclude", entry.excludeKey],
        );
        const start = yield* runSupabaseEffect(["start", ...excludeArgs], {
          cwd: projectDir,
          exitTimeoutMs: START_TIMEOUT_MS,
        });

        expect(start.exitCode, `stdout:\n${start.stdout}\nstderr:\n${start.stderr}`).not.toBe(0);
        // The container's established name is "inbucket", not the id `docker create` returns.
        expect(start.stderr).toContain(`${mailpitContainer} container logs:`);
        expect(start.stderr).toContain(`${mailpitContainer} container is not ready`);
        expect(start.stderr).toContain(`${mailpitContainer}'s image ${mailpitImage}`);
        expect(start.stderr).toContain(`image rm -f ${mailpitImage}`);
      }).pipe(Effect.provide(BunServices.layer)),
    START_TIMEOUT_MS + LIFECYCLE_OVERHEAD_MS + CLEANUP_TIMEOUT_MS,
  );

  // Only Postgres, Logflare, and Vector run. Every other scenario here excludes Logflare and Vector,
  // so this is the one that exercises the Vector image's entrypoint end to end.
  it.live(
    "starts Vector against a real Logflare and reaches healthy",
    () =>
      Effect.gen(function* () {
        const projectDir = yield* makeProject("sb-start-e2e-vector-");
        const path = yield* Path.Path;
        const projectId = sanitizeProjectId(path.basename(projectDir));
        const vectorContainer = serviceContainerName("vector", projectId);

        const init = yield* runSupabaseEffect(["init"], {
          cwd: projectDir,
          exitTimeoutMs: SHORT_E2E_TIMEOUT_MS,
        });
        requireCliSuccess(init, "init setup");
        yield* overridePorts(projectDir);

        const excludeArgs = SERVICE_CATALOG.flatMap((entry) =>
          entry.excludeKey === undefined ||
          entry.excludeKey === "logflare" ||
          entry.excludeKey === "vector"
            ? []
            : ["--exclude", entry.excludeKey],
        );
        const start = yield* runSupabaseEffect(["start", ...excludeArgs], {
          cwd: projectDir,
          exitTimeoutMs: START_TIMEOUT_MS,
        });

        if (start.exitCode !== 0) {
          const logs = yield* runDockerEffect(["logs", vectorContainer]).pipe(
            Effect.map(({ stdout, stderr }) => `${stdout}${stderr}`.trim() || "<empty>"),
            Effect.catch((error) => Effect.succeed(`<unavailable: ${error.message}>`)),
          );
          throw new Error(
            `start failed (exit ${start.exitCode})\nstdout:\n${start.stdout}\nstderr:\n${start.stderr}\n${vectorContainer} logs:\n${logs}`,
          );
        }

        const health = yield* runDockerEffect([
          "inspect",
          vectorContainer,
          "--format",
          "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
        ]);
        expect(health.stdout.trim()).toBe("healthy");
      }).pipe(Effect.provide(BunServices.layer)),
    START_TIMEOUT_MS + LIFECYCLE_OVERHEAD_MS + CLEANUP_TIMEOUT_MS,
  );
});
