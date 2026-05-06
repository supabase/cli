import { Flag, GlobalFlag } from "effect/unstable/cli";
import type { OutputFormat } from "../output/types.ts";

export const OutputFormatFlag = GlobalFlag.setting("output-format")({
  flag: Flag.choice("output-format", ["text", "json", "stream-json"]).pipe(
    Flag.withDescription("Output format: text (default), json, or stream-json (NDJSON)"),
    Flag.withDefault("text" as OutputFormat),
  ),
});
