package logout

import (
	"context"
	"fmt"
	"os"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

type RunParams struct {
	Fsys afero.Fs
}

var loggedOutMsg = "You are now logged out."

func Run(ctx context.Context, stdout *os.File, params RunParams) error {
	err := utils.RunProgram(ctx, func(p utils.Program, ctx context.Context) error {
		p.Send(utils.StatusMsg("Deleting the access token. Please wait..."))

		return utils.DeleteAccessToken(params.Fsys)
	})

	if err != nil {
		return err
	}

	fmt.Fprintf(stdout, "Token deleted successfully.\n\n")
	fmt.Fprintln(stdout, loggedOutMsg)

	return nil
}
