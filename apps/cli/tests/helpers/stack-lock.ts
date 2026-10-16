import type { ArtifactPin } from "@supabase/stack/internal/artifacts";
import { readLock, writeLock, type Lock } from "@supabase/stack/effect";
import { Effect, Option } from "effect";

import { loadStackConfig } from "../../src/command-internal/stack-config.ts";
import { lockedSelection } from "../../src/command-internal/stack-lock.ts";
import { Output } from "../../src/shared/output/output.service.ts";
import { mockOutput } from "./mocks.ts";

/** A published pin the CLI does not bundle: the same release a hundred revisions later. */
export const unbundled = (pin: ArtifactPin): ArtifactPin => {
  const revision = pin.revision + 100;
  return {
    ...pin,
    revision,
    image: pin.image.replace(
      `:${pin.upstreamVersion}-r${pin.revision}@`,
      `:${pin.upstreamVersion}-r${revision}@`,
    ),
  };
};

/**
 * Writes the default `supabase/supabase.lock` of a project, as a first `supabase start` does;
 * `edit` then rewrites its services, for example to pin a release the CLI does not bundle.
 */
export const seedLock = (
  projectRoot: string,
  edit: (services: Lock["services"]) => Lock["services"] = (services) => services,
) =>
  Effect.gen(function* () {
    const output = yield* Output;
    yield* loadStackConfig(projectRoot, { selection: lockedSelection({ frozen: false, output }) });
    const lock = yield* readLock(projectRoot).pipe(Effect.map(Option.getOrThrow));
    yield* writeLock(projectRoot, { ...lock, services: edit(lock.services) });
  }).pipe(Effect.provide(mockOutput().layer), Effect.asVoid, Effect.orDie);
