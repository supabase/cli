/**
 * Pure renderer for the Go `text/template` sources transcribed under
 * `../templates/`. Mirrors `apps/cli-go/internal/start/start.go`'s use of
 * `text/template`: every placeholder is a bare `{{ .FieldName }}` reference
 * (no pipelines, functions, or control structures), and every one of the
 * three templates rendered here is executed with `Option("missingkey=error")`
 * (verified via `grep -n '\.Execute(' apps/cli-go/internal/start/start.go`,
 * lines 399, 489, 1203) — so a placeholder with no matching field always
 * throws, never silently renders Go's `<no value>`.
 *
 * `custom_nginx.template` is deliberately NOT rendered here: it is not a Go
 * `text/template` at all (see the comment on
 * `LEGACY_START_CUSTOM_NGINX_TEMPLATE`) and is injected byte-for-byte, with
 * its `${{VAR}}` placeholders substituted by Kong itself at container boot.
 * Callers needing that file should import `LEGACY_START_CUSTOM_NGINX_TEMPLATE`
 * directly from `../templates/custom_nginx.template.ts`.
 */
import { LEGACY_START_KONG_YML_TEMPLATE } from "../templates/kong.yml.ts";
import { LEGACY_START_POOLER_EXS_TEMPLATE } from "../templates/pooler.exs.ts";
import { LEGACY_START_VECTOR_YAML_TEMPLATE } from "../templates/vector.yaml.ts";

const GO_TEMPLATE_FIELD_PATTERN = /\{\{\s*\.(\w+)\s*\}\}/g;

/**
 * Substitutes every `{{ .FieldName }}` occurrence in `template` with the
 * matching value from `fields`, replicating Go's `text/template` rendered
 * with `Option("missingkey=error")`: a placeholder referencing a field not
 * present in `fields` throws instead of rendering `<no value>`.
 */
export function legacyRenderGoTemplate(
  template: string,
  fields: Readonly<Record<string, string | number>>,
): string {
  return template.replace(GO_TEMPLATE_FIELD_PATTERN, (_match, fieldName: string) => {
    if (!Object.hasOwn(fields, fieldName)) {
      throw new Error(
        `legacyRenderGoTemplate: template references undefined field ".${fieldName}" (missingkey=error)`,
      );
    }
    return String(fields[fieldName]);
  });
}

export interface LegacyStartKongYmlFields {
  readonly gotrueId: string;
  readonly restId: string;
  readonly realtimeId: string;
  readonly storageId: string;
  readonly studioId: string;
  readonly pgmetaId: string;
  readonly edgeRuntimeId: string;
  readonly logflareId: string;
  readonly poolerId: string;
  readonly apiHost: string;
  readonly apiPort: number;
  readonly bearerToken: string;
  readonly queryToken: string;
}

/** Renders `kong.yml` from Go's `kongConfig` struct (`start.go:90-104`). */
export function legacyRenderStartKongYml(fields: LegacyStartKongYmlFields): string {
  return legacyRenderGoTemplate(LEGACY_START_KONG_YML_TEMPLATE, {
    GotrueId: fields.gotrueId,
    RestId: fields.restId,
    RealtimeId: fields.realtimeId,
    StorageId: fields.storageId,
    StudioId: fields.studioId,
    PgmetaId: fields.pgmetaId,
    EdgeRuntimeId: fields.edgeRuntimeId,
    LogflareId: fields.logflareId,
    PoolerId: fields.poolerId,
    ApiHost: fields.apiHost,
    ApiPort: fields.apiPort,
    BearerToken: fields.bearerToken,
    QueryToken: fields.queryToken,
  });
}

export interface LegacyStartVectorYamlFields {
  readonly apiKey: string;
  readonly vectorId: string;
  readonly logflareId: string;
  readonly kongId: string;
  readonly gotrueId: string;
  readonly restId: string;
  readonly realtimeId: string;
  readonly storageId: string;
  readonly edgeRuntimeId: string;
  readonly dbId: string;
}

/** Renders `vector.yaml` from Go's `vectorConfig` struct (`start.go:118-129`). */
export function legacyRenderStartVectorYaml(fields: LegacyStartVectorYamlFields): string {
  return legacyRenderGoTemplate(LEGACY_START_VECTOR_YAML_TEMPLATE, {
    ApiKey: fields.apiKey,
    VectorId: fields.vectorId,
    LogflareId: fields.logflareId,
    KongId: fields.kongId,
    GotrueId: fields.gotrueId,
    RestId: fields.restId,
    RealtimeId: fields.realtimeId,
    StorageId: fields.storageId,
    EdgeRuntimeId: fields.edgeRuntimeId,
    DbId: fields.dbId,
  });
}

export interface LegacyStartPoolerExsFields {
  readonly dbHost: string;
  readonly dbPort: number;
  readonly dbDatabase: string;
  readonly dbPassword: string;
  readonly externalId: string;
  readonly modeType: string;
  readonly defaultMaxClients: number;
  readonly defaultPoolSize: number;
}

/** Renders `pooler.exs` from Go's `poolerTenant` struct (`start.go:144-153`). */
export function legacyRenderStartPoolerExs(fields: LegacyStartPoolerExsFields): string {
  return legacyRenderGoTemplate(LEGACY_START_POOLER_EXS_TEMPLATE, {
    DbHost: fields.dbHost,
    DbPort: fields.dbPort,
    DbDatabase: fields.dbDatabase,
    DbPassword: fields.dbPassword,
    ExternalId: fields.externalId,
    ModeType: fields.modeType,
    DefaultMaxClients: fields.defaultMaxClients,
    DefaultPoolSize: fields.defaultPoolSize,
  });
}
