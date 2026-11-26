import { Schema } from "effect";
import { tableRuleFilter } from "./lib/table-rule.ts";
import {
  cliConfigServiceVersionIssues,
  memoryOutOfRangeMessage,
  memoryPatternMessage,
  sizePattern,
} from "./local-rules.ts";

export { cliConfigServiceVersionIssues } from "./local-rules.ts";

const tags = ["local"];

const minCpus = 0.01;

const memory = Schema.String.annotate({
  description:
    "Memory limit for the service container, as a size such as `512MiB` or `1GiB` (1024-based, case-insensitive; a bare number is bytes). At least `6MiB`; swap is disabled.",
  examples: ["512MiB", "1GiB"],
  tags,
}).check(
  Schema.isPattern(sizePattern, { message: memoryPatternMessage }),
  Schema.makeFilter((value: string) => memoryOutOfRangeMessage(value)),
);

const cpus = Schema.Finite.annotate({
  description:
    "CPU limit for the service container, in CPUs; fractions down to `0.01` are allowed (for example `0.5`).",
  examples: [0.5, 1, 2],
  tags,
}).check(Schema.isGreaterThanOrEqualTo(minCpus, { message: "must be at least 0.01" }));

const container = Schema.Struct({
  memory: Schema.optionalKey(memory),
  cpus: Schema.optionalKey(cpus),
}).annotate({
  description:
    "Resource limits applied to the service container. Used only when the local stack runs in containers (Docker or Podman); the native runtime ignores this table.",
  tags,
});

const serviceEntry = Schema.Struct({
  version: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Version specifier: `linked` (the linked project's version), `bundled` (the version shipped with this CLI), or an upstream version optionally followed by `-r<N>`. A `-orioledb` version is only valid for `database`.",
      examples: ["bundled", "v2.197.0", "v1.30.2-r1", "17.6.1.200-orioledb"],
      tags,
    }),
  ),
  container: Schema.optionalKey(container),
});

const defaultEntry = Schema.Struct({
  version: Schema.String.annotate({
    description:
      "Version specifier for every service without its own entry: `linked` (the linked project's version) or `bundled` (the version shipped with this CLI).",
    examples: ["bundled", "linked"],
    tags,
  }),
});

const entry = Schema.optionalKey(serviceEntry);

const services = Schema.Struct({
  default: Schema.optionalKey(defaultEntry),
  database: entry,
  auth: entry,
  rest: entry,
  realtime: entry,
  storage: entry,
  imgproxy: entry,
  functions: entry,
  studio: entry,
  pgmeta: entry,
  mail: entry,
  analytics: entry,
  pooler: entry,
})
  .annotate({
    description:
      "Per-service settings for the local stack, keyed by service: version specifiers and container resource limits.",
    tags,
  })
  .check(tableRuleFilter((value) => cliConfigServiceVersionIssues(value).slice(0, 1)));

/** `[local]` — settings for the local stack only; hosted commands never read it. */
export const local = Schema.Struct({
  services: Schema.optionalKey(services),
}).annotate({
  description: "Local-stack-only settings; hosted commands never read this section.",
  tags,
});
