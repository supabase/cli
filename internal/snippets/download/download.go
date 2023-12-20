package download

import (
	"context"
	"fmt"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, snippetId string, fsys afero.Fs) error {
	resp, err := utils.GetSupabase().GetSnippetWithResponse(ctx, snippetId)
	if err != nil {
		return errors.Errorf("failed to download snippet: %w", err)
	}

	if resp.JSON200 == nil {
		return errors.New("Unexpected error downloading SQL snippet: " + string(resp.Body))
	}

	fmt.Println(resp.JSON200.Content.Sql)
	return nil
}
