import { Effect } from "effect";
import { downloadProjectFunctions } from "../../../command-internal/functions-download.ts";

export const functionsDownload = Effect.fn("functions.download")(downloadProjectFunctions);
