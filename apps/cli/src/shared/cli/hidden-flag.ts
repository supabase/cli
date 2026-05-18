import type { Flag, HelpDoc } from "effect/unstable/cli";
import type * as Param from "effect/unstable/cli/Param";

const hiddenFlagNames = new Set<string>();

const collectSingleNames = (param: Param.Param<Param.ParamKind, unknown>): Array<string> => {
  const node = param as
    | Param.Single<Param.ParamKind, unknown>
    | Param.Map<Param.ParamKind, unknown, unknown>
    | Param.Transform<Param.ParamKind, unknown, unknown>
    | Param.Optional<Param.ParamKind, unknown>
    | Param.Variadic<Param.ParamKind, unknown>;
  switch (node._tag) {
    case "Single":
      return [node.name];
    case "Map":
    case "Transform":
    case "Optional":
    case "Variadic":
      return collectSingleNames(node.param);
  }
};

/**
 * Marks a flag as hidden so that it is parsed normally but omitted from
 * `--help` output. This mirrors Cobra's `MarkHidden` from the Go CLI, which
 * the upstream Effect CLI does not yet expose natively.
 */
export const withHidden = <A>(flag: Flag.Flag<A>): Flag.Flag<A> => {
  for (const name of collectSingleNames(flag)) {
    hiddenFlagNames.add(name);
  }
  return flag;
};

export const stripHiddenFlagsFromHelpDoc = (doc: HelpDoc.HelpDoc): HelpDoc.HelpDoc => {
  const filteredFlags = doc.flags.filter((flag) => !hiddenFlagNames.has(flag.name));
  const filteredGlobalFlags = doc.globalFlags?.filter((flag) => !hiddenFlagNames.has(flag.name));
  return {
    ...doc,
    flags: filteredFlags,
    ...(filteredGlobalFlags !== undefined && { globalFlags: filteredGlobalFlags }),
  };
};
