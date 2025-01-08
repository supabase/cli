package storage

import (
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParseFileOptionsContentTypeDetection(t *testing.T) {
	tests := []struct {
		name          string
		content       []byte
		filename      string
		opts          []func(*FileOptions)
		wantMimeType  string
		wantCacheCtrl string
	}{
		{
			name:          "detects PNG image",
			content:       []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A}, // PNG header
			filename:      "test.png",
			wantMimeType:  "image/png",
			wantCacheCtrl: "max-age=3600",
		},
		{
			name:          "detects JavaScript file",
			content:       []byte("const hello = () => console.log('Hello, World!');"),
			filename:      "script.js",
			wantMimeType:  "text/javascript; charset=utf-8",
			wantCacheCtrl: "max-age=3600",
		},
		{
			name:          "detects CSS file",
			content:       []byte(".header { color: #333; font-size: 16px; }"),
			filename:      "styles.css",
			wantMimeType:  "text/css; charset=utf-8",
			wantCacheCtrl: "max-age=3600",
		},
		{
			name:          "detects SQL file",
			content:       []byte("SELECT * FROM users WHERE id = 1;"),
			filename:      "query.sql",
			wantMimeType:  "application/x-sql",
			wantCacheCtrl: "max-age=3600",
		},
		{
			name:          "detects Go file",
			content:       []byte("package main\n\nfunc main() { println(\"Hello\") }"),
			filename:      "main.go",
			wantMimeType:  "text/plain; charset=utf-8",
			wantCacheCtrl: "max-age=3600",
		},
		{
			name:          "respects custom content type",
			content:       []byte("const hello = () => console.log('Hello, World!');"),
			filename:      "script.js",
			wantMimeType:  "application/custom",
			wantCacheCtrl: "max-age=3600",
			opts:          []func(*FileOptions){func(fo *FileOptions) { fo.ContentType = "application/custom" }},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Create a temporary file with test content
			fs := afero.NewMemMapFs()
			require.NoError(t, afero.WriteFile(fs, tt.filename, tt.content, 0644))

			f, err := fs.Open(tt.filename)
			require.NoError(t, err)
			defer f.Close()

			// Parse options
			fo, err := ParseFileOptions(f, tt.filename, tt.opts...)
			require.NoError(t, err)

			// Assert results
			assert.Equal(t, tt.wantMimeType, fo.ContentType)
			assert.Equal(t, tt.wantCacheCtrl, fo.CacheControl)
		})
	}
}
