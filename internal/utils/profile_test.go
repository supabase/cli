package utils

import (
	"context"
	"embed"
	"os"
	"testing"

	"github.com/go-playground/validator/v10"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/stretchr/testify/assert"
)

//go:embed testdata/*.json
var testdata embed.FS

func TestLoadProfile(t *testing.T) {
	validate := validator.New(validator.WithRequiredStructEnabled())
	for _, p := range allProfiles {
		t.Run("loads profile "+p.Name, func(t *testing.T) {
			viper.Set("PROFILE", p.Name)
			t.Cleanup(viper.Reset)
			// Setup in-memory fs
			fsys := afero.NewMemMapFs()
			// Run test
			err := LoadProfile(context.Background(), fsys)
			// Check error
			assert.NoError(t, err)
			assert.NoError(t, validate.Struct(&CurrentProfile))
		})
	}

	t.Run("loads from json", func(t *testing.T) {
		viper.Set("PROFILE", "testdata/profile.json")
		t.Cleanup(viper.Reset)
		// Setup in-memory fs
		fsys := afero.FromIOFS{FS: testdata}
		// Run test
		err := LoadProfile(context.Background(), fsys)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("throws error on invalid profile", func(t *testing.T) {
		viper.Set("PROFILE", "testdata/invalid.json")
		t.Cleanup(viper.Reset)
		// Setup in-memory fs
		fsys := afero.FromIOFS{FS: testdata}
		// Run test
		err := LoadProfile(context.Background(), fsys)
		// Check error
		assert.ErrorContains(t, err, "Field validation for 'APIURL' failed on the 'http_url' tag")
		assert.ErrorContains(t, err, "Field validation for 'ProjectHost' failed on the 'hostname_rfc1123' tag")
	})

	t.Run("throws error on malformed profile", func(t *testing.T) {
		viper.Set("PROFILE", "testdata/malformed.json")
		t.Cleanup(viper.Reset)
		// Setup in-memory fs
		fsys := afero.FromIOFS{FS: testdata}
		// Run test
		err := LoadProfile(context.Background(), fsys)
		// Check error
		assert.ErrorContains(t, err, "invalid keys: test_url")
	})

	t.Run("throws error on missing profile", func(t *testing.T) {
		viper.Set("PROFILE", "testdata/missing.json")
		t.Cleanup(viper.Reset)
		// Setup in-memory fs
		fsys := afero.FromIOFS{FS: testdata}
		// Run test
		err := LoadProfile(context.Background(), fsys)
		// Check error
		assert.ErrorIs(t, err, os.ErrNotExist)
	})
}
