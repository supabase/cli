package serve

import (
	"context"
	"os"
	"strings"

	"github.com/containerd/errdefs"
	"github.com/docker/docker/api/types/container"
	"github.com/supabase/cli/internal/utils"
)

type logStreamer struct {
	ctx    context.Context
	cancel context.CancelFunc
	ErrCh  chan error
}

func NewLogStreamer(ctx context.Context) logStreamer {
	cancelCtx, cancel := context.WithCancel(ctx)
	return logStreamer{
		ctx:    cancelCtx,
		cancel: cancel,
		ErrCh:  make(chan error, 1),
	}
}

func (s *logStreamer) Start(containerID string) {
	for {
		if err := utils.DockerStreamLogs(s.ctx, containerID, os.Stdout, os.Stderr, func(lo *container.LogsOptions) {
			lo.Timestamps = true
		}); err != nil &&
			!errdefs.IsNotFound(err) &&
			!strings.HasSuffix(err.Error(), "exit 137") &&
			!strings.HasSuffix(err.Error(), "can not get logs from container which is dead or marked for removal") {
			s.ErrCh <- err
			break
		}
	}
}

func (s *logStreamer) Close() {
	if s.cancel != nil {
		s.cancel()
	}
}
