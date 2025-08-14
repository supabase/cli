package download

import (
	"context"
	"strings"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/content"
)

func Run(ctx context.Context, snippetId string, fsys afero.Fs) error {
	if strings.TrimSpace(snippetId) == "" {
		return content.DownloadAll(ctx, fsys, content.ContentTypeSnippet)
	}
	return content.DownloadOne(ctx, fsys, snippetId, content.ContentTypeSnippet)
}
