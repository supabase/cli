/**
 * Pure JSON Schema post-processing used by `build.ts`'s `renderJsonSchema` on
 * both generated artifacts (`dist/schema.json`, `dist/project-schema.json`).
 */

/**
 * Injects `$id`/`title`/`description` right after `$schema`, ahead of the
 * document's own keys. `metadata` is authoritative: any `$id`/`title`/
 * `description` already on `document` is discarded rather than allowed to win
 * via the trailing `...rest` spread.
 */
export function withSchemaMetadata(
  document: Record<string, unknown>,
  metadata: { readonly id: string; readonly title: string; readonly description: string },
): Record<string, unknown> {
  const { $schema, $id: _id, title: _title, description: _description, ...rest } = document;
  return {
    $schema,
    $id: metadata.id,
    title: metadata.title,
    description: metadata.description,
    ...rest,
  };
}
