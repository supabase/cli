package download

import (
	"context"
	"strings"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/content"
)

func Run(ctx context.Context, testId string, fsys afero.Fs) error {
	if strings.TrimSpace(testId) == "" {
		return content.DownloadAll(ctx, fsys, content.ContentTypeTest)
	}
	return content.DownloadOne(ctx, fsys, testId, content.ContentTypeTest)
} 