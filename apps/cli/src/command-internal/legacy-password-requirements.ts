/**
 * `auth.password_requirements` ↔ Management API `password_required_characters`.
 *
 * Values are the real API literals — the `:`-separated character classes are
 * significant, and the generated client rejects any value that is not one of
 * these strings. Shared by `config push` (auth update body) and the local
 * GoTrue service environment (`GOTRUE_PASSWORD_REQUIRED_CHARACTERS`), so the
 * two can never drift apart.
 */
export const LEGACY_PASSWORD_REQUIREMENTS_TO_CHAR: Readonly<Record<string, string>> = {
  letters_digits: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789",
  lower_upper_letters_digits: "abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789",
  lower_upper_letters_digits_symbols:
    "abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789:!@#$%^&*()_+-=[]{};'\\\\:\"|<>?,./`~",
};

/**
 * Maps a config `password_requirements` value to the API's character-class
 * literal. Unknown or empty input (no requirement) maps to `""`.
 */
export function legacyPasswordRequirementsToChar(value: string): string {
  return LEGACY_PASSWORD_REQUIREMENTS_TO_CHAR[value] ?? "";
}
