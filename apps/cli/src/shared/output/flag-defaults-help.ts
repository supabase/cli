import { Option } from "effect";
import type { Command, HelpDoc, Param } from "effect/cli";
import { flagDefault, flagDocumentation } from "../../command-internal/flag-documentation.ts";
import { unwrapParam } from "../../command-internal/param-introspection.ts";
import {
  commandInternals,
  flattenSubcommands,
  userGlobalFlagParams,
} from "../../docs/docs-introspection.ts";

function defaultsFor(
  params: ReadonlyArray<Param.AnyFlag>,
): ReadonlyMap<string, string | undefined> {
  const defaults = new Map<string, string | undefined>();
  for (const param of params) {
    const unwrapped = unwrapParam(param);
    if (unwrapped === undefined || unwrapped.single.hidden) continue;
    const { name } = unwrapped.single;
    // Row ownership wins even when its declaration has no printable default.
    if (defaults.has(name)) continue;
    const { helpDefault, defaultValue } = flagDocumentation(unwrapped.single);
    const typeDefault = Option.exists(
      unwrapped.defaultValue,
      (value) => value === false || value === 0 || (Array.isArray(value) && value.length === 0),
    );
    const value =
      helpDefault === false ||
      (helpDefault === undefined && defaultValue === undefined && typeDefault)
        ? undefined
        : (helpDefault ?? flagDefault(unwrapped));
    defaults.set(name, value === "" ? undefined : value);
  }
  return defaults;
}

function withDefaults(
  flags: ReadonlyArray<HelpDoc.FlagDoc>,
  defaults: ReadonlyMap<string, string | undefined>,
): ReadonlyArray<HelpDoc.FlagDoc> {
  return flags.map((flag) => {
    const value = defaults.get(flag.name);
    if (value === undefined) return flag;
    const description = Option.getOrElse(flag.description, () => "");
    return {
      ...flag,
      description: Option.some(`${description}${description === "" ? "" : " "}(default: ${value})`),
    };
  });
}

/** Adds display-only defaults to text help without altering the JSON help document. */
export function withFlagDefaults(
  doc: HelpDoc.HelpDoc,
  root: Command.Command.Any | undefined,
): HelpDoc.HelpDoc {
  if (root === undefined) return doc;
  const commandPath: Array<string> = [];
  for (const token of doc.commandPath ?? doc.usage.split(" ")) {
    if (token.startsWith("[") || token.startsWith("<")) break;
    commandPath.push(token);
  }
  let current = root;
  const inherited: Array<Param.AnyFlag> = [];
  const globals: Array<Param.AnyFlag> = [...userGlobalFlagParams(root)];
  for (const segment of commandPath.slice(1)) {
    inherited.push(...commandInternals(current).contextConfig.flags);
    const next = flattenSubcommands(current).find(
      (child) => child.name === segment || child.alias === segment,
    );
    if (next === undefined) return doc;
    current = next;
    globals.push(...userGlobalFlagParams(current));
  }
  return {
    ...doc,
    flags: withDefaults(
      doc.flags,
      // Effect prefers local rows, then deduplicates inherited rows root-first.
      defaultsFor([...commandInternals(current).config.flags, ...inherited]),
    ),
    ...(doc.inheritedFlags === undefined
      ? {}
      : {
          inheritedFlags: withDefaults(doc.inheritedFlags, defaultsFor(inherited)),
        }),
    ...(doc.globalFlags === undefined
      ? {}
      : {
          globalFlags: withDefaults(doc.globalFlags, defaultsFor(globals)),
        }),
  };
}
