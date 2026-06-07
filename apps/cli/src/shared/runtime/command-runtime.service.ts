import { Context } from "effect";

interface CommandRuntimeShape {
  readonly commandPath: ReadonlyArray<string>;
  readonly commandRunId: string;
}

function commandAnalyticsName(commandPath: ReadonlyArray<string>): string {
  return commandPath.join(" ");
}

function commandSpanName(commandPath: ReadonlyArray<string>): string {
  return `command.${commandPath.join(".")}`;
}

export function getCommandRuntimeCommand(runtime: {
  readonly commandPath: ReadonlyArray<string>;
}): string {
  return commandAnalyticsName(runtime.commandPath);
}

export function getCommandRuntimeSpanName(runtime: {
  readonly commandPath: ReadonlyArray<string>;
}): string {
  return commandSpanName(runtime.commandPath);
}

export class CommandRuntime extends Context.Service<CommandRuntime, CommandRuntimeShape>()(
  "supabase/runtime/CommandRuntime",
) {}
