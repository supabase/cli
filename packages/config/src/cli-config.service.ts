import type { Effect } from "effect";
import { Context } from "effect";
import type {
  LoadedCliConfig,
  LoadCliConfigOptions,
  SaveCliConfigOptions,
} from "./config-document.ts";

interface CliConfigStoreShape {
  readonly load: (
    cwd: string,
    options?: LoadCliConfigOptions,
  ) => Effect.Effect<LoadedCliConfig | null, unknown>;
  readonly loadFile: (path: string) => Effect.Effect<LoadedCliConfig, unknown>;
  readonly save: (options: SaveCliConfigOptions) => Effect.Effect<LoadedCliConfig, unknown>;
}

export class CliConfigStore extends Context.Service<CliConfigStore, CliConfigStoreShape>()(
  "@supabase/config/CliConfigStore",
) {}
