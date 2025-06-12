package serve

import (
	"context"
	"fmt"
	"log"

	"github.com/docker/docker/api/types/container"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
)

type InspectMode string

const (
	InspectModeRun  InspectMode = "run"
	InspectModeBrk  InspectMode = "brk"
	InspectModeWait InspectMode = "wait"
)

func (mode InspectMode) toFlag() string {
	switch mode {
	case InspectModeBrk:
		return "inspect-brk"
	case InspectModeWait:
		return "inspect-wait"
	case InspectModeRun:
		fallthrough
	default:
		return "inspect"
	}
}

type RuntimeOption struct {
	InspectMode *InspectMode
	InspectMain bool
}

const (
	dockerRuntimeInspectorPort = 8083
)

func (i *RuntimeOption) toArgs() []string {
	flags := []string{}
	if i.InspectMode != nil {
		flags = append(flags, fmt.Sprintf("--%s=0.0.0.0:%d", i.InspectMode.toFlag(), dockerRuntimeInspectorPort))
		if i.InspectMain {
			flags = append(flags, "--inspect-main")
		}
	}
	return flags
}

func Run(ctx context.Context, envFilePath string, noVerifyJWT *bool, importMapPath string, runtimeOption RuntimeOption, fsys afero.Fs) error {
	return RunWithWatcher(ctx, envFilePath, noVerifyJWT, importMapPath, runtimeOption, fsys)
}

func RunWithWatcher(ctx context.Context, envFilePath string, noVerifyJWT *bool, importMapPath string, runtimeOption RuntimeOption, fsys afero.Fs) error {
	// 1. Sanity checks.
	if err := flags.LoadConfig(fsys); err != nil {
		return err
	}
	if err := utils.AssertSupabaseDbIsRunning(); err != nil {
		return err
	}

	fileWatcher, err := NewFileWatcher(utils.FunctionsDir, fsys)
	if err != nil {
		return err
	}
	defer fileWatcher.Close()

	// Start watching for file changes
	restartChan, watcherErrChan := fileWatcher.Watch(ctx, fsys)

	errChan := make(chan error, 1)

	for {
		select {
		case <-ctx.Done():
			fmt.Println("Stopping functions server...")
			// 2. Remove existing container if any.
			_ = utils.Docker.ContainerRemove(context.Background(), utils.EdgeRuntimeId, container.RemoveOptions{
				RemoveVolumes: true,
				Force:         true,
			})
			return ctx.Err()
		default:
			// Use network alias because Deno cannot resolve `_` in hostname
			dbUrl := fmt.Sprintf("postgresql://postgres:postgres@%s:5432/postgres", utils.DbAliases[0])

			serviceCancel, logsDone, err := manageFunctionServices(ctx, envFilePath, noVerifyJWT, importMapPath, dbUrl, runtimeOption, fsys, errChan)
			if err != nil {
				return err
			}

			select {
			case <-restartChan:
				log.Println("Reloading Edge Functions due to file changes...")
				if serviceCancel != nil {
					serviceCancel()
				}
				<-logsDone
				continue
			case err := <-watcherErrChan:
				if serviceCancel != nil {
					serviceCancel()
				}
				<-logsDone
				_ = utils.Docker.ContainerRemove(context.Background(), utils.EdgeRuntimeId, container.RemoveOptions{Force: true})
				return fmt.Errorf("file watcher error: %w", err)
			case err := <-errChan:
				if serviceCancel != nil {
					serviceCancel()
				}
				<-logsDone
				_ = utils.Docker.ContainerRemove(context.Background(), utils.EdgeRuntimeId, container.RemoveOptions{Force: true})
				return err
			case <-ctx.Done():
				fmt.Println("Stopping functions server (received done signal during active service)...")
				if serviceCancel != nil {
					serviceCancel()
				}
				<-logsDone
				_ = utils.Docker.ContainerRemove(context.Background(), utils.EdgeRuntimeId, container.RemoveOptions{
					RemoveVolumes: true,
					Force:         true,
				})
				return ctx.Err()
			}
		}
	}
}
