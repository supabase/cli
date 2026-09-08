/**
 * Pure renderer for the `text/template`-style sources under `../templates/`:
 * every placeholder is a bare `{{ .FieldName }}` reference (no pipelines,
 * functions, or control structures), and a placeholder with no matching
 * field always throws — it never silently renders as empty.
 *
 * `custom_nginx.template` is deliberately NOT rendered here: it is not one of
 * these templates at all (see the comment on
 * `START_CUSTOM_NGINX_TEMPLATE`) and is injected byte-for-byte, with
 * its `${{VAR}}` placeholders substituted by Kong itself at container boot.
 * Callers needing that file should import `START_CUSTOM_NGINX_TEMPLATE`
 * directly from `../templates/custom_nginx.template.ts`.
 */
import { START_KONG_YML_TEMPLATE } from "../templates/kong.yml.ts";
import { START_POOLER_EXS_TEMPLATE } from "../templates/pooler.exs.ts";
import { START_VECTOR_YAML_TEMPLATE } from "../templates/vector.yaml.ts";

const GO_TEMPLATE_FIELD_PATTERN = /\{\{\s*\.(\w+)\s*\}\}/g;

/**
 * Substitutes every `{{ .FieldName }}` occurrence in `template` with the
 * matching value from `fields`: a placeholder referencing a field not
 * present in `fields` throws instead of silently rendering as empty.
 */
export function renderGoTemplate(
  template: string,
  fields: Readonly<Record<string, string | number>>,
): string {
  return template.replace(GO_TEMPLATE_FIELD_PATTERN, (_match, fieldName: string) => {
    if (!Object.hasOwn(fields, fieldName)) {
      throw new Error(
        `renderGoTemplate: template references undefined field ".${fieldName}" (missingkey=error)`,
      );
    }
    return String(fields[fieldName]);
  });
}

export interface StartKongYmlFields {
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

/** Renders `kong.yml` from {@link StartKongYmlFields}. */
export function renderStartKongYml(fields: StartKongYmlFields): string {
  return renderGoTemplate(START_KONG_YML_TEMPLATE, {
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

export interface StartVectorYamlFields {
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

/** Renders `vector.yaml` from {@link StartVectorYamlFields}. */
export function renderStartVectorYaml(fields: StartVectorYamlFields): string {
  return renderGoTemplate(START_VECTOR_YAML_TEMPLATE, {
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

export interface StartPoolerExsFields {
  readonly dbHost: string;
  readonly dbPort: number;
  readonly dbDatabase: string;
  readonly dbPassword: string;
  readonly externalId: string;
  readonly modeType: string;
  readonly defaultMaxClients: number;
  readonly defaultPoolSize: number;
}

/** Renders `pooler.exs` from {@link StartPoolerExsFields}. */
export function renderStartPoolerExs(fields: StartPoolerExsFields): string {
  return renderGoTemplate(START_POOLER_EXS_TEMPLATE, {
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
