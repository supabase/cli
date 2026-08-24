// Resolved by bundlers targeting `browser` for the `@supabase/config/io`
// subpath. There is no browser-safe file-IO implementation — browser
// consumers must use the pure `@supabase/config` entrypoint instead.
function unavailableInBrowser(): never {
  throw new Error(
    '@supabase/config/io is not available in browser bundles; import the pure surface from "@supabase/config" instead.',
  );
}

unavailableInBrowser();
