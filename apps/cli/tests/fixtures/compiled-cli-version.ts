import { Console, Effect } from "effect";
import { CLI_VERSION } from "../../src/shared/cli/version.ts";

Effect.runSync(Console.log(CLI_VERSION));
