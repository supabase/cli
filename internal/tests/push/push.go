package push

import (
	"context"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/content"
)

func Run(ctx context.Context, fsys afero.Fs) error {
	return content.Push(ctx, fsys, content.ContentTypeTest)
} 