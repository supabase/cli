package vault

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/pkg/config"
)

func TestResolvedSecretNames(t *testing.T) {
	t.Run("returns sorted resolved names", func(t *testing.T) {
		names := ResolvedSecretNames(map[string]config.Secret{
			"beta": {SHA256: "hash-beta"},
			"alpha": {SHA256: "hash-alpha"},
			"empty": {},
		})
		assert.Equal(t, []string{"alpha", "beta"}, names)
	})

	t.Run("returns nil when no secrets resolve", func(t *testing.T) {
		assert.Nil(t, ResolvedSecretNames(nil))
		assert.Nil(t, ResolvedSecretNames(map[string]config.Secret{
			"env_only": {Value: "env(MISSING)"},
		}))
	})
}
