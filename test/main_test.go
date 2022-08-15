package integration

import (
	"log"
	"os"
	"testing"

	"github.com/docker/docker/client"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/test/mocks/docker"
	"github.com/supabase/cli/test/mocks/supabase"
)

const (
	DockerPort   = ":2375"
	SupabasePort = ":2376"
)

var (
	TempDir string
)

var (
	Logger     *log.Logger
	DockerMock *docker.Server
	SupaMock   *supabase.Server
)

func TestMain(m *testing.M) {
	Logger := log.New(os.Stdout, "", 0)

	Logger.Println("Global tests setup")

	DockerMock = newDockerMock(Logger)
	SupaMock = newSupabaseMock(Logger)
	TempDir = NewTempDir(Logger, "")

	// redirect clients to mock servers
	err := client.WithHost("tcp://127.0.0.1" + DockerPort)(utils.Docker)
	if err != nil {
		Logger.Fatal(err)
	}
	os.Setenv("SUPABASE_INTERNAL_API_HOST", "http://127.0.0.1"+SupabasePort)

	// Configure viper env loader
	viper.SetEnvPrefix("SUPABASE")
	viper.AutomaticEnv()

	// run tests
	exitVal := m.Run()

	Logger.Println("Global teardown")
	os.RemoveAll(TempDir)

	// exit process with tests exit code
	os.Exit(exitVal)
}

func newDockerMock(Logger *log.Logger) *docker.Server {
	dockerMock := docker.NewServer()
	dockerRouter := dockerMock.NewRouter()
	go func() {
		err := dockerRouter.Run(DockerPort)
		if err != nil {
			Logger.Fatal(err)
		}
	}()

	return dockerMock
}

func newSupabaseMock(Logger *log.Logger) *supabase.Server {
	supaMock := supabase.NewServer()
	supaRouter := supaMock.NewRouter()
	go func() {
		err := supaRouter.Run(SupabasePort)
		if err != nil {
			Logger.Fatal(err)
		}
	}()

	return supaMock
}

func NewTempDir(Logger *log.Logger, baseDir string) string {
	wd := baseDir
	var err error
	if baseDir == "" {
		wd, err = os.Getwd()
	}
	if err != nil {
		Logger.Fatal(err)
	}
	tempDir, err := os.MkdirTemp(wd, "cli-test-")
	if err != nil {
		Logger.Fatal(err)
	}
	err = os.Chdir(tempDir)
	if err != nil {
		Logger.Fatal(err)
	}
	return tempDir
}
