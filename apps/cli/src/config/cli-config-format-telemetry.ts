import type { parseCliConfigDocumentFile } from "@supabase/config/internal";
import { Effect } from "effect";

import { PropConfigFormat } from "../shared/telemetry/event-catalog.ts";
import { recordCommandTelemetry } from "../telemetry/command-telemetry-attributes.ts";

const cliConfigFileFormat = (filePath: string) =>
  filePath.endsWith(".jsonc") ? "jsonc" : filePath.endsWith(".json") ? "json" : "toml";

export const recordConfigFormat = (filePath: string | undefined) =>
  filePath === undefined
    ? Effect.void
    : recordCommandTelemetry({ [PropConfigFormat]: cliConfigFileFormat(filePath) });

export const failedConfigFilePath = (
  error: Effect.Error<ReturnType<typeof parseCliConfigDocumentFile>>,
): string | undefined => ("path" in error ? error.path : undefined);
