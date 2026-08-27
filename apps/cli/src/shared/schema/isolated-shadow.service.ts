import type { Effect, Scope } from "effect";
import { Context } from "effect";
import type { SchemaEngineError } from "./schema-errors.ts";
import type { SchemaShadow } from "./schema-shadow.ts";

interface IsolatedShadowProvisionerShape {
  /** Platform baseline with webhooks disabled; image extensions stay installed. */
  readonly provision: Effect.Effect<SchemaShadow, SchemaEngineError, Scope.Scope>;
  /** Platform baseline with no project migrations; webhooks follow config. */
  readonly provisionPlatform: Effect.Effect<SchemaShadow, SchemaEngineError, Scope.Scope>;
  /** Platform-baselined Docker shadow with local migration files applied. */
  readonly provisionMigrations: Effect.Effect<SchemaShadow, SchemaEngineError, Scope.Scope>;
}

export class IsolatedShadowProvisioner extends Context.Service<
  IsolatedShadowProvisioner,
  IsolatedShadowProvisionerShape
>()("supabase/schema/IsolatedShadowProvisioner") {}
