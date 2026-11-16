declare const Brand: unique symbol;

/** Proof that the user approved a hosted mutation; only the consent module constructs one. */
export interface HostedMutationConsent {
  readonly [Brand]: true;
  readonly action: string;
  readonly via: "prompt" | "yes";
}
