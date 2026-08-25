export const edgeFunctionsDirectoryName = "functions";
export const edgeFunctionEntrypointFileName = "index.ts";
export const edgeFunctionDenoConfigFileName = "deno.json";

export interface ResolvedFunctionConfig {
  readonly enabled: boolean;
  readonly verify_jwt: boolean;
  readonly import_map: string;
  readonly entrypoint: string;
  readonly static_files: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
}

export type FunctionsManifest = Readonly<Record<string, ResolvedFunctionConfig>>;
