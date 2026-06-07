import type { Option } from "effect";
import { Context } from "effect";

interface AiToolShape {
  readonly name: Option.Option<string>;
}

export class AiTool extends Context.Service<AiTool, AiToolShape>()("supabase/telemetry/AiTool") {}
