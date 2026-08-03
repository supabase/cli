import { Data } from "effect";

// Shared across show / update / remove: Go's `uuid.Parse` failure.
// Message intentionally diverges from Go's verbose `failed to parse provider ID: invalid UUID …`
// — the legacy/sso port consolidates to a single short string `identity provider ID %q is not a UUID`
// that's directly user-actionable and tested in e2e.
export class LegacySsoInvalidUuidError extends Data.TaggedError("LegacySsoInvalidUuidError")<{
  readonly providerId: string;
  readonly message: string;
}> {}

// Shared across list / show: mirrors Go's `utils.EncodeOutput` TOML failure
// ("failed to output toml: %w") — reachable when an `attribute_mapping`
// `default` value cannot be encoded by BurntSushi (e.g. an array with a nil
// element).
export class LegacySsoTomlEncodeError extends Data.TaggedError("LegacySsoTomlEncodeError")<{
  readonly message: string;
}> {}

// `sso list`
export class LegacySsoListNetworkError extends Data.TaggedError("LegacySsoListNetworkError")<{
  readonly message: string;
}> {}

export class LegacySsoListSamlDisabledError extends Data.TaggedError(
  "LegacySsoListSamlDisabledError",
)<{
  readonly message: string;
}> {}

export class LegacySsoListUnexpectedStatusError extends Data.TaggedError(
  "LegacySsoListUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

// `sso add`
export class LegacySsoAddNetworkError extends Data.TaggedError("LegacySsoAddNetworkError")<{
  readonly message: string;
}> {}

export class LegacySsoAddSamlDisabledError extends Data.TaggedError(
  "LegacySsoAddSamlDisabledError",
)<{
  readonly message: string;
}> {}

export class LegacySsoAddUnexpectedStatusError extends Data.TaggedError(
  "LegacySsoAddUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

export class LegacySsoAddMetadataFileError extends Data.TaggedError(
  "LegacySsoAddMetadataFileError",
)<{
  readonly message: string;
}> {}

export class LegacySsoAddAttributeMappingFileError extends Data.TaggedError(
  "LegacySsoAddAttributeMappingFileError",
)<{
  readonly message: string;
}> {}

export class LegacySsoMutexFlagError extends Data.TaggedError("LegacySsoMutexFlagError")<{
  readonly message: string;
}> {}

// pflag's `ValueRequiredError` (`errors.go:63-78`), emulated for the case the
// Effect parser accepts but pflag rejects: a bare value-taking flag as the
// final argv token (`sso update <id> --domains`). pflag fails `ParseFlags`
// (cobra `command.go:919`) before `ValidateArgs`, every hook, and `RunE`, so
// Go exits without any API call. Shared across add + update; message
// byte-matches pflag's template.
export class LegacySsoFlagNeedsArgumentError extends Data.TaggedError(
  "LegacySsoFlagNeedsArgumentError",
)<{
  readonly message: string;
}> {}

// pflag's `InvalidValueError` (`errors.go:32-48`, raised when a flag's
// `Value.Set` rejects an occurrence), emulated for values the Effect parser
// accepts but pflag does not: a repeated flag whose later occurrence is
// invalid (the Effect parser resolves repeats first-wins and never validates
// the rest — `--type saml --type bogus`), and boolean literals outside Go's
// `strconv.ParseBool` set (`--skip-url-validation=yes`). pflag fails
// `ParseFlags` (cobra `command.go:919`) before `ValidateArgs`, every hook,
// and `RunE`, so Go exits without any API call. Shared across add + update;
// message byte-matches pflag's template.
export class LegacySsoInvalidFlagValueError extends Data.TaggedError(
  "LegacySsoInvalidFlagValueError",
)<{
  readonly message: string;
}> {}

// cobra's `ValidateRequiredFlags` (`command.go:1007`), emulated for the case
// the Effect parser cannot see: pflag consumed the required flag's own token
// as another flag's value, so pflag never marks it `Changed` and Go exits
// before `RunE` (CLI-1982). Message byte-matches cobra's template.
export class LegacySsoAddRequiredFlagError extends Data.TaggedError(
  "LegacySsoAddRequiredFlagError",
)<{
  readonly message: string;
}> {}

// Shared across add + update — metadata URL validation.
export class LegacySsoMetadataUrlInvalidError extends Data.TaggedError(
  "LegacySsoMetadataUrlInvalidError",
)<{
  readonly message: string;
}> {}

export class LegacySsoMetadataUrlNetworkError extends Data.TaggedError(
  "LegacySsoMetadataUrlNetworkError",
)<{
  readonly message: string;
}> {}

export class LegacySsoMetadataUrlNonUtf8Error extends Data.TaggedError(
  "LegacySsoMetadataUrlNonUtf8Error",
)<{
  readonly message: string;
}> {}

// `sso show`
export class LegacySsoShowNetworkError extends Data.TaggedError("LegacySsoShowNetworkError")<{
  readonly message: string;
}> {}

export class LegacySsoShowNotFoundError extends Data.TaggedError("LegacySsoShowNotFoundError")<{
  readonly message: string;
}> {}

export class LegacySsoShowUnexpectedStatusError extends Data.TaggedError(
  "LegacySsoShowUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

export class LegacySsoShowEnvNotSupportedError extends Data.TaggedError(
  "LegacySsoShowEnvNotSupportedError",
)<{
  readonly message: string;
}> {}

// `sso update`
// cobra's `ValidateArgs` / `ExactArgs(1)` (`command.go:968`, `cmd/sso.go:87`),
// emulated for the case the Effect parser cannot see: pflag consumed a flag
// token as a value, shifting what the parser read as a flag's value into the
// positional list, so Go rejects the arg count before any hook or request
// (CLI-1982). Message byte-matches cobra's `ExactArgs` template.
export class LegacySsoUpdateArityError extends Data.TaggedError("LegacySsoUpdateArityError")<{
  readonly message: string;
}> {}

export class LegacySsoUpdateNetworkError extends Data.TaggedError("LegacySsoUpdateNetworkError")<{
  readonly message: string;
}> {}

export class LegacySsoUpdateNotFoundError extends Data.TaggedError("LegacySsoUpdateNotFoundError")<{
  readonly message: string;
}> {}

export class LegacySsoUpdateUnexpectedStatusError extends Data.TaggedError(
  "LegacySsoUpdateUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

export class LegacySsoUpdateMetadataFileError extends Data.TaggedError(
  "LegacySsoUpdateMetadataFileError",
)<{
  readonly message: string;
}> {}

export class LegacySsoUpdateAttributeMappingFileError extends Data.TaggedError(
  "LegacySsoUpdateAttributeMappingFileError",
)<{
  readonly message: string;
}> {}

// `sso remove`
export class LegacySsoRemoveNetworkError extends Data.TaggedError("LegacySsoRemoveNetworkError")<{
  readonly message: string;
}> {}

export class LegacySsoRemoveNotFoundError extends Data.TaggedError("LegacySsoRemoveNotFoundError")<{
  readonly message: string;
}> {}

export class LegacySsoRemoveUnexpectedStatusError extends Data.TaggedError(
  "LegacySsoRemoveUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

/**
 * Go's `GetSupabase` token gate (`internal/utils/api.go:119-124`):
 * `log.Fatalln(utils.ErrMissingToken)` when the reconciled profile's token
 * lookup finds nothing — fired at first client use inside `RunE`, AFTER
 * required/mutex/workdir validation (PR #5974 review round 10).
 */
export class LegacySsoAccessTokenError extends Data.TaggedError("LegacySsoAccessTokenError")<{
  readonly message: string;
}> {}
