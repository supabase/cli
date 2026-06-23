import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { Output } from "../../../shared/output/output.service.ts";
import type { OutputFormat } from "../../../shared/output/types.ts";
import { Browser } from "../../../shared/runtime/browser.service.ts";
import { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import { TelemetryRuntime } from "../../../shared/telemetry/runtime.service.ts";
import { makeTelemetryIdentity } from "../../../shared/telemetry/identity.ts";
import { buildIssueUrl } from "../../../shared/issue/issue-url.ts";
import { openBugIssue, openDocsIssue, openFeatureIssue } from "./issue.handler.ts";

type OutputMessage = {
  readonly type: "info" | "success";
  readonly message: string;
  readonly data?: Record<string, unknown>;
};

function processEnvLayer(values: Readonly<Record<string, string | undefined>> = {}) {
  return Layer.effectDiscard(
    Effect.acquireRelease(
      Effect.sync(() => {
        const snapshot = { ...process.env };
        for (const key of Object.keys(process.env)) {
          delete process.env[key];
        }
        for (const [key, value] of Object.entries(values)) {
          if (value !== undefined) process.env[key] = value;
        }
        return snapshot;
      }),
      (snapshot) =>
        Effect.sync(() => {
          for (const key of Object.keys(process.env)) {
            delete process.env[key];
          }
          for (const [key, value] of Object.entries(snapshot)) {
            if (value !== undefined) process.env[key] = value;
          }
        }),
    ),
  );
}

function mockOutput(opts: { readonly format?: OutputFormat } = {}) {
  const messages: OutputMessage[] = [];
  const rawChunks: string[] = [];
  return {
    layer: Layer.succeed(Output, {
      format: opts.format ?? "text",
      interactive: true,
      intro: () => Effect.void,
      outro: () => Effect.void,
      info: (message: string) =>
        Effect.sync(() => {
          messages.push({ type: "info", message });
        }),
      warn: () => Effect.void,
      error: () => Effect.void,
      event: () => Effect.void,
      task: () =>
        Effect.succeed({
          message: () => Effect.void,
          succeed: () => Effect.void,
          fail: () => Effect.void,
          info: () => Effect.void,
          cancel: () => Effect.void,
          clear: () => Effect.void,
        }),
      promptText: () => Effect.succeed(""),
      promptPassword: () => Effect.succeed(""),
      promptConfirm: () => Effect.succeed(true),
      promptSelect: (_message, options) => Effect.succeed(options[0]!.value),
      promptMultiSelect: (_message, options) =>
        Effect.succeed(options.map((option) => option.value)),
      progress: () =>
        Effect.succeed({
          start: () => Effect.void,
          advance: () => Effect.void,
          message: () => Effect.void,
          stop: () => Effect.void,
        }),
      success: (message: string, data?: Record<string, unknown>) =>
        Effect.sync(() => {
          messages.push({ type: "success", message, data });
        }),
      fail: () => Effect.void,
      raw: (text: string) =>
        Effect.sync(() => {
          rawChunks.push(text);
        }),
      rawBytes: (bytes: Uint8Array) =>
        Effect.sync(() => {
          rawChunks.push(new TextDecoder().decode(bytes));
        }),
    }),
    messages,
    get stdoutText() {
      return rawChunks.join("");
    },
  };
}

function captureBrowser() {
  const openedUrls: string[] = [];
  return {
    layer: Layer.succeed(Browser, {
      open: (url: string) =>
        Effect.sync(() => {
          openedUrls.push(url);
        }),
    }),
    openedUrls,
  };
}

function issueParams(url: string) {
  return new URL(url).searchParams;
}

function setup(
  opts: {
    readonly env?: Record<string, string>;
    readonly execPath?: string;
  } = {},
) {
  const out = mockOutput();
  const browser = captureBrowser();
  const runtimeInfo = Layer.succeed(RuntimeInfo, {
    cwd: "/test/project",
    platform: "darwin",
    arch: "arm64",
    homeDir: "/test/home",
    execPath: opts.execPath ?? "/opt/homebrew/bin/supabase",
    pid: 1234,
  });
  const telemetryRuntime = Layer.succeed(
    TelemetryRuntime,
    TelemetryRuntime.of({
      configDir: "/test/config",
      tracesDir: "/test/config/traces",
      consent: "granted",
      showDebug: false,
      deviceId: "device-id",
      sessionId: "session-id",
      identity: makeTelemetryIdentity(undefined),
      isFirstRun: false,
      isTty: true,
      isCi: false,
      os: "darwin",
      arch: "arm64",
      cliVersion: "1.2.3-test",
    }),
  );
  const layer = Layer.mergeAll(
    out.layer,
    browser.layer,
    runtimeInfo,
    telemetryRuntime,
    processEnvLayer(opts.env ?? {}),
  );
  return { layer, out, browser };
}

describe("issue", () => {
  it.live("opens bug form with runtime fields and user-provided context", () => {
    const { layer, out, browser } = setup();

    return Effect.gen(function* () {
      yield* openBugIssue({
        area: Option.some("Local development"),
        command: Option.some("supabase start"),
        actualOutput: Option.some("database failed to start"),
        expectedBehavior: Option.none(),
        reproduce: Option.some("Run supabase start in a fresh project"),
        crashReportId: Option.some("event-123"),
        dockerServices: Option.none(),
        additionalContext: Option.none(),
        noBrowser: false,
      });

      expect(browser.openedUrls).toHaveLength(1);
      const params = issueParams(browser.openedUrls[0]!);
      expect(params.get("template")).toBe("bug-report.yml");
      expect(params.get("affected-area")).toBe("Local development");
      expect(params.get("cli-version")).toBe("1.2.3-test");
      expect(params.get("os")).toBe("darwin arm64");
      expect(params.get("install-method")).toBe("brew");
      expect(params.get("command")).toBe("supabase start");
      expect(params.get("actual-output")).toBe("database failed to start");
      expect(params.get("reproduce")).toBe("Run supabase start in a fresh project");
      expect(params.get("ticket-id")).toBe("event-123");
      expect(out.stdoutText).toBe(`${browser.openedUrls[0]}\n`);
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "success", message: "Opened GitHub issue form." }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("prints the bug URL without opening a browser when requested", () => {
    const { layer, out, browser } = setup({ env: { SUPABASE_INSTALL_METHOD: "asdf" } });

    return Effect.gen(function* () {
      yield* openBugIssue({
        area: Option.none(),
        command: Option.none(),
        actualOutput: Option.none(),
        expectedBehavior: Option.none(),
        reproduce: Option.none(),
        crashReportId: Option.none(),
        dockerServices: Option.none(),
        additionalContext: Option.none(),
        noBrowser: true,
      });

      expect(browser.openedUrls).toEqual([]);
      const params = issueParams(out.stdoutText.trim());
      expect(params.get("install-method")).toBe("Other");
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "info", message: "GitHub issue form URL:" }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("opens feature form with matching issue form field IDs", () => {
    const { layer, browser } = setup();

    return Effect.gen(function* () {
      yield* openFeatureIssue({
        existingIssues: true,
        area: Option.some("Auth"),
        problem: Option.some("I need to rotate credentials"),
        proposedSolution: Option.some("Add supabase secrets rotate"),
        alternatives: Option.some("Manual dashboard workflow"),
        additionalContext: Option.none(),
        noBrowser: false,
      });

      const params = issueParams(browser.openedUrls[0]!);
      expect(params.get("template")).toBe("feature-request.yml");
      expect(params.get("existing-issues")).toBe("I have searched the existing issues.");
      expect(params.get("affected-area")).toBe("Auth");
      expect(params.get("problem")).toBe("I need to rotate credentials");
      expect(params.get("proposed-solution")).toBe("Add supabase secrets rotate");
      expect(params.get("alternatives")).toBe("Manual dashboard workflow");
    }).pipe(Effect.provide(layer));
  });

  it.live("opens docs form with matching issue form field IDs", () => {
    const { layer, browser } = setup();

    return Effect.gen(function* () {
      yield* openDocsIssue({
        link: Option.some("https://supabase.com/docs/guides/cli"),
        issueType: Option.some("Incorrect docs"),
        problem: Option.some("The output example is stale"),
        improvement: Option.some("Update the output block"),
        additionalContext: Option.some("Reported after testing v1.2.3"),
        noBrowser: false,
      });

      const params = issueParams(browser.openedUrls[0]!);
      expect(params.get("template")).toBe("docs.yml");
      expect(params.get("link")).toBe("https://supabase.com/docs/guides/cli");
      expect(params.get("issue-type")).toBe("Incorrect docs");
      expect(params.get("problem")).toBe("The output example is stale");
      expect(params.get("improvement")).toBe("Update the output block");
      expect(params.get("additional-context")).toBe("Reported after testing v1.2.3");
    }).pipe(Effect.provide(layer));
  });

  it("truncates long fields before encoding the issue URL", () => {
    const longOutput = "x".repeat(2_000);
    const params = issueParams(
      buildIssueUrl({
        template: "bug-report.yml",
        fields: {
          "actual-output": longOutput,
        },
      }),
    );

    const actualOutput = params.get("actual-output");
    expect(actualOutput).toHaveLength(1_500);
    expect(actualOutput?.endsWith("[truncated by Supabase CLI]")).toBe(true);
  });
});
