package saml

import (
	"context"
	"os"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/cast"
)

func TestReadAttributeMappingFile(t *testing.T) {
	t.Run("open file that does not exist", func(t *testing.T) {
		err := ReadAttributeMappingFile(afero.NewMemMapFs(), "/does-not-exist", nil)
		assert.ErrorIs(t, err, os.ErrNotExist)
	})

	t.Run("open file that is not valid JSON", func(t *testing.T) {
		fs := afero.NewMemMapFs()
		require.NoError(t, afero.WriteFile(fs, "/not-valid-json", []byte("not-valid-JSON"), 0755))
		var body api.CreateProviderBody
		err := ReadAttributeMappingFile(fs, "/not-valid-json", body.AttributeMapping)
		assert.ErrorContains(t, err, "failed to parse attribute mapping")
	})

	t.Run("open valid file", func(t *testing.T) {
		fs := afero.NewMemMapFs()
		data := `{"keys":{"abc":{"names":["x","y","z"],"default":2,"name":"k"}}}`
		require.NoError(t, afero.WriteFile(fs, "/valid-json", []byte(data), 0755))
		body := api.CreateProviderBody{
			AttributeMapping: &struct {
				Keys map[string]struct {
					Array   *bool        "json:\"array,omitempty\""
					Default *interface{} "json:\"default,omitempty\""
					Name    *string      "json:\"name,omitempty\""
					Names   *[]string    "json:\"names,omitempty\""
				} "json:\"keys\""
			}{},
		}
		err := ReadAttributeMappingFile(fs, "/valid-json", body.AttributeMapping)
		assert.NoError(t, err)
		assert.Len(t, body.AttributeMapping.Keys, 1)
		value := body.AttributeMapping.Keys["abc"]
		assert.Equal(t, cast.Ptr("k"), value.Name)
		assert.Equal(t, &[]string{"x", "y", "z"}, value.Names)
		assert.NotNil(t, value.Default)
		assert.Equal(t, float64(2), *value.Default)
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
