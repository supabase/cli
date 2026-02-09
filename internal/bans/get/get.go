package get

import (
	"context"
	"fmt"
	"os"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
)

func Run(ctx context.Context, projectRef string, fsys afero.Fs) error {
	ips, err := flags.ListNetworkBans(ctx, projectRef)
	if err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "DB banned IPs:")
	switch utils.OutputFormat.Value {
	case utils.OutputPretty:
		utils.OutputFormat.Value = utils.OutputJson
	case utils.OutputToml:
		return utils.EncodeOutput(utils.OutputFormat.Value, os.Stdout, struct {
			BannedIPs []string `toml:"banned_ips"`
		}{
			BannedIPs: ips,
		})
	case utils.OutputEnv:
		return errors.New(utils.ErrEnvNotSupported)
	}
	return utils.EncodeOutput(utils.OutputFormat.Value, os.Stdout, ips)
}
