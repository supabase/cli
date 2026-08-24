import { fileURLToPath } from "node:url";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import { LEGACY_GO_BRANCH_RESPONSE } from "../commands/branches/branches.go-payload.ts";
import { LEGACY_GO_ORGANIZATION_RESPONSE } from "../commands/orgs/orgs.go-payload.ts";
import { LEGACY_GO_SSL_ENFORCEMENT_RESPONSE } from "../commands/ssl-enforcement/ssl-enforcement.go-payload.ts";
import { LEGACY_GO_SSO_PROVIDER_RESPONSE } from "../commands/sso/sso.go-payload.ts";
import type { LegacyGoType } from "./legacy-go-struct-output.encoders.ts";
import {
  compareLegacyGoTypeToParsedGoType,
  parseGoStruct,
} from "./legacy-go-struct-output.types-gen-parser.ts";

/**
 * Mechanical drift check for the `*.go-payload.ts` specs against the real Go
 * structs they mirror (CLI-1975, review kanadgupta). Parses
 * `apps/cli-go/pkg/api/types.gen.go` and structurally compares each entry
 * below against the runtime {@link LegacyGoType} spec it corresponds to —
 * field order, pointer-ness, and coarse kind must match. When
 * `types.gen.go` regenerates with a field added/removed/reordered/renamed,
 * this test fails instead of silently producing wrong `-o yaml`/`-o toml`
 * bytes.
 */

const TYPES_GEN_GO_PATH = fileURLToPath(
  new URL("../../../../cli-go/pkg/api/types.gen.go", import.meta.url),
);

interface GoPayloadSpecEntry {
  readonly specName: string;
  readonly spec: LegacyGoType;
  readonly goTypeName: string;
}

/**
 * `Create`/`Update`/`DeleteProviderResponse` share `GetProviderResponse`'s
 * exact anonymous shape (see the doc comment in `sso.go-payload.ts`), so
 * checking `GetProviderResponse` alone covers all four. Wrapper-only specs
 * (`LEGACY_GO_*_TOML_WRAPPER`, `LEGACY_GO_SSO_PROVIDERS_WRAPPER`,
 * `LEGACY_GO_*_LIST`) aren't distinct Go structs — they're a
 * `legacyGoTomlListWrapper`/`legacyGoSlice` around one of the entries below —
 * so they're intentionally excluded.
 */
const GO_PAYLOAD_SPEC_REGISTRY: ReadonlyArray<GoPayloadSpecEntry> = [
  {
    specName: "LEGACY_GO_BRANCH_RESPONSE",
    spec: LEGACY_GO_BRANCH_RESPONSE,
    goTypeName: "BranchResponse",
  },
  {
    specName: "LEGACY_GO_ORGANIZATION_RESPONSE",
    spec: LEGACY_GO_ORGANIZATION_RESPONSE,
    goTypeName: "OrganizationResponseV1",
  },
  {
    specName: "LEGACY_GO_SSL_ENFORCEMENT_RESPONSE",
    spec: LEGACY_GO_SSL_ENFORCEMENT_RESPONSE,
    goTypeName: "SslEnforcementResponse",
  },
  {
    specName: "LEGACY_GO_SSO_PROVIDER_RESPONSE",
    spec: LEGACY_GO_SSO_PROVIDER_RESPONSE,
    goTypeName: "GetProviderResponse",
  },
];

describe("go-payload specs vs types.gen.go (drift check)", () => {
  it.effect.each(GO_PAYLOAD_SPEC_REGISTRY)(
    "$specName matches Go's $goTypeName with zero drift",
    ({ spec, goTypeName }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const source = yield* fs.readFileString(TYPES_GEN_GO_PATH);
        const parsed = parseGoStruct(source, goTypeName);
        expect(compareLegacyGoTypeToParsedGoType(spec, parsed)).toEqual([]);
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it("has teeth: reports a mismatch when a field is dropped from the real struct", () => {
    // A hand-mutated copy of the real SslEnforcementResponse with `database`
    // dropped from the nested `currentConfig` struct.
    const mutatedSource = `
type SslEnforcementResponse struct {
	AppliedSuccessfully bool \`json:"appliedSuccessfully"\`
	CurrentConfig       struct {
	} \`json:"currentConfig"\`
}
`;
    const parsed = parseGoStruct(mutatedSource, "SslEnforcementResponse");
    const mismatches = compareLegacyGoTypeToParsedGoType(
      LEGACY_GO_SSL_ENFORCEMENT_RESPONSE,
      parsed,
    );
    expect(mismatches).not.toEqual([]);
    expect(mismatches).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("database") }),
    );
  });

  it("has teeth: reports a mismatch when a field's pointer-ness flips", () => {
    // A hand-mutated copy of the real BranchResponse with `GitBranch` changed
    // from `*string` to `string` (no longer a pointer).
    const mutatedSource = `
type BranchResponse struct {
	CreatedAt           time.Time          \`json:"created_at"\`
	DeletionScheduledAt *time.Time         \`json:"deletion_scheduled_at,omitempty"\`
	GitBranch           string             \`json:"git_branch,omitempty"\`
	Id                  openapi_types.UUID \`json:"id"\`
	IsDefault           bool               \`json:"is_default"\`
	LatestCheckRunId     *float32                            \`json:"latest_check_run_id,omitempty"\`
	Name                 string                              \`json:"name"\`
	NotifyUrl            *string                             \`json:"notify_url,omitempty"\`
	ParentProjectRef     string                              \`json:"parent_project_ref"\`
	Persistent           bool                                \`json:"persistent"\`
	PrNumber             *int32                              \`json:"pr_number,omitempty"\`
	PreviewProjectStatus *string                             \`json:"preview_project_status,omitempty"\`
	ProjectRef           string                              \`json:"project_ref"\`
	ReviewRequestedAt    *time.Time                          \`json:"review_requested_at,omitempty"\`
	Status    string    \`json:"status"\`
	UpdatedAt time.Time \`json:"updated_at"\`
	WithData  bool      \`json:"with_data"\`
}
`;
    const parsed = parseGoStruct(mutatedSource, "BranchResponse");
    const mismatches = compareLegacyGoTypeToParsedGoType(LEGACY_GO_BRANCH_RESPONSE, parsed);
    expect(mismatches).toContainEqual(
      expect.objectContaining({
        path: "$.git_branch",
        message: expect.stringContaining("pointer-ness mismatch"),
      }),
    );
  });
});
