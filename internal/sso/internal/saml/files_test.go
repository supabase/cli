package saml

import (
	"context"
	"os"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
)

func TestReadAttributeMappingFile(t *testing.T) {
	t.Run("open file that does not exist", func(t *testing.T) {
		_, err := ReadAttributeMappingFile(afero.NewMemMapFs(), "/does-not-exist")
		if !os.IsNotExist(err) {
			t.Fatalf("unexpected error %v", err)
		}
	})

	t.Run("open file that is not valid JSON", func(t *testing.T) {
		fs := afero.NewMemMapFs()
		assert.NoError(t, afero.WriteFile(fs, "/not-valid-json", []byte("not-valid-JSON"), 0755))

		_, err := ReadAttributeMappingFile(fs, "/not-valid-json")
		if err == nil {
			t.Fatalf("expected error")
		}
	})

	t.Run("open valid file", func(t *testing.T) {
		fs := afero.NewMemMapFs()
		assert.NoError(t, afero.WriteFile(fs, "/valid-json", []byte(`{"keys":{"abc":{"names":["x","y","z"],"default":2,"name":"k"}}}`), 0755))

		_, err := ReadAttributeMappingFile(fs, "/valid-json")
		if err != nil {
			t.Fatalf("unexpected error %v", err)
		}
	})
}

func TestValidateMetadata(t *testing.T) {
	t.Run("with invalid UTF-8", func(t *testing.T) {
		err := ValidateMetadata([]byte{0xFF, 0xFF, 0xFF}, "/invalid-utf-8")
		if err == nil || err.Error() != "SAML Metadata XML at \"/invalid-utf-8\" is not UTF-8 encoded" {
			t.Fatalf("unexpected error %v", err)
		}
	})
}

func TestValidateMetadataURL(t *testing.T) {
	t.Run("with relative URL", func(t *testing.T) {
		err := ValidateMetadataURL(context.TODO(), "./relative-url")
		if err == nil || err.Error() != "parse \"./relative-url\": invalid URI for request" {
			t.Fatalf("unexpected error %v", err)
		}
	})

	t.Run("with HTTP URL", func(t *testing.T) {
		err := ValidateMetadataURL(context.TODO(), "http://example.com")
		if err == nil || err.Error() != "Only HTTPS Metadata URLs are supported." {
			t.Fatalf("unexpected error %v", err)
		}
	})

	t.Run("with HTTP URL", func(t *testing.T) {
		err := ValidateMetadataURL(context.TODO(), "http://example.com")
		if err == nil || err.Error() != "Only HTTPS Metadata URLs are supported." {
			t.Fatalf("unexpected error %v", err)
		}
	})
}
