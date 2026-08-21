// Vitest evaluates global setup separately from test modules. Keep the
// `ProvidedContext` augmentation in a side-effect-free module so global setup
// can import it without loading Vitest's test APIs.
export {};

declare module "vitest" {
  export interface ProvidedContext {
    /** Environment selected by the live global setup. */
    liveMode: "attached" | "managed";
    /** Shared project wiring. Empty strings mean the attached harness did not
     * provide a project-scoped value and the corresponding suite should use a
     * project/data-plane gate. */
    projectRef: string;
    anonKey: string;
    functionsUrl: string;
    dbUrl: string;
    dbPassword: string;
    storageBucket: string;
  }
}
