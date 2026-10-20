import { Effect, FileSystem, Option, Path } from "effect";

import { CommandSettings } from "../config/command-settings.service.ts";
import { Output } from "../shared/output/output.service.ts";
import { yellow } from "./colors.ts";
import { readProjectRefFile } from "./temp-paths.ts";

/** Warns on stderr that a run with no target selector but a configured linked project will default to the local target in the next major. */
export const warnLinkedTargetDefault = Effect.fnUntraced(function* (input: {
  readonly command: string;
  readonly targetSelected: boolean;
  readonly linkedRefResolved?: boolean;
  readonly localTarget?: string;
}) {
  if (input.targetSelected) return;
  if (input.linkedRefResolved !== true) {
    const cliSettings = yield* CommandSettings;
    if (Option.isNone(cliSettings.projectId)) {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const refFile = yield* readProjectRefFile(fs, path, cliSettings.workdir).pipe(
        Effect.orElseSucceed(() => Option.none<string>()),
      );
      if (Option.isNone(refFile)) return;
    }
  }
  const output = yield* Output;
  const localTarget = input.localTarget ?? "the local database";
  yield* output.raw(
    `${yellow(
      `Warning: supabase ${input.command} will target ${localTarget} by default in the next major version. Pass --linked to keep targeting the linked project.`,
    )}\n`,
    "stderr",
  );
});
