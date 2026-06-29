package cmd

import (
	"path/filepath"
	"testing"

	"github.com/spf13/pflag"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/utils"
)

func TestResolvePullDiffEngine(t *testing.T) {
	t.Run("defaults to pg-delta when enabled in config", func(t *testing.T) {
		assert.True(t, resolvePullDiffEngine(false, "migra", true))
	})

	t.Run("defaults to migra when pg-delta is not active", func(t *testing.T) {
		assert.False(t, resolvePullDiffEngine(false, "migra", false))
	})

	t.Run("explicit --diff-engine migra overrides config default", func(t *testing.T) {
		assert.False(t, resolvePullDiffEngine(true, "migra", true))
	})

	t.Run("explicit --diff-engine pg-delta wins when config disabled", func(t *testing.T) {
		assert.True(t, resolvePullDiffEngine(true, "pg-delta", false))
	})
}

func TestResolveDiffEngine(t *testing.T) {
	t.Run("uses pg-delta when enabled in config and no engine flag set", func(t *testing.T) {
		assert.True(t, resolveDiffEngine(false, false, false, true))
	})

	t.Run("uses migra when pg-delta is not active", func(t *testing.T) {
		assert.False(t, resolveDiffEngine(false, false, false, false))
	})

	t.Run("explicit --use-migra clears config-driven pg-delta", func(t *testing.T) {
		assert.False(t, resolveDiffEngine(true, false, false, true))
	})

	t.Run("explicit --use-pg-schema clears config-driven pg-delta", func(t *testing.T) {
		assert.False(t, resolveDiffEngine(false, false, true, true))
	})

	t.Run("explicit --use-pgadmin clears config-driven pg-delta", func(t *testing.T) {
		assert.False(t, resolveDiffEngine(false, true, false, true))
	})
}

func TestResolveSeedSqlPaths(t *testing.T) {
	t.Run("resolves relative paths against the supabase directory", func(t *testing.T) {
		absoluteSeedPath := filepath.Join(t.TempDir(), "seed.sql")
		got, err := resolveSeedSqlPaths([]string{
			"./seeds/minimal.sql",
			"./seeds/demo/*.sql",
			"./seeds/tenant,one.sql",
			absoluteSeedPath,
		})

		assert.NoError(t, err)
		assert.Equal(t, []string{
			filepath.Join(utils.SupabaseDirPath, "seeds", "minimal.sql"),
			filepath.Join(utils.SupabaseDirPath, "seeds", "demo", "*.sql"),
			filepath.Join(utils.SupabaseDirPath, "seeds", "tenant,one.sql"),
			absoluteSeedPath,
		}, got)
	})

	t.Run("rejects empty paths", func(t *testing.T) {
		got, err := resolveSeedSqlPaths([]string{""})
		assert.Nil(t, got)
		assert.EqualError(t, err, "--sql-paths requires a non-empty path or glob pattern")
	})
}

func TestValidateDbResetSeedFlags(t *testing.T) {
	t.Run("rejects no seed with sql paths", func(t *testing.T) {
		utils.CmdSuggestion = ""
		t.Cleanup(func() { utils.CmdSuggestion = "" })

		err := validateDbResetSeedFlags(true, []string{"./seed.sql"})

		assert.EqualError(t, err, "--no-seed cannot be used with --sql-paths")
		assert.Contains(t, utils.CmdSuggestion, "Use either")
		assert.Contains(t, utils.CmdSuggestion, "--no-seed")
		assert.Contains(t, utils.CmdSuggestion, "--sql-paths")
	})

	t.Run("rejects empty sql paths", func(t *testing.T) {
		utils.CmdSuggestion = ""
		t.Cleanup(func() { utils.CmdSuggestion = "" })

		err := validateDbResetSeedFlags(false, []string{""})

		assert.EqualError(t, err, "--sql-paths requires a non-empty path or glob pattern")
		assert.Contains(t, utils.CmdSuggestion, "non-empty")
		assert.Contains(t, utils.CmdSuggestion, "--sql-paths")
	})
}

func TestApplyDbResetSeedFlags(t *testing.T) {
	oldSeed := utils.Config.Db.Seed
	t.Cleanup(func() { utils.Config.Db.Seed = oldSeed })

	t.Run("leaves config unchanged without seed flags", func(t *testing.T) {
		utils.Config.Db.Seed.Enabled = false
		utils.Config.Db.Seed.SqlPaths = []string{"supabase/original.sql"}

		assert.NoError(t, applyDbResetSeedFlags(false, nil))
		assert.False(t, utils.Config.Db.Seed.Enabled)
		assert.Equal(t, []string{"supabase/original.sql"}, []string(utils.Config.Db.Seed.SqlPaths))
	})

	t.Run("disables seed when no seed is set", func(t *testing.T) {
		utils.Config.Db.Seed.Enabled = true
		utils.Config.Db.Seed.SqlPaths = []string{"supabase/original.sql"}

		assert.NoError(t, applyDbResetSeedFlags(true, nil))
		assert.False(t, utils.Config.Db.Seed.Enabled)
		assert.Equal(t, []string{"supabase/original.sql"}, []string(utils.Config.Db.Seed.SqlPaths))
	})

	t.Run("force enables seed and overrides sql paths", func(t *testing.T) {
		utils.Config.Db.Seed.Enabled = false
		utils.Config.Db.Seed.SqlPaths = []string{"supabase/original.sql"}

		assert.NoError(t, applyDbResetSeedFlags(false, []string{"./seeds/base.sql"}))
		assert.True(t, utils.Config.Db.Seed.Enabled)
		assert.Equal(t, []string{filepath.Join(utils.SupabaseDirPath, "seeds", "base.sql")}, []string(utils.Config.Db.Seed.SqlPaths))
	})
}

func TestSeedSqlPathsFlagPreservesCommas(t *testing.T) {
	var values []string
	flags := pflag.NewFlagSet("test", pflag.ContinueOnError)
	flags.StringArrayVar(&values, "sql-paths", nil, "")

	assert.NoError(t, flags.Parse([]string{
		"--sql-paths",
		"./seeds/tenant,one.sql",
		"--sql-paths",
		"./seeds/two.sql",
	}))
	assert.Equal(t, []string{"./seeds/tenant,one.sql", "./seeds/two.sql"}, values)
}
