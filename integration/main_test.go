package integration

import (
	"log"
	"os"
	"testing"

	"github.com/supabase/cli/integration/mocks/docker"
)

const (
	DockerPort = ":2375"
)

var (
	TempDir string
)

var (
	Logger     *log.Logger
	DockerMock *docker.Server
)

func TestMain(m *testing.M) {
	Logger := log.New(os.Stdout, "", 0)

	Logger.Println("Global tests setup")

	DockerMock = newDockerMock(Logger)
	TempDir = newTempDir(Logger)

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

func newTempDir(Logger *log.Logger) string {
	wd, err := os.Getwd()
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
