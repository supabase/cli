package deploy

import (
	"context"
	"fmt"
	"os"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/bootstrap"
	configPush "github.com/supabase/cli/internal/config/push"
	"github.com/supabase/cli/internal/db/push"
	funcDeploy "github.com/supabase/cli/internal/functions/deploy"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/function"
)

func Run(ctx context.Context, dryRun bool, fsys afero.Fs) error {
	fmt.Fprintln(os.Stderr, "Deploying to project:", flags.ProjectRef)
	services := []api.V1GetServicesHealthParamsServices{
		api.Auth,
		// Not checking Realtime for now as it can be flaky
		// api.Realtime,
		api.Rest,
		api.Storage,
		api.Db,
	}
	if err := bootstrap.CheckProjectHealth(ctx, flags.ProjectRef, services...); err != nil {
		return err
	}

	var deployErrors []error

	// Maybe deploy database migrations
	fmt.Fprintln(os.Stderr, utils.Aqua(">>>"), "Deploying database migrations...")
	if err := push.Run(ctx, dryRun, false, false, false, flags.DbConfig, fsys); err != nil {
		deployErrors = append(deployErrors, errors.Errorf("db push failed: %w", err))
	}
	fmt.Fprintln(os.Stderr)

	// Maybe deploy edge functions
	fmt.Fprintln(os.Stderr, utils.Aqua(">>>"), "Deploying edge functions...")
	if err := funcDeploy.Run(ctx, []string{}, true, nil, "", 1, false, dryRun, fsys); err != nil && !errors.Is(err, function.ErrNoDeploy) {
		deployErrors = append(deployErrors, errors.Errorf("functions deploy failed: %w", err))
		fmt.Fprintln(os.Stderr, utils.Yellow("WARNING:")+" Functions deployment failed:", err)
	} else if errors.Is(err, function.ErrNoDeploy) {
		fmt.Fprintln(os.Stderr, utils.Yellow("⏭ ")+"No functions to deploy")
	} else {
		// print error just in case
		fmt.Fprintln(os.Stderr, err)
		if dryRun {
			fmt.Fprintln(os.Stderr, utils.Aqua("✓")+" Functions dry run complete")
		} else {
			fmt.Fprintln(os.Stderr, utils.Aqua("✓")+" Functions deployed successfully")
		}
	}
	fmt.Fprintln(os.Stderr)

	// Maybe deploy config
	fmt.Fprintln(os.Stderr, utils.Aqua(">>>"), "Deploying config...")
	if err := configPush.Run(ctx, flags.ProjectRef, dryRun, fsys); err != nil {
		deployErrors = append(deployErrors, errors.Errorf("config push failed: %w", err))
		fmt.Fprintln(os.Stderr, utils.Yellow("WARNING:")+" Config deployment failed:", err)
	} else {
		if dryRun {
			fmt.Fprintln(os.Stderr, utils.Aqua("✓")+" Config dry run complete")
		} else {
			fmt.Fprintln(os.Stderr, utils.Aqua("✓")+" Config deployed successfully")
		}
	}
	fmt.Fprintln(os.Stderr)

	// Summary
	if len(deployErrors) > 0 {
		if dryRun {
			fmt.Fprintln(os.Stderr, utils.Yellow("Dry run completed with warnings:"))
		} else {
			fmt.Fprintln(os.Stderr, utils.Yellow("Deploy completed with warnings:"))
		}
		for _, err := range deployErrors {
			fmt.Fprintln(os.Stderr, " •", err)
		}
		return nil // Don't fail the command for non-critical errors
	}

	if dryRun {
		fmt.Fprintln(os.Stderr, utils.Aqua("✓")+" "+utils.Bold("Dry run completed successfully!"))
	} else {
		fmt.Fprintln(os.Stderr, utils.Aqua("✓")+" "+utils.Bold("Deployment completed successfully!"))
	}
	return nil
}
