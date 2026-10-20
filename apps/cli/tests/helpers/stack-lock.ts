import { BunCrypto, BunServices } from "@effect/platform-bun";
import type { ArtifactPin } from "@supabase/stack/internal/artifacts";
import { readLock, writeLock, type Lock } from "@supabase/stack/effect";
import { seedSavedStack, type SeedSavedStackOptions } from "@supabase/stack/testing";
import { Effect, Layer, Option, Path } from "effect";

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

/** A pin of another upstream build of the same service, with its image tagged to match. */
export const rebuilt = (pin: ArtifactPin, upstreamVersion: string): ArtifactPin => ({
  ...pin,
  upstreamVersion,
  image: pin.image.replace(
    `:${pin.upstreamVersion}-r${pin.revision}@`,
    `:${upstreamVersion}-r${pin.revision}@`,
  ),
});

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

/**
 * Saves a stack of `projectRoot` under `supabaseHome` as a start leaves it and returns its id; see
 * `seedSavedStack` for the data it can leave.
 */
export const seedProjectStack = (
  options: Omit<SeedSavedStackOptions, "stateRoot"> & { readonly supabaseHome: string },
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const { supabaseHome, ...seed } = options;
    const { stackId } = yield* seedSavedStack({
      ...seed,
      stateRoot: path.join(supabaseHome, "stacks"),
    });
    return stackId;
  }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, BunCrypto.layer)), Effect.orDie);
