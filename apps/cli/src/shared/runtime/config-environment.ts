import { ConfigProvider, Effect, Match } from "effect";

/** Collects a configuration provider into the flat key/value shape used by an environment. */
export const collectConfigEnvironment = (
  provider: ConfigProvider.ConfigProvider,
): Effect.Effect<Record<string, string>, ConfigProvider.SourceError> =>
  Effect.gen(function* () {
    const environment: Record<string, string> = {};
    const visit = (path: ConfigProvider.Path): Effect.Effect<void, ConfigProvider.SourceError> =>
      Effect.gen(function* () {
        const node = yield* provider.load(path);
        if (node === undefined) return;

        const key = path.map(String).join("_");
        if (key.length > 0 && node.value !== undefined) {
          environment[key] = node.value;
        }
        const children = Match.valueTags(node, {
          Value: () => [],
          Record: ({ keys }) => [...keys],
          Array: ({ length }) => Array.from({ length }, (_, index) => index),
        });
        yield* Effect.forEach(children, (child) => visit([...path, child]), { discard: true });
      });

    yield* visit([]);
    return environment;
  });
