/**
 * Go's root command binds every persistent flag to viper and enables
 * `AutomaticEnv` with the `SUPABASE` prefix and a `-`→`_` key replacer
 * (`apps/cli-go/cmd/root.go:318-320,334`):
 *
 * ```go
 * viper.SetEnvPrefix("SUPABASE")
 * viper.SetEnvKeyReplacer(strings.NewReplacer("-", "_"))
 * viper.AutomaticEnv()
 * viper.BindPFlags(flags)
 * ```
 *
 * The net effect is that any global flag `--foo-bar` falls back to the
 * `SUPABASE_FOO_BAR` env var when the flag is absent. `viper.GetBool` casts the
 * env string via `strconv.ParseBool` (through `cast.ToBool`), which recognizes
 * exactly `1/t/T/TRUE/true/True` as true and `0/f/F/FALSE/false/False` as false;
 * any other value (including `yes`/`on`/empty/garbage) parses to an error that
 * `cast.ToBool` swallows to `false`.
 *
 * This helper reproduces `viper.GetBool` for a single bound boolean key so the
 * legacy shell honors `SUPABASE_YES`, `SUPABASE_EXPERIMENTAL`, etc. exactly like
 * the Go CLI. Effect CLI's flag parser carries no env binding, so callers OR the
 * parsed flag value with this read (flag-set wins, matching viper precedence).
 */

import { Config, ConfigProvider, Context, Effect, Layer, Match, Option } from "effect";

const LEGACY_VIPER_TRUE = new Set(["1", "t", "T", "TRUE", "true", "True"]);

interface LegacyViperEnvShape {
  readonly get: (name: string) => Effect.Effect<Option.Option<string>, Config.ConfigError>;
  readonly entries: (
    prefix: string,
  ) => Effect.Effect<Readonly<Record<string, string>>, Config.ConfigError>;
}

/**
 * Environment view used by the legacy viper compatibility helpers.
 *
 * The provider is deliberately injected rather than read from Effect's ambient
 * default. Viper treats an explicitly empty shell variable as present, while
 * the default Effect environment provider treats empty strings as missing.
 */
export class LegacyViperEnv extends Context.Service<LegacyViperEnv, LegacyViperEnvShape>()(
  "supabase/legacy/LegacyViperEnv",
) {}

export const makeLegacyViperEnvLayer = (
  provider: ConfigProvider.ConfigProvider = ConfigProvider.fromEnv({
    preserveEmptyStrings: true,
  }),
): Layer.Layer<LegacyViperEnv> =>
  Layer.succeed(LegacyViperEnv, {
    get: (name) =>
      Config.option(Config.string(name)).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, provider),
      ),
    entries: (prefix) =>
      Effect.gen(function* () {
        const output: Record<string, string> = {};
        const basePath = prefix.split("_");
        const load = (path: ReadonlyArray<string>) =>
          provider.load(path).pipe(Effect.mapError((cause) => new Config.ConfigError(cause)));
        const visit = (
          path: ReadonlyArray<string>,
          node: ConfigProvider.Node | undefined,
        ): Effect.Effect<void, Config.ConfigError> =>
          Effect.gen(function* () {
            if (node === undefined) return;
            if (node.value !== undefined) output[path.join("_")] = node.value;
            const children = Match.valueTags(node, {
              Value: () => [],
              Record: ({ keys }) => [...keys],
              Array: ({ length }) => Array.from({ length }, (_, index) => String(index)),
            });
            for (const child of children) {
              const childPath = [...path, child];
              yield* visit(childPath, yield* load(childPath));
            }
          });
        yield* visit(basePath, yield* load(basePath));
        return output;
      }),
  });

/** Production boundary layer. Tests should use `makeLegacyViperEnvLayer` with a fixed provider. */
export const legacyViperEnvLayer = makeLegacyViperEnvLayer();

/** `viper.GetBool` truthiness for an already-resolved env value (see module doc). */
function legacyViperBool(raw: string | undefined): boolean {
  return raw !== undefined && LEGACY_VIPER_TRUE.has(raw);
}

/** `viper.GetBool` for a single `SUPABASE_*` env var from the injected Effect ConfigProvider. */
export const legacyViperEnvBool = (
  name: string,
): Effect.Effect<boolean, Config.ConfigError, LegacyViperEnv> =>
  Effect.gen(function* () {
    const env = yield* LegacyViperEnv;
    return legacyViperBool(Option.getOrUndefined(yield* env.get(name)));
  });

/** Enumerate exact environment keys rooted at a prefix (for example `DOTENV_PRIVATE_KEY`). */
export const legacyViperEnvEntries = (
  prefix: string,
): Effect.Effect<Readonly<Record<string, string>>, Config.ConfigError, LegacyViperEnv> =>
  Effect.gen(function* () {
    const env = yield* LegacyViperEnv;
    return yield* env.entries(prefix);
  });

/**
 * `viper.GetBool` for a `SUPABASE_*` key where a project `supabase/.env` value may also
 * apply. Go loads the project env via `godotenv.Load`, which builds its presence map from
 * `os.Environ()` and never overwrites a key that already exists in the shell env — even one
 * set to the empty string (`godotenv@v1.5.1/godotenv.go:184-200`, called by `loadNestedEnv`
 * at `apps/cli-go/pkg/config/config.go:1220-1261`). `viper.GetBool` then reads the merged
 * env, and since the CLI never enables `AllowEmptyEnv`, an empty shell value resolves to the
 * `false` default (`viper@v1.21.0/viper.go:442-450`).
 *
 * Net effect: shell *presence* — any value, including `false`, `""`, or garbage (all of
 * which cast to `false`) — suppresses the project value entirely; the file value is
 * consulted only when the variable is absent from the shell env. `??` (not `||`) encodes
 * exactly that presence check.
 */
export function legacyViperEnvBoolWithProjectFallback(
  name: string,
  projectEnv: Record<string, string>,
): Effect.Effect<boolean, Config.ConfigError, LegacyViperEnv> {
  return Effect.gen(function* () {
    const env = yield* LegacyViperEnv;
    return legacyViperBool(Option.getOrElse(yield* env.get(name), () => projectEnv[name]));
  });
}

/**
 * `viper.GetString` for a `SUPABASE_*` key where a project `supabase/.env` value may also
 * apply — same shell-*presence*-wins semantics as {@link legacyViperEnvBoolWithProjectFallback}
 * (godotenv.Load's "don't override a key that already exists in `os.Environ()`" check is
 * presence-based, not value-based, so an empty shell value still blocks the project file's
 * value), but for a plain string-typed viper-bound flag — no `ParseBool`/`cast.ToBool` coercion,
 * just the raw merged string (or `""` when the key is absent from both, matching `viper.GetString`
 * always returning a string rather than `undefined`). `??` (not `||`) encodes the presence check.
 */
export function legacyViperEnvStringWithProjectFallback(
  name: string,
  projectEnv: Record<string, string>,
): Effect.Effect<string, Config.ConfigError, LegacyViperEnv> {
  return Effect.gen(function* () {
    const env = yield* LegacyViperEnv;
    return Option.getOrElse(yield* env.get(name), () => projectEnv[name] ?? "");
  });
}
