import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

import { LEGACY_DOCKER_PULL_RETRY_DELAYS_MS } from "../../src/legacy/shared/legacy-docker-image-resolve.ts";
import { legacyGetRegistryImageUrlCandidates } from "../../src/legacy/shared/legacy-docker-registry.ts";
import { legacyIsDockerDaemonUnreachable } from "../../src/legacy/shared/legacy-docker-suggest.ts";

const INSPECT_TIMEOUT_MS = 15_000;
const PULL_ATTEMPT_TIMEOUT_MS = 120_000;
// Overall per-image ceiling. Deliberately BELOW the tightest e2e test budget
// (120s): a stalled registry must leave the caller room to run its test body,
// and vitest cannot preempt a blocked synchronous spawn to enforce that itself.
const RESOLVE_DEADLINE_MS = 90_000;
const PULL_MAX_BUFFER = 16 * 1024 * 1024;
const PULL_ATTEMPTS = LEGACY_DOCKER_PULL_RETRY_DELAYS_MS.length + 1;

const resolvedImages = new Map<string, Promise<string>>();

/**
 * Resolves an image for a raw e2e `docker run`/`docker pull` the same way the
 * production resolver does (`legacy-docker-image-resolve.ts`): any candidate
 * already in the local cache wins, otherwise each registry fallback
 * (ECR → GHCR → Docker Hub) is pulled explicitly with 4s/8s retries. A raw
 * `docker run` of an uncached image implicit-pulls from a single registry,
 * where CI regularly fails with `toomanyrequests: Rate exceeded`. Returns the
 * resolved reference the caller must use in its own docker argv. Results
 * (including failures) are memoized per process so parallel/subsequent tests
 * never re-pay the retry ladder. Every subprocess call is timeout-bounded —
 * vitest's own testTimeout cannot preempt a hung synchronous spawn.
 */
export function ensureImage(image: string): Promise<string> {
  const memo = resolvedImages.get(image);
  if (memo !== undefined) return memo;
  const resolving = resolveImage(image);
  resolvedImages.set(image, resolving);
  return resolving;
}

function spawnFailed(result: { error?: Error; signal: NodeJS.Signals | null }): boolean {
  return result.error !== undefined && (result.signal === null || result.signal === undefined);
}

async function resolveImage(image: string): Promise<string> {
  const candidates = legacyGetRegistryImageUrlCandidates(image);
  for (const candidate of candidates) {
    const inspect = spawnSync("docker", ["image", "inspect", candidate], {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "pipe"],
      timeout: INSPECT_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    if (spawnFailed(inspect)) {
      throw new Error(`failed to run docker: ${inspect.error?.message ?? "unknown spawn error"}`);
    }
    if (inspect.status === 0) return candidate;
    const stderr = (inspect.stderr ?? "").trim();
    if (legacyIsDockerDaemonUnreachable(stderr)) {
      throw new Error(`docker daemon unreachable: ${stderr}`);
    }
  }

  const deadline = Date.now() + RESOLVE_DEADLINE_MS;
  // Equal split so a candidate that stalls (accepts the connection but never
  // completes) can never starve the fallbacks that come after it — every
  // registry is guaranteed its share of the overall deadline.
  const perCandidateBudgetMs = Math.floor(RESOLVE_DEADLINE_MS / candidates.length);
  const failures: Array<string> = [];
  for (const candidate of candidates) {
    const candidateDeadline = Math.min(Date.now() + perCandidateBudgetMs, deadline);
    for (let attemptIndex = 0; attemptIndex < PULL_ATTEMPTS; attemptIndex += 1) {
      const remainingMs = candidateDeadline - Date.now();
      if (remainingMs <= 0) {
        failures.push(`${candidate}: candidate budget exhausted (${perCandidateBudgetMs}ms)`);
        break;
      }
      console.error(
        `[ensureImage] pulling ${candidate} (attempt ${attemptIndex + 1}/${PULL_ATTEMPTS})`,
      );
      // stdout carries the (unbounded) layer-progress stream — ignore it so a
      // large healthy pull can never die on ENOBUFS; docker writes errors to
      // stderr, which stays small and is all the failure text needs.
      const pull = spawnSync("docker", ["pull", candidate], {
        encoding: "utf8",
        stdio: ["ignore", "ignore", "pipe"],
        timeout: Math.min(PULL_ATTEMPT_TIMEOUT_MS, remainingMs),
        killSignal: "SIGKILL",
        maxBuffer: PULL_MAX_BUFFER,
      });
      if (spawnFailed(pull)) {
        throw new Error(`failed to run docker: ${pull.error?.message ?? "unknown spawn error"}`);
      }
      if (pull.status === 0) return candidate;
      const output = (pull.stderr ?? "").trim();
      const reason =
        pull.signal !== null && pull.signal !== undefined
          ? `killed by ${pull.signal} after ${PULL_ATTEMPT_TIMEOUT_MS}ms`
          : output.length > 0
            ? output
            : `exit ${pull.status ?? "unknown"}`;
      failures.push(`${candidate} attempt ${attemptIndex + 1}: ${reason}`);
      const delay = LEGACY_DOCKER_PULL_RETRY_DELAYS_MS[attemptIndex];
      if (delay === undefined) continue;
      if (Date.now() + delay >= candidateDeadline) break;
      await sleep(delay);
    }
  }
  return allRegistriesFailed(image, failures);
}

function allRegistriesFailed(image: string, failures: ReadonlyArray<string>): never {
  throw new Error(
    `failed to pull ${image} from all registries (set SUPABASE_INTERNAL_IMAGE_REGISTRY to pin one):\n${failures.join("\n")}`,
  );
}
