import { makeApiCommand } from "../../../../command-internal/api/api.command.ts";
import { generatedCommands } from "../../../../command-internal/api/generated.ts";

export const warehouseEnableCommand = makeApiCommand(generatedCommands[0]);
