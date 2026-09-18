package config

import (
	"testing"

	"github.com/oapi-codegen/nullable"
	"github.com/stretchr/testify/assert"
	v1API "github.com/supabase/cli/pkg/api"
)

// TargetMigration carries `toml:"-" json:"-"`, so DiffWithRemote cannot observe
// it: the clone it compares is serialized to TOML. These assert the mapping
// directly instead.
func TestStorageMigrationVersionMapping(t *testing.T) {
	t.Run("adopts the remote migration version when the platform reports one", func(t *testing.T) {
		s := storage{TargetMigration: "local-metadata"}
		s.FromRemoteStorageConfig(v1API.StorageConfigResponseOutput{
			MigrationVersion: nullable.NewNullableWithValue("remote-metadata"),
		})
		assert.Equal(t, "remote-metadata", s.TargetMigration)
	})

	t.Run("keeps the local migration version when the platform reports null", func(t *testing.T) {
		s := storage{TargetMigration: "local-metadata"}
		s.FromRemoteStorageConfig(v1API.StorageConfigResponseOutput{
			MigrationVersion: nullable.NewNullNullable[string](),
		})
		assert.Equal(t, "local-metadata", s.TargetMigration)
	})

	t.Run("keeps the local migration version when the platform omits the field", func(t *testing.T) {
		s := storage{TargetMigration: "local-metadata"}
		s.FromRemoteStorageConfig(v1API.StorageConfigResponseOutput{})
		assert.Equal(t, "local-metadata", s.TargetMigration)
	})
}
