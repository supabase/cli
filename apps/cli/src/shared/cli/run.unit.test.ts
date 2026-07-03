import { Cause, Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { Analytics } from "../telemetry/analytics.service.ts";
import {
  commandNameForRootTelemetry,
  capturePreHandlerFailureTelemetry,
  extractCommandPath,
  outputFormatForRootTelemetry,
  shouldCapturePreHandlerFailureTelemetry,
  shouldUseGlobalSignalInterrupt,
} from "./run.ts";

describe("extractCommandPath", () => {
  it("returns positional command-path tokens", () => {
    expect(extractCommandPath(["functions", "serve"])).toEqual(["functions", "serve"]);
  });

  it("skips boolean global flags", () => {
    expect(extractCommandPath(["--debug", "functions", "serve"])).toEqual(["functions", "serve"]);
  });

  it("skips value-taking global flags and their values", () => {
    expect(
      extractCommandPath(["--workdir", "/tmp/app", "--network-id", "net", "functions", "serve"]),
    ).toEqual(["functions", "serve"]);
  });

  it("treats --flag=value as a single token", () => {
    expect(extractCommandPath(["--output-format=json", "functions", "serve"])).toEqual([
      "functions",
      "serve",
    ]);
  });
});

describe("shouldUseGlobalSignalInterrupt", () => {
  it("opts out for self-managed signal commands, even behind global flags", () => {
    expect(shouldUseGlobalSignalInterrupt(["functions", "serve"])).toBe(false);
    expect(shouldUseGlobalSignalInterrupt(["start"])).toBe(false);
    expect(shouldUseGlobalSignalInterrupt(["db", "start"])).toBe(false);
    expect(
      shouldUseGlobalSignalInterrupt(["--workdir", "/tmp/app", "functions", "serve", "--debug"]),
    ).toBe(false);
  });

  it("opts in for ordinary commands", () => {
    expect(shouldUseGlobalSignalInterrupt(["functions", "list"])).toBe(true);
    expect(shouldUseGlobalSignalInterrupt(["db", "push"])).toBe(true);
    expect(shouldUseGlobalSignalInterrupt(["projects", "list"])).toBe(true);
    expect(shouldUseGlobalSignalInterrupt([])).toBe(true);
  });
});

describe("commandNameForRootTelemetry", () => {
  it("uses static command prefixes without argv values", () => {
    expect(commandNameForRootTelemetry(["branches", "get", "customer-branch", "--bad"])).toBe(
      "branches get",
    );
    expect(
      commandNameForRootTelemetry([
        "functions",
        "deploy",
        "--project-ref",
        "abcdefghijklmnopqrst",
        "my-function",
        "--bad",
      ]),
    ).toBe("functions deploy");
    expect(commandNameForRootTelemetry(["db", "schema", "declarative", "sync", "schema"])).toBe(
      "db schema declarative sync",
    );
    expect(commandNameForRootTelemetry(["db", "branch", "create", "--bad"])).toBe(
      "db branch create",
    );
    expect(commandNameForRootTelemetry(["db", "remote", "changes", "--bad"])).toBe(
      "db remote changes",
    );
    expect(commandNameForRootTelemetry(["db", "remote", "commit", "--bad"])).toBe(
      "db remote commit",
    );
    expect(commandNameForRootTelemetry(["issue", "bug", "--bad"])).toBe("issue bug");
    expect(commandNameForRootTelemetry(["issue", "feature", "--bad"])).toBe("issue feature");
    expect(commandNameForRootTelemetry(["issue", "docs", "--bad"])).toBe("issue docs");
  });

  it("normalizes the legacy migrations alias", () => {
    expect(commandNameForRootTelemetry(["migrations", "list", "--bad"])).toBe("migration list");
    expect(commandNameForRootTelemetry(["migrations", "repair", "--bad"])).toBe("migration repair");
  });

  it("falls back to root for unknown user-supplied command roots", () => {
    expect(commandNameForRootTelemetry(["customer-branch", "--bad"])).toBe("root");
  });
});

describe("outputFormatForRootTelemetry", () => {
  it("preserves legacy machine output values from -o and --output", () => {
    expect(outputFormatForRootTelemetry(["functions", "list", "-o", "env"], "text")).toBe("env");
    expect(outputFormatForRootTelemetry(["functions", "list", "-ojson", "--bad"], "text")).toBe(
      "json",
    );
    expect(outputFormatForRootTelemetry(["projects", "list", "--output=json"], "text")).toBe(
      "json",
    );
    expect(outputFormatForRootTelemetry(["db", "query", "-o=csv"], "text")).toBe("csv");
  });

  it("preserves db query table output for root telemetry", () => {
    expect(outputFormatForRootTelemetry(["db", "query", "-o", "table", "--bad"], "text")).toBe(
      "table",
    );
    expect(outputFormatForRootTelemetry(["db", "query", "-o=csv", "--bad"], "text")).toBe("csv");
  });

  it("ignores db diff output file paths", () => {
    expect(outputFormatForRootTelemetry(["db", "diff", "--output", "json", "--bad"], "text")).toBe(
      "text",
    );
    expect(outputFormatForRootTelemetry(["db", "diff", "-o=json", "--bad"], "text")).toBe("text");
  });

  it("keeps the resolved TS output format for human or invalid legacy values", () => {
    expect(outputFormatForRootTelemetry(["functions", "list", "-o", "pretty"], "text")).toBe(
      "text",
    );
    expect(outputFormatForRootTelemetry(["functions", "list", "-o", "table"], "text")).toBe("text");
    expect(outputFormatForRootTelemetry(["functions", "list", "-o", "csv"], "text")).toBe("text");
    expect(outputFormatForRootTelemetry(["functions", "list", "-o", "xml"], "json")).toBe("json");
  });
});

describe("shouldCapturePreHandlerFailureTelemetry", () => {
  it("captures parser and wrapper failures that happen before command handlers run", () => {
    expect(shouldCapturePreHandlerFailureTelemetry(Cause.fail({ _tag: "UnknownSubcommand" }))).toBe(
      true,
    );
    expect(
      shouldCapturePreHandlerFailureTelemetry(Cause.fail({ _tag: "UnrecognizedOption" })),
    ).toBe(true);
    expect(
      shouldCapturePreHandlerFailureTelemetry(
        Cause.fail({ _tag: "InvalidServiceVersionOverrideError" }),
      ),
    ).toBe(true);
    expect(
      shouldCapturePreHandlerFailureTelemetry(Cause.fail({ _tag: "ProjectConfigParseError" })),
    ).toBe(true);
    expect(
      shouldCapturePreHandlerFailureTelemetry(Cause.fail({ _tag: "ProjectEnvParseError" })),
    ).toBe(true);
    expect(
      shouldCapturePreHandlerFailureTelemetry(
        Cause.fail({ _tag: "ShowHelp", errors: [{ _tag: "MissingOption", option: "type" }] }),
      ),
    ).toBe(true);
    expect(
      shouldCapturePreHandlerFailureTelemetry(
        Cause.fail({ name: "StackError", code: "PORT_ALLOCATION" }),
      ),
    ).toBe(true);
  });

  it("does not capture legacy pre-run validation rejects", () => {
    expect(
      shouldCapturePreHandlerFailureTelemetry(
        Cause.fail({ _tag: "LegacyInvalidOutputFormatError" }),
      ),
    ).toBe(false);
    expect(
      shouldCapturePreHandlerFailureTelemetry(
        Cause.fail({ _tag: "LegacyExperimentalRequiredError" }),
      ),
    ).toBe(false);
    expect(
      shouldCapturePreHandlerFailureTelemetry(
        Cause.fail({ _tag: "LegacyStorageMutuallyExclusiveFlagsError" }),
      ),
    ).toBe(false);
    expect(
      shouldCapturePreHandlerFailureTelemetry(
        Cause.fail({ _tag: "LegacySeedMutuallyExclusiveFlagsError" }),
      ),
    ).toBe(false);
  });

  it("leaves handler failures and explicit help to the existing paths", () => {
    expect(
      shouldCapturePreHandlerFailureTelemetry(Cause.fail({ _tag: "ProjectNotLinkedError" })),
    ).toBe(false);
    expect(shouldCapturePreHandlerFailureTelemetry(Cause.fail({ name: "StackError" }))).toBe(false);
    expect(shouldCapturePreHandlerFailureTelemetry(Cause.fail({ _tag: "ShowHelp" }))).toBe(false);
  });
});

describe("capturePreHandlerFailureTelemetry", () => {
  it("is best-effort so telemetry failures do not mask CLI errors", async () => {
    const analyticsLayer = Layer.succeed(
      Analytics,
      Analytics.of({
        capture: () => Effect.die("telemetry failed"),
        identify: () => Effect.void,
        alias: () => Effect.void,
        groupIdentify: () => Effect.void,
      }),
    );

    await Effect.runPromise(
      capturePreHandlerFailureTelemetry(
        ["start"],
        "text",
        1,
        Cause.fail({ _tag: "ProjectConfigParseError" }),
      ).pipe(Effect.provide(analyticsLayer)),
    );
  });

  it("can be guarded outside telemetry layer acquisition failures", async () => {
    const analyticsLayer = Layer.effect(Analytics, Effect.die("telemetry layer failed"));

    await Effect.runPromise(
      capturePreHandlerFailureTelemetry(
        ["start"],
        "text",
        1,
        Cause.fail({ _tag: "ProjectConfigParseError" }),
      ).pipe(
        Effect.provide(analyticsLayer),
        Effect.catchCause(() => Effect.void),
      ),
    );
  });
});
