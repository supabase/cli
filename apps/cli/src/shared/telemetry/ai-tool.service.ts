import type { Option } from "effect";
import { ServiceMap } from "effect";

interface AiToolShape {
  readonly name: Option.Option<string>;
}

export class AiTool extends ServiceMap.Service<AiTool, AiToolShape>()(
  "supabase/telemetry/AiTool",
) {}
