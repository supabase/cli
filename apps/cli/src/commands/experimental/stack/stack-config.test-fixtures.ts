// oxlint-disable-next-line effecttsgo/node-builtin-import -- filesystem test fixture uses the host adapter at this boundary
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- filesystem test fixture uses the host adapter at this boundary
import { join } from "node:path";
import { useTempWorkdir } from "../../../../tests/helpers/command-mocks.ts";

export const stackConfigTempRoot = useTempWorkdir("supabase-stack-config-");

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
): string {
  const root = mkdtempSync(join(stackConfigTempRoot.current, options.prefix ?? "project-"));
  const supabase = join(root, "supabase");
  const functions = join(supabase, "functions");
  mkdirSync(functions, { recursive: true });
  for (const name of options.functionNames ?? ["hello", "world", "disabled"])
    mkdirSync(join(functions, name), { recursive: true });
  writeFileSync(join(root, ".env"), options.rootEnv ?? "");
  writeFileSync(join(supabase, "config.toml"), config);
  writeFileSync(join(supabase, ".env"), options.supabaseEnv ?? "");
  if (options.sharedFunctionEnvironment !== undefined)
    writeFileSync(join(functions, ".env"), options.sharedFunctionEnvironment);
  for (const [name, contents] of Object.entries(options.functionEnvironments ?? {}))
    writeFileSync(join(functions, name, ".env"), contents);
  return root;
}
