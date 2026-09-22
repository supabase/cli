/**
 * Stand-in for the `oxfmt` package `@supabase/postgrest-typegen` imports.
 * `gen types` passes its own formatter and never calls this.
 */
export function format(): never {
  throw new Error("oxfmt is not bundled in the Supabase CLI");
}
