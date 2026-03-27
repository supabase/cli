import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { findCommand, getHelpDoc } from "../../docs/command-docs.ts";
import { platformOperationDescriptors } from "./platform-descriptors.ts";
import { buildPlatformGeneratedExamples } from "./platform-examples.ts";
import { platformCommand } from "./platform-tree.ts";

function findPlatformOperationDescriptor(operationId: string) {
  const descriptor = platformOperationDescriptors.find(
    (candidate) => candidate.operationId === operationId,
  );
  if (descriptor === undefined) {
    throw new Error(`No platform operation descriptor was found for ${operationId}.`);
  }
  return descriptor;
}

describe("platform example generation", () => {
  it("generates stable binary examples from descriptor shape", () => {
    const descriptor = findPlatformOperationDescriptor("v1CreateAFunction");
    const generated = buildPlatformGeneratedExamples(descriptor);

    expect(generated.inputHelp?.body?.examples).toEqual([
      expect.objectContaining({
        description: "Read raw bytes from a file.",
        command:
          'supabase platform projects functions create --params \'{"ref":"project-ref"}\' --body-file ./body.bin',
      }),
      expect.objectContaining({
        description: "Read raw bytes from stdin.",
        command:
          'cat ./body.bin | supabase platform projects functions create --params \'{"ref":"project-ref"}\' --body -',
      }),
    ]);
  });

  it("generates multipart examples with binary placeholders and structured metadata", () => {
    const descriptor = findPlatformOperationDescriptor("v1DeployAFunction");
    const generated = buildPlatformGeneratedExamples(descriptor);
    const example = generated.inputHelp?.body?.examples?.[0];

    expect(example).toEqual(
      expect.objectContaining({
        description:
          "Pass structured multipart fields with `--json` and binary parts with `--upload`.",
      }),
    );
    expect(example?.command).toContain("supabase platform projects functions deploy");
    expect(example?.command).toContain('--params \'{"ref":"project-ref"}\'');
    expect(example?.command).toContain(
      '--json \'{"metadata":{"entrypoint_path":"entrypoint_path-value"}}\'',
    );
    expect(example?.command).toContain("--upload file=./file-1.bin");
    expect(example?.command).toContain("--upload file=./file-2.bin");
  });

  it("generates urlencoded examples from schema fields", () => {
    const descriptor = findPlatformOperationDescriptor("v1ExchangeOauthToken");
    const generated = buildPlatformGeneratedExamples(descriptor);
    const example = generated.inputHelp?.body?.examples?.[0];

    expect(example).toEqual(
      expect.objectContaining({
        command:
          'supabase platform oauth token exchange --json \'{"grant_type":"refresh_token","refresh_token":"refresh-token"}\'',
      }),
    );
  });

  it("generates json body examples with required fields only", () => {
    const descriptor = findPlatformOperationDescriptor("v1CreateAProject");
    const generated = buildPlatformGeneratedExamples(descriptor);
    const example = generated.inputHelp?.body?.examples?.[0];

    expect(example).toEqual(
      expect.objectContaining({
        command: expect.stringContaining(
          `--json '{"db_pass":"<redacted>","name":"example-name","organization_slug":"organization_slug-value"}'`,
        ),
      }),
    );
  });

  it("adds generated examples to leaf command help docs", () => {
    const leaf = findCommand(platformCommand, ["projects", "functions", "create"]);
    expect(leaf).toBeDefined();
    const helpDoc = getHelpDoc(leaf!, ["supabase", "platform", "projects", "functions", "create"]);

    expect(helpDoc.examples).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: expect.stringContaining("--body-file ./body.bin"),
        }),
      ]),
    );
  });

  it("keeps no-input help text aligned for commands without request input", () => {
    const leaf = findCommand(platformCommand, ["projects", "list"]);
    expect(leaf).toBeDefined();
    const helpDoc = getHelpDoc(leaf!, ["supabase", "platform", "projects", "list"]);

    expect(helpDoc.examples).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          description: "Run the command with no additional input.",
          command: "supabase platform projects list",
        }),
      ]),
    );
  });

  it("generates params-only examples from descriptor shape", () => {
    const descriptor = findPlatformOperationDescriptor("v1DeleteABranch");
    const generated = buildPlatformGeneratedExamples(descriptor);

    expect(generated.commandExamples).toEqual([
      expect.objectContaining({
        description: "Pass the required path, query, or header input with `--params`.",
        command: `supabase ${descriptor.commandPath.join(" ")} --params '{"branch_id_or_ref":"branch-ref"}'`,
      }),
    ]);
  });

  it("generates no-input examples for leaf commands with no request input", () => {
    const descriptor = findPlatformOperationDescriptor("v1ListAllProjects");
    const generated = buildPlatformGeneratedExamples(descriptor);

    expect(generated.commandExamples).toEqual([
      expect.objectContaining({
        description: "Run the command with no additional input.",
        command: `supabase ${descriptor.commandPath.join(" ")}`,
      }),
    ]);
  });

  it("ensures every platform route has generated command examples", () => {
    for (const descriptor of platformOperationDescriptors) {
      const generated = buildPlatformGeneratedExamples(descriptor);
      expect(generated.commandExamples.length).toBeGreaterThan(0);
    }
  });

  it("keeps body examples for every body-bearing route", () => {
    for (const descriptor of platformOperationDescriptors) {
      if (descriptor.request.body.kind === "none") {
        continue;
      }

      const generated = buildPlatformGeneratedExamples(descriptor);
      expect(generated.inputHelp?.body?.examples?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("keeps operation-specific logic isolated to the override map", () => {
    const sourcePath = path.resolve(
      dirname(fileURLToPath(import.meta.url)),
      "platform-examples.ts",
    );
    const source = readFileSync(sourcePath, "utf8");

    expect(source).not.toMatch(/case\s+"v1[A-Za-z0-9]+"/);
    expect(source).toMatch(/bodyExampleOverrides/);
  });
});
