package serve

import (
	"context"
	"os"
	"time"

	"github.com/cenkalti/backoff/v4"
	"github.com/containerd/errdefs"
	"github.com/docker/docker/api/types/container"
	"github.com/go-errors/errors"
	"github.com/supabase/cli/internal/utils"
)

type logStreamer struct {
	ctx   context.Context
	Close context.CancelFunc
	ErrCh chan error
}

func NewLogStreamer(ctx context.Context) logStreamer {
	cancelCtx, cancel := context.WithCancel(ctx)
	return logStreamer{
		ctx:   cancelCtx,
		Close: cancel,
		ErrCh: make(chan error, 1),
	}
}

// Used by unit tests
var retryInterval = time.Millisecond * 400

func (s *logStreamer) Start(containerID string) {
	// Retry indefinitely until stream is closed
	policy := backoff.WithContext(backoff.NewConstantBackOff(retryInterval), s.ctx)
	fetch := func() error {
		if err := utils.DockerStreamLogs(s.ctx, containerID, os.Stdout, os.Stderr, func(lo *container.LogsOptions) {
			lo.Timestamps = true
		}); errdefs.IsNotFound(err) || errdefs.IsConflict(err) || errors.Is(err, utils.ErrContainerKilled) {
			return err
		} else if err != nil {
			return &backoff.PermanentError{Err: err}
		}
		return errors.Errorf("container exited gracefully: %s", containerID)
	}
	s.ErrCh <- backoff.Retry(fetch, policy)
}
