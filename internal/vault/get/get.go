package get

import (
	"context"
	"errors"
	"fmt"

	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, projectRef string) error {
	resp, err := utils.GetSupabase().GetPgsodiumConfigWithResponse(ctx, projectRef)
	if err != nil {
		return err
	}

	if resp.JSON200 == nil {
		return errors.New("Unexpected error retrieving project root key: " + string(resp.Body))
	}

	fmt.Println(resp.JSON200.RootKey)
	return nil
}
