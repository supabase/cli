package native

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"time"

	"github.com/cenkalti/backoff/v4"
	"github.com/go-errors/errors"
	"github.com/supabase/cli/internal/utils"
)

type nativePostgres struct {
	cmd     *exec.Cmd
	ErrCh   <-chan error
	ReadyCh <-chan error
}

func NewNativePostgres() nativePostgres {
	return nativePostgres{}
}

func (p *nativePostgres) Start(ctx context.Context) error {
	if p.cmd != nil && p.cmd.ProcessState != nil && !p.cmd.ProcessState.Exited() {
		return errors.New("postgres is already running")
	}
	c := exec.CommandContext(ctx, "docker-entrypoint.sh", "postgres", "-D", "/etc/postgresql")
	c.Cancel = func() error {
		// Signal for postgres fast shutdown
		return c.Process.Signal(os.Interrupt)
	}
	c.Env = append(os.Environ(),
		"POSTGRES_PASSWORD="+utils.Config.Db.Password,
		"POSTGRES_HOST=/var/run/postgresql",
		"JWT_SECRET="+utils.Config.Auth.JwtSecret.Value,
		fmt.Sprintf("JWT_EXP=%d", utils.Config.Auth.JwtExpiry),
	)
	c.Stderr = os.Stderr
	c.Stdout = os.Stdout
	var err error
	if c.SysProcAttr, err = getSysProc("postgres"); err != nil {
		return err
	}
	// Start in background
	if err := c.Start(); err != nil {
		return errors.Errorf("failed to start postgres: %w", err)
	}
	errCh := make(chan error, 1)
	cancelCtx, cancel := context.WithCancel(ctx)
	go func() {
		defer cancel()
		errCh <- p.cmd.Wait()
	}()
	// Setup readiness probe
	policy := backoff.WithContext(backoff.WithMaxRetries(
		backoff.NewConstantBackOff(time.Second),
		uint64(utils.Config.Db.HealthTimeout.Seconds()),
	), cancelCtx)
	probe := func() error { return p.HealthCheck(cancelCtx) }
	readyCh := make(chan error, 1)
	go func() {
		readyCh <- backoff.Retry(probe, policy)
	}()
	// Refresh object state
	p.cmd = c
	p.ErrCh = errCh
	p.ReadyCh = readyCh
	return nil
}

func (p *nativePostgres) Close() error {
	if p.cmd == nil || p.cmd.Process == nil {
		return errors.New("postgres is not started")
	}
	if err := p.cmd.Process.Signal(os.Interrupt); err != nil {
		return errors.Errorf("failed to stop postgres: %w", err)
	}
	return nil
}

func (p *nativePostgres) HealthCheck(ctx context.Context) error {
	c := exec.CommandContext(ctx, "pg_isready", "-U", "postgres", "-h", "127.0.0.1", "-p", "5432")
	if err := c.Run(); err != nil {
		return errors.Errorf("postgres is not ready: %w", err)
	}
	return nil
}

func (p *nativePostgres) GetURL() string {
	return "postgres://postgres:postgres@127.0.0.1:5432/postgres"
}
