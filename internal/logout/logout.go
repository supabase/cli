package logout

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

type RunParams struct {
	Fsys          afero.Fs
	DefaultAnswer bool
}

func Run(ctx context.Context, stdout *os.File, params RunParams) error {
	if !utils.PromptYesNo("Do you want to log out? This will remove the acces token from your system.", params.DefaultAnswer, os.Stdin) {
		fmt.Fprintln(stdout, "Not deleting token.")
		return nil
	}

	if err := utils.DeleteAccessToken(params.Fsys); err != nil {
		if errors.Is(err, utils.ErrNotLoggedIn) {
			fmt.Fprintln(stdout, err)
			return nil
		}
		return err
	}

	fmt.Fprintln(stdout, "Access token deleted successfully. You are now logged out.")
	return nil
}
