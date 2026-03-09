package delete

import (
	"context"
	"fmt"
	"net/http"
	"os"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, projectRef string, fsys afero.Fs) error {
	resp, err := utils.GetSupabase().V1DeactivateVanitySubdomainConfigWithResponse(ctx, projectRef)
	if err != nil {
		return errors.Errorf("failed to delete vanity subdomain: %w", err)
	} else if resp.StatusCode() != http.StatusOK {
		return errors.Errorf("unexpected delete vanity subdomain status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	fmt.Fprintln(os.Stderr, "Deleted vanity subdomain successfully.")
	return nil
}
