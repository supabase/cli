package storage

import (
	"context"
	"mime"
	"net/http"
	"testing"
	fs "testing/fstest"

	"github.com/h2non/gock"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/pkg/fetcher"
)

var mockApi = StorageAPI{Fetcher: fetcher.NewFetcher(
	"http://127.0.0.1",
)}

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
			filename:      "test.image",
			wantMimeType:  "image/png",
			wantCacheCtrl: "max-age=3600",
		},
		{
			name:          "detects JavaScript file",
			content:       []byte("const hello = () => console.log('Hello, World!');"),
			filename:      "script.js",
			wantMimeType:  mime.TypeByExtension(".js"),
			wantCacheCtrl: "max-age=3600",
		},
		{
			name:          "detects CSS file",
			content:       []byte(".header { color: #333; font-size: 16px; }"),
			filename:      "styles.css",
			wantMimeType:  mime.TypeByExtension(".css"),
			wantCacheCtrl: "max-age=3600",
		},
		{
			name:          "detects SQL file",
			content:       []byte("SELECT * FROM users WHERE id = 1;"),
			filename:      "query.sql",
			wantMimeType:  mime.TypeByExtension(".sql"),
			wantCacheCtrl: "max-age=3600",
		},
		{
			name:          "use text/plain as fallback for unrecognized extensions",
			content:       []byte("const hello = () => console.log('Hello, World!');"),
			filename:      "main.nonexistent",
			wantMimeType:  "text/plain; charset=utf-8",
			wantCacheCtrl: "max-age=3600",
		},
		{
			name:          "respects custom content type",
			content:       []byte("const hello = () => console.log('Hello, World!');"),
			filename:      "custom.js",
			wantMimeType:  "application/custom",
			wantCacheCtrl: "max-age=3600",
			opts:          []func(*FileOptions){func(fo *FileOptions) { fo.ContentType = "application/custom" }},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Create a temporary file with test content
			fsys := fs.MapFS{tt.filename: &fs.MapFile{Data: tt.content}}
			// Setup mock api
			defer gock.OffAll()
			gock.New("http://127.0.0.1").
				Post("/storage/v1/object/"+tt.filename).
				MatchHeader("Content-Type", tt.wantMimeType).
				MatchHeader("Cache-Control", tt.wantCacheCtrl).
				Reply(http.StatusOK)
			// Parse options
			err := mockApi.UploadObject(context.Background(), tt.filename, tt.filename, fsys, tt.opts...)
			// Assert results
			assert.NoError(t, err)
			assert.Empty(t, gock.Pending())
			assert.Empty(t, gock.GetUnmatchedRequests())
		})
	}
}
