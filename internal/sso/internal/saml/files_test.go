package saml

import (
	"context"
	"os"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestReadAttributeMappingFile(t *testing.T) {
	t.Run("open file that does not exist", func(t *testing.T) {
		_, err := ReadAttributeMappingFile(afero.NewMemMapFs(), "/does-not-exist")
		assert.ErrorIs(t, err, os.ErrNotExist)
	})

	t.Run("open file that is not valid JSON", func(t *testing.T) {
		fs := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fs, "/not-valid-json", []byte("not-valid-JSON"), 0755))

		_, err := ReadAttributeMappingFile(fs, "/not-valid-json")
		assert.ErrorContains(t, err, "failed to parse attribute mapping")
	})

	t.Run("open valid file", func(t *testing.T) {
		fs := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fs, "/valid-json", []byte(`{"keys":{"abc":{"names":["x","y","z"],"default":2,"name":"k"}}}`), 0755))

		_, err := ReadAttributeMappingFile(fs, "/valid-json")
		assert.NoError(t, err)
	})
}

func TestValidateMetadata(t *testing.T) {
	t.Run("with invalid UTF-8", func(t *testing.T) {
		err := ValidateMetadata([]byte{0xFF, 0xFF, 0xFF}, "/invalid-utf-8")
		assert.ErrorContains(t, err, `SAML Metadata XML at "/invalid-utf-8" is not UTF-8 encoded`)
	})
}

func TestValidateMetadataURL(t *testing.T) {
	t.Run("with relative URL", func(t *testing.T) {
		err := ValidateMetadataURL(context.TODO(), "./relative-url")
		assert.ErrorContains(t, err, "invalid URI for request")
	})

	t.Run("with HTTP URL", func(t *testing.T) {
		err := ValidateMetadataURL(context.TODO(), "http://example.com")
		assert.ErrorContains(t, err, "only HTTPS Metadata URLs are supported")
	})
}
