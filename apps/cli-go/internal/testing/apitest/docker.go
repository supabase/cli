package apitest

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/docker/docker/api"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/api/types/versions"
	"github.com/docker/docker/api/types/volume"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/go-errors/errors"
	"github.com/h2non/gock"
)

const mockHost = "http://127.0.0.1"

func MockDocker(docker *client.Client) error {
	// Skip setup if docker is already mocked
	if docker.DaemonHost() == mockHost {
		return nil
	}
	if err := client.WithVersion(api.DefaultVersion)(docker); err != nil {
		return err
	}
	// Safe to ignore errors as transport will be replaced by gock
	_ = client.WithHost(mockHost)(docker)
	return client.WithHTTPClient(http.DefaultClient)(docker)
}

// Ref: internal/utils/docker.go::DockerStart
func MockDockerStart(docker *client.Client, imageID, containerID string) {
	gock.New(docker.DaemonHost()).
		Get("/v" + docker.ClientVersion() + "/images/" + imageID + "/json").
		Reply(http.StatusOK).
		JSON(image.InspectResponse{})
	gock.New(docker.DaemonHost()).
		Post("/v" + docker.ClientVersion() + "/networks/create").
		Reply(http.StatusCreated).
		JSON(network.CreateResponse{})
	gock.New(docker.DaemonHost()).
		Post("/v" + docker.ClientVersion() + "/volumes/create").
		Persist().
		Reply(http.StatusCreated).
		JSON(volume.Volume{})
	gock.New(docker.DaemonHost()).
		Post("/v" + docker.ClientVersion() + "/containers/create").
		Reply(http.StatusOK).
		JSON(container.CreateResponse{ID: containerID})
	gock.New(docker.DaemonHost()).
		Post("/v" + docker.ClientVersion() + "/containers/" + containerID + "/start").
		Reply(http.StatusAccepted)
}

// Ref: internal/utils/docker.go::DockerRemoveAll
func MockDockerStop(docker *client.Client) {
	gock.New(docker.DaemonHost()).
		Get("/v" + docker.ClientVersion() + "/containers/json").
		Reply(http.StatusOK).
		JSON([]container.Summary{})
	gock.New(docker.DaemonHost()).
		Post("/v" + docker.ClientVersion() + "/containers/prune").
		Reply(http.StatusOK).
		JSON(container.PruneReport{})
	if !versions.GreaterThanOrEqualTo(docker.ClientVersion(), "1.42") {
		gock.New(docker.DaemonHost()).
			Post("/v"+docker.ClientVersion()+"/volumes/prune").
			MatchParam("filters", `"all":{"true":true}`).
			ReplyError(errors.New(`failed to parse filters for all=true&label=com.supabase.cli.project%3Dtest: "all" is an invalid volume filter`))
	}
	gock.New(docker.DaemonHost()).
		Post("/v" + docker.ClientVersion() + "/volumes/prune").
		Reply(http.StatusOK).
		JSON(volume.PruneReport{})
	gock.New(docker.DaemonHost()).
		Post("/v" + docker.ClientVersion() + "/networks/prune").
		Reply(http.StatusOK).
		JSON(network.PruneReport{})
}

// Ref: internal/utils/docker.go::DockerRunOnce
func setupDockerLogs(docker *client.Client, containerID, stdout string, exitCode int) error {
	err := MockDockerLogsStream(docker, containerID, exitCode, strings.NewReader(stdout))
	gock.New(docker.DaemonHost()).
		Delete("/v" + docker.ClientVersion() + "/containers/" + containerID).
		Reply(http.StatusOK)
	return err
}

func MockDockerLogsStream(docker *client.Client, containerID string, exitCode int, r io.Reader) error {
	var body bytes.Buffer
	writer := stdcopy.NewStdWriter(&body, stdcopy.Stdout)
	_, err := io.Copy(writer, r)
	gock.New(docker.DaemonHost()).
		Get("/v"+docker.ClientVersion()+"/containers/"+containerID+"/logs").
		Reply(http.StatusOK).
		SetHeader("Content-Type", "application/vnd.docker.raw-stream").
		Body(&body)
	gock.New(docker.DaemonHost()).
		Get("/v" + docker.ClientVersion() + "/containers/" + containerID + "/json").
		Reply(http.StatusOK).
		JSON(container.InspectResponse{ContainerJSONBase: &container.ContainerJSONBase{
			State: &container.State{
				ExitCode: exitCode,
			}}})
	return err
}

func MockDockerLogs(docker *client.Client, containerID, stdout string) error {
	return setupDockerLogs(docker, containerID, stdout, 0)
}

func MockDockerLogsExitCode(docker *client.Client, containerID string, exitCode int) error {
	return setupDockerLogs(docker, containerID, "", exitCode)
}

func ListUnmatchedRequests() []string {
	result := make([]string, len(gock.GetUnmatchedRequests()))
	for i, r := range gock.GetUnmatchedRequests() {
		result[i] = fmt.Sprintln(r.Method, r.URL.Path)
	}
	return result
}
