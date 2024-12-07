package unset

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"strings"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/secrets/list"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, projectRef string, args []string, fsys afero.Fs) error {
	if len(args) == 0 {
		secrets, err := list.GetSecretDigests(ctx, projectRef)
		if err != nil {
			return err
		}
		for _, secret := range secrets {
			if !strings.HasPrefix(secret.Name, "SUPABASE_") {
				args = append(args, secret.Name)
			}
		}
	}
	// 1. Sanity checks.
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "You have not set any function secrets, nothing to do.")
		return nil
	}
	msg := fmt.Sprintf("Do you want to unset these function secrets?\n • %s\n\n", strings.Join(args, "\n • "))
	if shouldUnset, err := utils.NewConsole().PromptYesNo(ctx, msg, true); err != nil {
		return err
	} else if !shouldUnset {
		return errors.New(context.Canceled)
	}
	// 2. Unset secret(s).
	resp, err := utils.GetSupabase().V1BulkDeleteSecretsWithResponse(ctx, projectRef, args)
	if err != nil {
		return errors.Errorf("failed to delete secrets: %w", err)
	}
	if resp.StatusCode() != http.StatusOK {
		return errors.New("Unexpected error unsetting project secrets: " + string(resp.Body))
	}
	fmt.Println("Finished " + utils.Aqua("supabase secrets unset") + ".")
	return nil
}
