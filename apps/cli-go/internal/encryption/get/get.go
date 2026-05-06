package get

import (
	"context"
	"fmt"

	"github.com/go-errors/errors"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, projectRef string) error {
	resp, err := utils.GetSupabase().V1GetPgsodiumConfigWithResponse(ctx, projectRef)
	if err != nil {
		return errors.Errorf("failed to retrieve pgsodium config: %w", err)
	} else if resp.JSON200 == nil {
		return errors.Errorf("unexpected get pgsodium config status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	fmt.Println(resp.JSON200.RootKey)
	return nil
}
