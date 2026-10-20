import { Effect, FileSystem, Option, Path } from "effect";

import { CommandSettings } from "../../config/command-settings.service.ts";
import { candidateDotenvFilenames } from "../../shared/config/cli-config-env.ts";
import { parseDotEnv } from "../../shared/config/dotenv.ts";
import { envValue } from "../../shared/config/env-option.ts";
import { RuntimeInfo } from "../../shared/runtime/runtime-info.service.ts";
import { resolveYesSource } from "../global-flags.ts";
import { parseEnvBool } from "../supabase-env.ts";

export type HostedYesSource = "--yes" | "SUPABASE_YES";

const YES_VARIABLE = "SUPABASE_YES";

interface DotenvDefinition {
  readonly file: string;
  /** `None` when the file does not parse but mentions the variable, which counts as any value. */
  readonly value: Option.Option<string>;
}

interface Platform {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly cwd: string;
}

// Without a filesystem the origin of `SUPABASE_YES` cannot be checked, so callers treat it as
// unverified.
const platform = Effect.gen(function* () {
  const fs = yield* Effect.serviceOption(FileSystem.FileSystem);
  const path = yield* Effect.serviceOption(Path.Path);
  const runtime = yield* Effect.serviceOption(RuntimeInfo);
  return Option.all({ fs, path, runtime }).pipe(
    Option.map(({ fs, path, runtime }): Platform => ({ fs, path, cwd: runtime.cwd })),
  );
});

const envNameFrom = (variable: string) =>
  Effect.map(envValue(variable), (value) =>
    value === undefined || value === "" ? "development" : value,
  );

const definitionsIn = Effect.fnUntraced(function* (host: Platform, dir: string, env: string) {
  const found: Array<DotenvDefinition> = [];
  for (const name of candidateDotenvFilenames(env)) {
    const file = host.path.join(dir, name);
    const content = yield* host.fs.readFileString(file).pipe(Effect.option);
    if (Option.isNone(content)) continue;
    const parsed = yield* Effect.try(() => parseDotEnv(content.value)).pipe(Effect.option);
    if (Option.isNone(parsed)) {
      if (content.value.includes(YES_VARIABLE)) found.push({ file, value: Option.none() });
    } else if (Object.hasOwn(parsed.value, YES_VARIABLE)) {
      found.push({ file, value: Option.some(parsed.value[YES_VARIABLE]!) });
    }
  }
  return found;
});

/** The files Bun loads into `process.env` from the working directory before any CLI code runs. */
const autoloadedDefinitions = (host: Platform) =>
  Effect.flatMap(envNameFrom("NODE_ENV"), (env) => definitionsIn(host, host.cwd, env));

/**
 * Confirms a hosted change only for `--yes` or a `SUPABASE_YES` the shell exported. Bun copies
 * working-directory dotenv files into the environment, and a shell variable overrides them, so a
 * value that matches one of those files is treated as the file's and not as consent.
 */
export const resolveHostedYes = Effect.gen(function* () {
  const source = yield* resolveYesSource;
  if (Option.isNone(source)) return Option.none<HostedYesSource>();
  if (source.value.via === "flag") return Option.some<HostedYesSource>("--yes");
  const { raw } = source.value;
  const host = yield* platform;
  if (Option.isNone(host)) return Option.none<HostedYesSource>();
  const fromFile = (yield* autoloadedDefinitions(host.value)).some(
    ({ value }) => Option.isNone(value) || value.value === raw,
  );
  return fromFile ? Option.none<HostedYesSource>() : Option.some<HostedYesSource>("SUPABASE_YES");
});

/** Dotenv files, relative to the cwd, whose `SUPABASE_YES` does not confirm a hosted change. */
export const ignoredYesFiles = Effect.gen(function* () {
  const host = yield* platform;
  if (Option.isNone(host)) return [];
  const { path, cwd } = host.value;
  const workdir = Option.match(yield* Effect.serviceOption(CommandSettings), {
    onNone: () => cwd,
    onSome: (settings) => settings.workdir,
  });
  const projectEnv = yield* envNameFrom("SUPABASE_ENV");

  const definitions = [
    ...(yield* autoloadedDefinitions(host.value)),
    ...(yield* definitionsIn(host.value, path.join(workdir, "supabase"), projectEnv)),
    ...(yield* definitionsIn(host.value, workdir, projectEnv)),
  ];
  const files = definitions
    .filter(({ value }) => Option.isNone(value) || parseEnvBool(value.value))
    .map(({ file }) => path.relative(cwd, file));
  return [...new Set(files)];
});
