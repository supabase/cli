import { Effect } from "effect";
import { resolveArtifact } from "../Artifacts.ts";
import type { InitializationCommand, ResolvedCommand } from "../Commands.ts";
import { ServiceError } from "../Service.ts";
import type { StackCredentials } from "../State.ts";
import * as Auth from "./Auth.ts";
import * as Realtime from "./Realtime.ts";
import * as Storage from "./Storage.ts";
import {
  resolveStartupCommand,
  startupEndpointsFor,
  type ProcessRecipeSpec,
  type StartupCommand,
} from "./ProcessRecipe.ts";
import type { RecipeCreation, CatalogOptions } from "./Recipe.ts";

const resolve = <C extends RecipeCreation<"auth" | "storage" | "realtime", unknown>>(
  service: C["service"],
  creation: C,
  spec: ProcessRecipeSpec<C>,
  command: StartupCommand & { readonly containerEntrypoint: string },
  runtime: CatalogOptions["runtime"],
): Effect.Effect<ResolvedCommand, ServiceError> =>
  Effect.gen(function* () {
    const artifact = yield* resolveArtifact({ service, version: creation.version });
    const startup = yield* resolveStartupCommand(
      creation,
      spec,
      command,
      startupEndpointsFor(creation, spec, { container: runtime !== "native" }),
      { container: runtime !== "native" },
    );
    return {
      service,
      version: artifact.version,
      image: artifact.image,
      nativeExecutable: startup.executable,
      containerEntrypoint: command.containerEntrypoint,
      args: startup.args,
      env: startup.env,
      mounts: startup.mounts,
    } satisfies ResolvedCommand;
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof ServiceError
        ? cause
        : new ServiceError({
            operation: "command",
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
    ),
  );

/** Resolves a typed one-shot service command from the service's ordinary recipe. */
export const resolveInitializationCommand = (
  input: InitializationCommand,
  options: {
    readonly runtime: CatalogOptions["runtime"];
    readonly credentials: StackCredentials;
  },
): Effect.Effect<ResolvedCommand, ServiceError> => {
  switch (input.type) {
    case "auth.initialize":
      return resolve(
        "auth",
        {
          service: "auth",
          ...(input.version === undefined ? {} : { version: input.version }),
          config: {
            databaseUrl: input.databaseUrl,
            jwtSecret: options.credentials.jwtSecret,
            gotrueJwtKeys: options.credentials.gotrueJwtKeys,
          },
        },
        Auth.makeSpec(),
        Auth.initializationCommand,
        options.runtime,
      );
    case "storage.initialize":
      return resolve(
        "storage",
        {
          service: "storage",
          ...(input.version === undefined ? {} : { version: input.version }),
          config: {
            databaseUrl: input.databaseUrl,
            filePath: input.filePath,
            jwtSecret: options.credentials.jwtSecret,
            jwks: options.credentials.jwks,
            anonKey: options.credentials.anonKey,
            serviceRoleKey: options.credentials.serviceRoleKey,
          },
        },
        Storage.makeSpec(),
        Storage.initializationCommand,
        options.runtime,
      );
    case "realtime.initialize":
      return resolve(
        "realtime",
        {
          service: "realtime",
          ...(input.version === undefined ? {} : { version: input.version }),
          config: {
            databaseUrl: input.databaseUrl,
            jwtSecret: options.credentials.jwtSecret,
            jwks: options.credentials.jwks,
          },
        },
        Realtime.makeSpec(),
        Realtime.initializationCommand,
        options.runtime,
      );
  }
};
