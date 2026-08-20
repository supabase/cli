import type { Effect, Scope } from "effect";
import { Context } from "effect";
import type { SchemaEngineError } from "./schema-errors.ts";
import type { SchemaShadow } from "./schema-shadow.ts";

interface IsolatedShadowProvisionerShape {
  /** Declaration-prep shadow: platform baseline with pgjwt/pgcrypto/uuid-ossp dropped. */
  readonly provision: Effect.Effect<SchemaShadow, SchemaEngineError, Scope.Scope>;
  /** Platform baseline with no project migrations and no declaration-prep drops. */
  readonly provisionPlatform: Effect.Effect<SchemaShadow, SchemaEngineError, Scope.Scope>;
  /** Platform-baselined Docker shadow with local migration files applied. */
  readonly provisionMigrations: Effect.Effect<SchemaShadow, SchemaEngineError, Scope.Scope>;
}

export class IsolatedShadowProvisioner extends Context.Service<
  IsolatedShadowProvisioner,
  IsolatedShadowProvisionerShape
>()("supabase/schema/IsolatedShadowProvisioner") {}
