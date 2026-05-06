package download

import (
	"context"
	"fmt"

	"github.com/go-errors/errors"
	"github.com/google/uuid"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, snippetId string, fsys afero.Fs) error {
	// Convert string to UUID
	id, err := uuid.Parse(snippetId)
	if err != nil {
		return fmt.Errorf("invalid snippet ID: %w", err)
	}
	resp, err := utils.GetSupabase().V1GetASnippetWithResponse(ctx, id)
	if err != nil {
		return errors.Errorf("failed to download snippet: %w", err)
	} else if resp.JSON200 == nil {
		return errors.Errorf("unexpected download snippet status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	fmt.Println(resp.JSON200.Content.Sql)
	return nil
}
