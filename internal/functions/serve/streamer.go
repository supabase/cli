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
	clock backoff.Clock
	Close context.CancelFunc
	ErrCh chan error
}

func NewLogStreamer(ctx context.Context, opts ...func(*logStreamer)) logStreamer {
	s := logStreamer{
		clock: backoff.SystemClock,
		ErrCh: make(chan error, 1),
	}
	s.ctx, s.Close = context.WithCancel(ctx)
	for _, apply := range opts {
		apply(&s)
	}
	return s
}

const (
	initialInterval = time.Millisecond * 50
	maxElapsedTime  = time.Second * 20
)

func (s *logStreamer) Start(containerID string) {
	policy := backoff.WithContext(backoff.NewExponentialBackOff(
		backoff.WithInitialInterval(initialInterval),
		backoff.WithMaxElapsedTime(maxElapsedTime),
		backoff.WithClockProvider(s.clock),
	), s.ctx)
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
