import { Context, Option } from "effect";
import type { HelpDoc } from "effect/cli";

import { ROOT_GLOBAL_FLAGS, ROOT_READ_GLOBAL_FLAGS } from "../global-flags.ts";
import { GlobalFlagsReadAnnotation } from "./with-global-flags-read.ts";

const ROOT_DECLARED: ReadonlySet<string> = new Set(ROOT_GLOBAL_FLAGS.map((flag) => flag.id));

/**
 * Narrows `GLOBAL FLAGS` for a leaf that declares its reads with `withGlobalFlagsRead` to those
 * reads, the flags the root reads for every command and Effect's built-ins. Other docs are
 * returned unchanged.
 */
export function withDeclaredGlobalFlags(doc: HelpDoc.HelpDoc): HelpDoc.HelpDoc {
  const declared = Context.getOption(doc.annotations, GlobalFlagsReadAnnotation);
  if (Option.isNone(declared) || doc.globalFlags === undefined) return doc;
  const shown = new Set([...declared.value, ...ROOT_READ_GLOBAL_FLAGS.map((flag) => flag.id)]);
  return {
    ...doc,
    globalFlags: doc.globalFlags.filter(
      (flag) => !ROOT_DECLARED.has(flag.name) || shown.has(flag.name),
    ),
  };
}
