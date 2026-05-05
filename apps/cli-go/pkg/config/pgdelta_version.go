package config

import "strings"

// DefaultPgDeltaNpmVersion is the npm dist-tag/version used for @supabase/pg-delta
// when supabase/.temp/pgdelta-version is absent or empty.
const DefaultPgDeltaNpmVersion = "1.0.0-alpha.22"

const pgDeltaNpmVersionPlaceholder = "1.0.0-alpha.20"

// EffectivePgDeltaNpmVersion returns the pg-delta npm version from loaded config,
// or DefaultPgDeltaNpmVersion when unset (e.g. before Load or empty field).
func EffectivePgDeltaNpmVersion(c Config) string {
	if c == nil {
		return DefaultPgDeltaNpmVersion
	}
	if c.Experimental.PgDelta != nil {
		if v := strings.TrimSpace(c.Experimental.PgDelta.NpmVersion); v != "" {
			return v
		}
	}
	return DefaultPgDeltaNpmVersion
}

// InterpolatePgDeltaScript substitutes pg delta npm version placeholders in embedded TS.
func InterpolatePgDeltaScript(c Config, script string) string {
	return strings.ReplaceAll(script, pgDeltaNpmVersionPlaceholder, EffectivePgDeltaNpmVersion(c))
}
