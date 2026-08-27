import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  classifyPrivilegePlan,
  classifyPrivilegeSql,
  emptyPendingMigrationError,
  isPublicDefaultAclStatement,
  isPublicObjectAclStatement,
  migrationHasExecutableSql,
  pendingHasPrivilegeSql,
  privilegeOfferError,
  REVOKE_API_PRIVILEGES_SQL,
} from "./privilege-offer.ts";

const PLATFORM_VS_STAGING_SQL = `
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON SEQUENCES FROM "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON SEQUENCES FROM "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON SEQUENCES FROM "service_role";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON TABLES FROM "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON TABLES FROM "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON TABLES FROM "service_role";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT SELECT, UPDATE, USAGE ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT SELECT, UPDATE, USAGE ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT SELECT, UPDATE, USAGE ON SEQUENCES TO "service_role";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT EXECUTE ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT EXECUTE ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT EXECUTE ON FUNCTIONS TO "service_role";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLES TO "service_role";
`;

describe("isPublicDefaultAclStatement", () => {
  it("accepts postgres/public grants and revokes to Data API roles", () => {
    expect(
      isPublicDefaultAclStatement(
        'ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON TABLES FROM "anon"',
      ),
    ).toBe(true);
    expect(
      isPublicDefaultAclStatement(
        "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON TABLES TO authenticated, service_role",
      ),
    ).toBe(true);
  });

  it("rejects other roles, schemas, or DDL", () => {
    expect(
      isPublicDefaultAclStatement(
        'ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "auth" GRANT SELECT ON TABLES TO "anon"',
      ),
    ).toBe(false);
    expect(
      isPublicDefaultAclStatement(
        'ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT SELECT ON TABLES TO "anon"',
      ),
    ).toBe(false);
    expect(
      isPublicDefaultAclStatement(
        'ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT SELECT ON TABLES TO "PUBLIC"',
      ),
    ).toBe(false);
    expect(isPublicDefaultAclStatement("CREATE TABLE public.t (id int)")).toBe(false);
  });
});

describe("isPublicObjectAclStatement", () => {
  it("accepts public function grants to Data API roles", () => {
    expect(
      isPublicObjectAclStatement(
        "GRANT EXECUTE ON FUNCTION public.accept_invitation() TO service_role",
      ),
    ).toBe(true);
    expect(
      isPublicObjectAclStatement(
        "REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated, service_role",
      ),
    ).toBe(true);
  });

  it("rejects other schemas or roles", () => {
    expect(isPublicObjectAclStatement("GRANT EXECUTE ON FUNCTION auth.uid() TO service_role")).toBe(
      false,
    );
    expect(isPublicObjectAclStatement("GRANT EXECUTE ON FUNCTION public.foo() TO postgres")).toBe(
      false,
    );
  });
});

describe("classifyPrivilegeSql", () => {
  it.live("treats the hosted vs isolated dump as grant_present", () =>
    Effect.gen(function* () {
      expect(yield* classifyPrivilegeSql(PLATFORM_VS_STAGING_SQL)).toBe("grant_present");
      expect(
        yield* classifyPrivilegePlan({
          files: [{ sql: PLATFORM_VS_STAGING_SQL }],
        }),
      ).toBe("grant_present");
    }),
  );

  it.live("treats the turn-off revoke SQL as revoke_only", () =>
    Effect.gen(function* () {
      expect(yield* classifyPrivilegeSql(REVOKE_API_PRIVILEGES_SQL)).toBe("revoke_only");
    }),
  );

  it.live("treats leftover function grants as grant_present", () =>
    Effect.gen(function* () {
      expect(
        yield* classifyPrivilegeSql(
          "GRANT EXECUTE ON FUNCTION public.accept_invitation() TO service_role;",
        ),
      ).toBe("grant_present");
    }),
  );

  it.live("rejects empty or mixed DDL", () =>
    Effect.gen(function* () {
      expect(yield* classifyPrivilegeSql("")).toBe("not_acl");
      expect(
        yield* classifyPrivilegeSql(`${PLATFORM_VS_STAGING_SQL}\nCREATE TABLE t (id int);`),
      ).toBe("not_acl");
    }),
  );
});

describe("migrationHasExecutableSql", () => {
  it("treats whitespace and comments as empty", () => {
    expect(migrationHasExecutableSql("")).toBe(false);
    expect(migrationHasExecutableSql("-- empty stub\n")).toBe(false);
    expect(migrationHasExecutableSql("select 1;")).toBe(true);
    expect(
      emptyPendingMigrationError([{ fileName: "20260101000000_sneak.sql", content: "" }])?._tag,
    ).toBe("SchemaEmptyMigrationStatementsError");
    expect(
      emptyPendingMigrationError([{ fileName: "ok.sql", content: "select 1;" }]),
    ).toBeUndefined();
  });
});

describe("pendingHasPrivilegeSql", () => {
  it.live("detects a pending revoke file, including a comment header", () =>
    Effect.gen(function* () {
      expect(yield* pendingHasPrivilegeSql([{ content: "select 1;" }])).toBe(false);
      expect(yield* pendingHasPrivilegeSql([{ content: REVOKE_API_PRIVILEGES_SQL }])).toBe(true);
      expect(
        yield* pendingHasPrivilegeSql([
          { content: `-- write revoke SQL\n${REVOKE_API_PRIVILEGES_SQL}` },
        ]),
      ).toBe(true);
      expect(yield* pendingHasPrivilegeSql([{ content: "-- empty stub\n" }])).toBe(false);
    }),
  );
});

describe("privilegeOfferError", () => {
  it("keeps a URL next action on the selected database", () => {
    const error = privilegeOfferError("ALTER DEFAULT PRIVILEGES", { dbUrlSame: true });
    expect(error.suggestion).toContain(
      "supabase migrations push --db-url <same-url> --allow-remote",
    );
    expect(error.suggestion).not.toContain("then supabase migrations push\n");
  });

  it("recommends turn-off first and keep-on as refresh declarations", () => {
    const error = privilegeOfferError("ALTER DEFAULT PRIVILEGES");
    expect(error.suggestion.indexOf("Turn off:")).toBeLessThan(
      error.suggestion.indexOf("Keep on:"),
    );
    expect(error.suggestion).toContain(
      "migrations new revoke_api_privileges --template revoke-api-privileges",
    );
    expect(error.suggestion).not.toContain("write the revoke SQL");
    expect(error.suggestion).not.toContain("revoke execute on functions");
    expect(error.suggestion).toContain("db reset");
    expect(error.suggestion).toContain("schema pull --force");
    expect(error.suggestion).toContain("deprecated");
    expect(error.suggestion).toContain("Do not write GRANT ALL");
    expect(error.suggestion).not.toContain("schema generate --name");
  });
});
