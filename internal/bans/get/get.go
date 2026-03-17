package get

import (
	"context"
	"fmt"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils/flags"
)

func Run(ctx context.Context, projectRef string, fsys afero.Fs) error {
	ips, err := flags.ListNetworkBans(ctx, projectRef)
	if err != nil {
		return err
	}
	fmt.Printf("DB banned IPs: %+v\n", ips)
	return nil
}
