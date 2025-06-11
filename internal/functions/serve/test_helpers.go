package serve

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/fsnotify/fsnotify"
	"github.com/h2non/gock"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/utils"
)

type TestSetup struct {
	T         *testing.T
	Fsys      afero.Fs
	Context   context.Context
	Cancel    context.CancelFunc
	ProjectId string
	RootPath  string
}

func NewTestSetup(t *testing.T) *TestSetup {
	fsys := afero.NewMemMapFs()
	ctx, cancel := context.WithCancel(context.Background())

	setup := &TestSetup{
		T:         t,
		Fsys:      fsys,
		Context:   ctx,
		Cancel:    cancel,
		ProjectId: "test",
		RootPath:  "/project",
	}

	// Initialize basic config
	require.NoError(t, utils.InitConfig(utils.InitParams{ProjectId: setup.ProjectId}, fsys))

	return setup
}

func (s *TestSetup) Cleanup() {
	s.Cancel()
	gock.OffAll()
}

// SetupFunction creates a test function with given name and content
func (s *TestSetup) SetupFunction(name, content string) {
	funcDir := filepath.Join(utils.FunctionsDir, name)
	require.NoError(s.T, s.Fsys.MkdirAll(funcDir, 0755))
	require.NoError(s.T, afero.WriteFile(s.Fsys, filepath.Join(funcDir, "index.ts"), []byte(content), 0644))
}

// SetupEnvFile creates an environment file with given content
func (s *TestSetup) SetupEnvFile(path, content string) {
	if path == "" {
		path = utils.FallbackEnvFilePath
	}
	require.NoError(s.T, afero.WriteFile(s.Fsys, path, []byte(content), 0644))
}

// SetupImportMap creates an import map file with given content
func (s *TestSetup) SetupImportMap(path, content string) {
	if path == "" {
		path = utils.FallbackImportMapPath
	}
	require.NoError(s.T, afero.WriteFile(s.Fsys, path, []byte(content), 0644))
}

// CreateFileWatcher creates a test file watcher with a temporary directory structure
func (s *TestSetup) CreateFileWatcher(watchPath string) (*fsnotify.Watcher, error) {
	// Create the watch directory in virtual filesystem only
	require.NoError(s.T, s.Fsys.MkdirAll(watchPath, 0755))

	// For tests that actually need a watcher, create one but don't try to watch virtual filesystem
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}

	return watcher, nil
}

// SetupConfigWithFunctions creates a supabase config.toml with function configurations
func (s *TestSetup) SetupConfigWithFunctions() {
	configContent := `[functions.hello]
enabled = true
verify_jwt = false

[functions.protected]
enabled = true
verify_jwt = true

[functions.goodbye]
enabled = false
verify_jwt = false`

	require.NoError(s.T, afero.WriteFile(s.Fsys, "supabase/config.toml", []byte(configContent), 0644))
}

// FileEventTestCase represents a test case for file event handling
type FileEventTestCase struct {
	Name         string
	Filename     string
	Op           fsnotify.Op
	ShouldIgnore bool
}

func GetFileEventTestCases() []FileEventTestCase {
	return []FileEventTestCase{
		// Regular files that should not be ignored
		{"TypeScript file", "index.ts", fsnotify.Write, false},
		{"JavaScript file", "function.js", fsnotify.Create, false},
		{"JSON config", "config.json", fsnotify.Write, false},
		{"Markdown doc", "README.md", fsnotify.Write, false},

		// Editor files that should be ignored
		{"Vim backup", "file.txt~", fsnotify.Write, true},
		{"Vim swap", ".file.swp", fsnotify.Create, true},
		{"Emacs lock", ".#file.txt", fsnotify.Create, true},
		{"Temp file", "file.tmp", fsnotify.Write, true},

		// Deno temporary files
		{"Deno bundle", "___deno_bundle_123___", fsnotify.Create, true},
		{"Deno temp", "___temp_file___", fsnotify.Write, true},

		// Special operation cases
		{"CHMOD on underscore file", "file___", fsnotify.Chmod, true},
		{"Write on underscore file", "file___", fsnotify.Write, false},
	}
}
