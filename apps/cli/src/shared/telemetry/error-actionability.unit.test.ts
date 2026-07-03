import { describe, expect, test } from "vitest";
import {
  classifyCliErrorActionability,
  CliErrorActionabilityMetricDefinitions,
  CliErrorCategory,
  CliErrorKind,
  CliSuggestionType,
} from "./error-actionability.ts";

describe("CLI error actionability taxonomy", () => {
  test("defines the KPI classification values required for the Q2 baseline", () => {
    expect(Object.values(CliErrorKind)).toEqual([
      "user_actionable",
      "internal_bug",
      "external_service",
      "unknown",
    ]);

    expect(Object.values(CliErrorCategory)).toEqual(
      expect.arrayContaining([
        "auth",
        "missing_project_ref",
        "project_not_linked",
        "docker_not_running",
        "invalid_config",
        "db_connection",
        "migration_drift",
        "permission",
        "plan_limit",
        "invalid_input",
        "panic",
        "unknown",
        "impossible_state",
      ]),
    );

    expect(Object.values(CliSuggestionType)).toEqual(
      expect.arrayContaining([
        "login",
        "link_project",
        "start_docker",
        "set_env_var",
        "repair_migration",
        "update_config",
        "upgrade_plan",
        "rerun_debug",
        "none",
      ]),
    );
  });

  test("documents queryable recovery and repeat definitions", () => {
    expect(CliErrorActionabilityMetricDefinitions.strictRecovery.id).toBe(
      "same_command_success_same_session",
    );
    expect(CliErrorActionabilityMetricDefinitions.repeatError.id).toBe(
      "same_command_same_error_same_session_before_success",
    );
    expect(CliErrorActionabilityMetricDefinitions.internalUnknownBugRate.id).toBe(
      "failed_commands_internal_bug_or_unknown",
    );
  });

  test("classifies auth errors without using raw messages", () => {
    expect(
      classifyCliErrorActionability({
        _tag: "LegacyPlatformAuthRequiredError",
        message: "token abc123 for project ref xyz",
      }),
    ).toEqual({
      error_kind: "user_actionable",
      error_category: "auth",
      error_fingerprint: "tag:LegacyPlatformAuthRequiredError",
      has_suggestion: true,
      suggestion_type: "login",
      suggested_command: "supabase login",
    });
  });

  test("classifies project link and project ref errors separately", () => {
    expect(classifyCliErrorActionability({ _tag: "LegacyProjectNotLinkedError" })).toMatchObject({
      error_kind: "user_actionable",
      error_category: "project_not_linked",
      error_fingerprint: "tag:LegacyProjectNotLinkedError",
      suggestion_type: "link_project",
      suggested_command: "supabase link",
    });

    expect(classifyCliErrorActionability({ _tag: "LegacyProjectRefRequiredError" })).toMatchObject({
      error_kind: "user_actionable",
      error_category: "missing_project_ref",
      error_fingerprint: "tag:LegacyProjectRefRequiredError",
      suggestion_type: "link_project",
    });
  });

  test("classifies Docker and CLI input failures as user-actionable", () => {
    expect(classifyCliErrorActionability({ _tag: "LegacyDockerRunError" })).toMatchObject({
      error_kind: "user_actionable",
      error_category: "docker_not_running",
      suggestion_type: "start_docker",
    });

    expect(classifyCliErrorActionability({ _tag: "UnrecognizedOption" })).toMatchObject({
      error_kind: "user_actionable",
      error_category: "invalid_input",
      has_suggestion: false,
      suggestion_type: "none",
    });
  });

  test("unwraps single-error ShowHelp envelopes for parser failures", () => {
    expect(
      classifyCliErrorActionability({
        _tag: "ShowHelp",
        errors: [{ _tag: "MissingOption", option: "project-ref" }],
      }),
    ).toMatchObject({
      error_kind: "user_actionable",
      error_category: "invalid_input",
      error_fingerprint: "tag:MissingOption",
    });
  });

  test("keeps unknown classifications sanitized", () => {
    const classified = classifyCliErrorActionability({
      _tag: "UnexpectedFailure",
      message: "failed for /Users/person/project with token secret-token",
      detail: "host db.example.internal",
      suggestion: "paste a private value",
    });

    expect(classified).toEqual({
      error_kind: "unknown",
      error_category: "unknown",
      error_fingerprint: "tag:UnexpectedFailure",
      has_suggestion: false,
      suggestion_type: "none",
    });
    expect(JSON.stringify(classified)).not.toContain("/Users/person/project");
    expect(JSON.stringify(classified)).not.toContain("secret-token");
    expect(JSON.stringify(classified)).not.toContain("db.example.internal");
  });

  test("does not fingerprint arbitrary string error contents", () => {
    expect(classifyCliErrorActionability("panic with token secret-token")).toEqual({
      error_kind: "unknown",
      error_category: "unknown",
      error_fingerprint: "string:unknown",
      has_suggestion: false,
      suggestion_type: "none",
    });
  });
});
