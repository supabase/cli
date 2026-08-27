import { Schema } from "effect";
/**
 * `[workers]` — one `[workers.<name>]` table per worker, mirroring the
 * `[functions.<slug>]` convention in the same file.
 *
 * Workers live at `supabase/workers/<name>/`; one whose code lives somewhere
 * else entirely uses its own `source`, which is anchored to the project root and
 * so can leave `supabase/`.
 */
export declare const workers: Schema.withDecodingDefault<Schema.$Record<Schema.String, Schema.Struct<{
    readonly runtime: Schema.optionalKey<Schema.String>;
    readonly size: Schema.optionalKey<Schema.String>;
    readonly instances: Schema.optionalKey<Schema.Number>;
    readonly source: Schema.optionalKey<Schema.String>;
}>>, never>;
