import type { Effect, Scope } from "effect";
import { Context } from "effect";
import type { SchemaEngineError } from "./schema-errors.ts";
import type { SchemaShadow } from "./schema-shadow.ts";

interface IsolatedShadowProvisionerShape {
  readonly provision: Effect.Effect<SchemaShadow, SchemaEngineError, Scope.Scope>;
}

export class IsolatedShadowProvisioner extends Context.Service<
  IsolatedShadowProvisioner,
  IsolatedShadowProvisionerShape
>()("supabase/schema/IsolatedShadowProvisioner") {}
