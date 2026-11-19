import type {
  ApiCommandBinding,
  ApiCommandEntry,
  ApiCommandFlag,
  ApiCommandWait,
  ApiPollTarget,
} from "../src/commands/api/api-command.model.ts";

/** Method and path of an operation, for polled reads that are not generated commands. */
export interface ApiOperationRoute {
  readonly method: string;
  readonly path: string;
}

export interface ApiCommandReferenceInput {
  readonly entries: ReadonlyArray<ApiCommandEntry>;
  readonly pollTargets: ReadonlyArray<ApiPollTarget>;
  /** Route of every poll target, keyed by operation id. */
  readonly pollRoutes: Readonly<Record<string, ApiOperationRoute>>;
}

const code = (text: string): string => `\`${text}\``;

const route = ({ method, path }: ApiOperationRoute): string => code(`${method} ${path}`);

const cell = (text: string): string => text.replaceAll("|", "\\|");

/** Spec prose can carry `<placeholder>` text, which Markdown would read as an HTML tag. */
const prose = (text: string): string => text.replaceAll("<", "\\<");

const commandLine = (entry: Pick<ApiCommandEntry, "command">): string =>
  ["supabase", ...entry.command].join(" ");

const flagType = (flag: ApiCommandFlag): string =>
  flag.choices === undefined ? flag.type : `${flag.type} (${flag.choices.map(code).join(", ")})`;

const bindsTo = (entry: ApiCommandEntry, flag: ApiCommandFlag): string => {
  const binding = entry.bindings.find(
    (candidate) => candidate.source === "flag" && candidate.flag === flag.name,
  );
  if (binding === undefined) return "";
  return binding.location === "body"
    ? `body ${code(binding.pointer)}`
    : `${binding.location} ${code(binding.name)}`;
};

const requiredCell = (entry: ApiCommandEntry, flag: ApiCommandFlag): string => {
  if (!flag.required) return "no";
  const bodyBound = entry.bindings.some(
    (binding) => binding.location === "body" && binding.flag === flag.name,
  );
  return bodyBound ? `yes, unless ${code("--body")} or ${code("--file")} has the field` : "yes";
};

const flagRows = (entry: ApiCommandEntry): ReadonlyArray<string> =>
  entry.flags.map((flag) => {
    const label =
      flag.type === "boolean"
        ? `--${flag.name}`
        : `--${flag.name} <${flag.type === "json" ? "json" : flag.name}>`;
    const notes = flag.sensitive === true ? " Sensitive: never echoed or recorded." : "";
    return `| ${code(label)} | ${cell(flagType(flag))} | ${requiredCell(entry, flag)} | ${flag.repeatable ? "yes" : "no"} | ${bindsTo(entry, flag)}${notes} |`;
  });

const argumentLine = (entry: ApiCommandEntry): string | undefined => {
  if (entry.argument === undefined) return undefined;
  const binding = entry.bindings.find(
    (candidate): candidate is Extract<ApiCommandBinding, { source: "argument" }> =>
      candidate.source === "argument" && candidate.argument === entry.argument?.name,
  );
  const target = binding === undefined ? "" : `, bound to path parameter ${code(binding.name)}`;
  return `Positional argument ${code(`<${entry.argument.name}>`)}${target}.`;
};

/** The command a failed or timed-out wait names, as the runtime builds it. */
const failureHintCommand = (
  entry: ApiCommandEntry,
  wait: ApiCommandWait,
  input: ApiCommandReferenceInput,
): string => {
  const read = input.entries.find((candidate) => candidate.operationId === wait.read);
  if (read === undefined) {
    const inspect = input.entries.find(
      (candidate) =>
        candidate.operationId ===
        input.pollTargets.find((target) => target.operationId === wait.read)?.inspect,
    );
    return `${inspect === undefined ? "" : commandLine(inspect)} --remote=<ref>`.trim();
  }
  const own = read.operationId === entry.operationId;
  const parts = read.bindings.flatMap((binding) => {
    if (binding.source === "target" || binding.location === "body") return [];
    if (!own && !(binding.name in wait.params)) return [];
    const text =
      binding.source === "argument" ? `<${binding.name}>` : `--${binding.flag} <${binding.name}>`;
    return [own ? `[${text}]` : text];
  });
  return [commandLine(read), ...parts, "--remote=<ref>"].join(" ");
};

const waitSection = (
  entry: ApiCommandEntry,
  wait: ApiCommandWait,
  input: ApiCommandReferenceInput,
): ReadonlyArray<string> => {
  const publicRead = input.entries.find((candidate) => candidate.operationId === wait.read);
  const polled =
    publicRead === undefined
      ? input.pollRoutes[wait.read]
      : { method: publicRead.method, path: publicRead.apiPath };
  const polledRoute = polled === undefined ? "unknown route" : route(polled);
  const params = Object.entries(wait.params);
  return [
    "### Wait",
    "",
    `- Polls: ${polledRoute} (${code(wait.read)}${publicRead === undefined ? ", poll-only read" : publicRead.operationId === entry.operationId ? ", the command's own read" : ""}).`,
    ...(params.length === 0
      ? []
      : [
          `- Read parameters from the change response: ${params
            .map(([name, pointer]) => `${code(name)} from ${code(pointer)}`)
            .join(", ")}.`,
        ]),
    `- Status at ${code(wait.status)}; succeeded: ${wait.succeeded.map(code).join(", ")}; failed: ${wait.failed.map(code).join(", ")}.`,
    ...(wait.error === undefined ? [] : [`- Failure message from ${code(wait.error)}.`]),
    `- Failure hint names ${code(failureHintCommand(entry, wait, input))}.`,
  ];
};

const bodyLine = (entry: ApiCommandEntry): string | undefined => {
  const { body } = entry;
  if (body === undefined) return undefined;
  return body.kind === "json-envelope"
    ? `JSON envelope ${code(`data.type = ${body.type ?? ""}`)}, fields under ${code("data.attributes")}`
    : "JSON object";
};

const commandSection = (
  entry: ApiCommandEntry,
  input: ApiCommandReferenceInput,
): ReadonlyArray<string> => {
  const body = bodyLine(entry);
  const argument = argumentLine(entry);
  const flags = flagRows(entry);
  return [
    `## ${code(commandLine(entry))}`,
    "",
    prose(entry.summary),
    "",
    ...(entry.description === undefined ? [] : [prose(entry.description), ""]),
    `- Access: ${entry.readOnly ? "read-only, no consent" : "mutation, consent defaults to No (`--yes` when it cannot prompt)"}.`,
    `- Feature: ${code(entry.feature)}.`,
    ...(entry.dryRun === false ? ["- Local request preview (`--dry-run`): unavailable."] : []),
    ...(entry.confirmDescription
      ? ["- Consent: prints the API description before the interactive confirmation."]
      : []),
    `- Request: ${route({ method: entry.method, path: entry.apiPath })} (${code(entry.operationId)}), success ${entry.response.status} ${entry.response.kind}.`,
    ...(body === undefined ? [] : [`- Body: ${body}.`]),
    ...(argument === undefined ? [] : [`- ${argument}`]),
    ...(flags.length === 0
      ? []
      : [
          "",
          "### Flags",
          "",
          "| Flag | Type | Required | Repeatable | Binds to |",
          "| ---- | ---- | -------- | ---------- | -------- |",
          ...flags,
        ]),
    ...(entry.wait === undefined ? [] : ["", ...waitSection(entry, entry.wait, input)]),
    "",
  ];
};

/** Renders the per-command reference from the derived entries; formatting is left to oxfmt. */
export const renderApiCommandReference = (input: ApiCommandReferenceInput): string =>
  [
    "<!-- Generated by scripts/generate-api-commands.ts. Do not edit. -->",
    "",
    "# Generated API commands",
    "",
    "Reference for the commands generated from the Management API contract. The behavior every one of them shares (feature gates, consent, files, exit codes, output, `--wait`) is in [SIDE_EFFECTS.md](./SIDE_EFFECTS.md).",
    "",
    ...input.entries.flatMap((entry) => commandSection(entry, input)),
  ].join("\n");
