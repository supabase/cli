package telemetry

import (
	"context"
	"os"
	"runtime"
	"time"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

type commandContextKey struct{}
type serviceContextKey struct{}

type CommandContext struct {
	RunID   string
	Command string
	Flags   map[string]any
	Groups  map[string]string
}

type Options struct {
	Analytics  Analytics
	Now        func() time.Time
	IsTTY      bool
	IsCI       bool
	IsAgent    bool
	EnvSignals map[string]any
	CLIName    string
	GOOS       string
	GOARCH     string
}

type Service struct {
	fsys       afero.Fs
	analytics  Analytics
	now        func() time.Time
	state      State
	isFirstRun bool
	isTTY      bool
	isCI       bool
	isAgent    bool
	envSignals map[string]any
	cliVersion string
	goos       string
	goarch     string
}

func NewService(fsys afero.Fs, opts Options) (*Service, error) {
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	state, created, err := LoadOrCreateState(fsys, now())
	if err != nil {
		return nil, err
	}
	analytics := opts.Analytics
	if analytics == nil {
		analytics, err = NewClient(utils.PostHogAPIKey, utils.PostHogEndpoint, nil, nil)
		if err != nil {
			return nil, err
		}
	}
	cliVersion := opts.CLIName
	if cliVersion == "" {
		cliVersion = utils.Version
	}
	goos := opts.GOOS
	if goos == "" {
		goos = runtime.GOOS
	}
	goarch := opts.GOARCH
	if goarch == "" {
		goarch = runtime.GOARCH
	}
	return &Service{
		fsys:       fsys,
		analytics:  analytics,
		now:        now,
		state:      state,
		isFirstRun: created,
		isTTY:      opts.IsTTY,
		isCI:       opts.IsCI,
		isAgent:    opts.IsAgent,
		envSignals: opts.EnvSignals,
		cliVersion: cliVersion,
		goos:       goos,
		goarch:     goarch,
	}, nil
}

func WithCommandContext(ctx context.Context, cmd CommandContext) context.Context {
	return context.WithValue(ctx, commandContextKey{}, cmd)
}

func WithService(ctx context.Context, service *Service) context.Context {
	return context.WithValue(ctx, serviceContextKey{}, service)
}

func FromContext(ctx context.Context) *Service {
	if ctx == nil {
		return nil
	}
	service, _ := ctx.Value(serviceContextKey{}).(*Service)
	return service
}

// Property catalog: see events.go.
func (s *Service) Capture(ctx context.Context, event string, properties map[string]any, groups map[string]string) error {
	if !s.canSend() {
		return nil
	}
	mergedProperties := s.baseProperties()
	command := commandContextFrom(ctx)
	if command.RunID != "" {
		mergedProperties[PropCommandRunID] = command.RunID
	}
	if command.Command != "" {
		mergedProperties[PropCommand] = command.Command
	}
	if command.Flags != nil {
		mergedProperties[PropFlags] = command.Flags
	}
	for key, value := range properties {
		mergedProperties[key] = value
	}
	return s.analytics.Capture(s.distinctID(), event, mergedProperties, mergeGroups(linkedProjectGroups(s.fsys), mergeGroups(command.Groups, groups)))
}

func (s *Service) StitchLogin(distinctID string) error {
	if s == nil {
		return nil
	}
	if s.canSend() {
		if err := s.analytics.Alias(distinctID, s.state.DeviceID); err != nil {
			return err
		}
		if err := s.analytics.Identify(distinctID, nil); err != nil {
			return err
		}
	}
	s.state.DistinctID = distinctID
	return SaveState(s.state, s.fsys)
}

func (s *Service) ClearDistinctID() error {
	if s == nil {
		return nil
	}
	s.state.DistinctID = ""
	return SaveState(s.state, s.fsys)
}

func (s *Service) NeedsIdentityStitch() bool {
	return s != nil && s.state.DistinctID == "" && s.canSend()
}

func (s *Service) GroupIdentify(groupType string, groupKey string, properties map[string]any) error {
	if !s.canSend() {
		return nil
	}
	return s.analytics.GroupIdentify(groupType, groupKey, s.basePropertiesWith(properties))
}

func (s *Service) Close() error {
	if s == nil || s.analytics == nil {
		return nil
	}
	return s.analytics.Close()
}

func (s *Service) baseProperties() map[string]any {
	properties := map[string]any{
		PropPlatform:      "cli",
		PropSchemaVersion: s.state.SchemaVersion,
		PropDeviceID:      s.state.DeviceID,
		PropSessionID:     s.state.SessionID,
		PropIsFirstRun:    s.isFirstRun,
		PropIsTTY:         s.isTTY,
		PropIsCI:          s.isCI,
		PropIsAgent:       s.isAgent,
		PropOS:            s.goos,
		PropArch:          s.goarch,
		PropCLIVersion:    s.cliVersion,
	}
	if len(s.envSignals) > 0 {
		properties[PropEnvSignals] = s.envSignals
	}
	return properties
}

func (s *Service) basePropertiesWith(properties map[string]any) map[string]any {
	merged := s.baseProperties()
	for key, value := range properties {
		merged[key] = value
	}
	return merged
}

func (s *Service) distinctID() string {
	if s.state.DistinctID != "" {
		return s.state.DistinctID
	}
	return s.state.DeviceID
}

func commandContextFrom(ctx context.Context) CommandContext {
	if ctx == nil {
		return CommandContext{}
	}
	cmd, _ := ctx.Value(commandContextKey{}).(CommandContext)
	return cmd
}

func mergeGroups(existing map[string]string, extra map[string]string) map[string]string {
	if len(existing) == 0 && len(extra) == 0 {
		return nil
	}
	merged := make(map[string]string, len(existing)+len(extra))
	for key, value := range existing {
		merged[key] = value
	}
	for key, value := range extra {
		merged[key] = value
	}
	return merged
}

func (s *Service) canSend() bool {
	return s != nil &&
		s.analytics != nil &&
		s.analytics.Enabled() &&
		s.state.Enabled &&
		os.Getenv("DO_NOT_TRACK") != "1" &&
		os.Getenv("SUPABASE_TELEMETRY_DISABLED") != "1"
}
