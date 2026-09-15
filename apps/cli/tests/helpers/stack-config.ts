import { Effect, FileSystem, Path } from "effect";

export function createStackConfigProject(
  config: string,
  options: {
    readonly prefix?: string;
    readonly rootEnv?: string;
    readonly supabaseEnv?: string;
    readonly sharedFunctionEnvironment?: string;
    readonly functionEnvironments?: Readonly<Record<string, string>>;
    readonly functionNames?: ReadonlyArray<string>;
  } = {},
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({
      prefix: options.prefix ?? "supabase-stack-config-",
    });
    const supabase = path.join(root, "supabase");
    const functions = path.join(supabase, "functions");
    yield* fs.makeDirectory(functions, { recursive: true });
    for (const name of options.functionNames ?? ["hello", "world", "disabled"])
      yield* fs.makeDirectory(path.join(functions, name), { recursive: true });
    yield* fs.writeFileString(path.join(root, ".env"), options.rootEnv ?? "");
    yield* fs.writeFileString(path.join(supabase, "config.toml"), config);
    yield* fs.writeFileString(path.join(supabase, ".env"), options.supabaseEnv ?? "");
    if (options.sharedFunctionEnvironment !== undefined)
      yield* fs.writeFileString(path.join(functions, ".env"), options.sharedFunctionEnvironment);
    for (const [name, contents] of Object.entries(options.functionEnvironments ?? {}))
      yield* fs.writeFileString(path.join(functions, name, ".env"), contents);
    return root;
  });
}
