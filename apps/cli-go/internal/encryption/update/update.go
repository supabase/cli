package update

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/go-errors/errors"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/credentials"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, projectRef string) error {
	fmt.Fprintf(os.Stderr, "Enter a new root key: ")
	input := credentials.PromptMasked(os.Stdin)
	resp, err := utils.GetSupabase().V1UpdatePgsodiumConfigWithResponse(ctx, projectRef, api.UpdatePgsodiumConfigBody{
		RootKey: strings.TrimSpace(input),
	})
	if err != nil {
		return errors.Errorf("failed to update pgsodium config: %w", err)
	} else if resp.JSON200 == nil {
		return errors.Errorf("unexpected update pgsodium config status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	fmt.Fprintln(os.Stderr, "Finished "+utils.Aqua("supabase root-key update")+".")
	return nil
}
