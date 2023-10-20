package apitest

import (
	"bytes"
	"fmt"
	"net/http"

	"github.com/docker/docker/api"
	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/stdcopy"
	"gopkg.in/h2non/gock.v1"
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
	if err := client.WithHost(mockHost)(docker); err != nil {
		return err
	}
	return client.WithHTTPClient(http.DefaultClient)(docker)
}

// Ref: internal/utils/docker.go::DockerStart
func MockDockerStart(docker *client.Client, image, containerID string) {
	gock.New(docker.DaemonHost()).
		Get("/v" + docker.ClientVersion() + "/images/" + image + "/json").
		Reply(http.StatusOK).
		JSON(types.ImageInspect{})
	gock.New(docker.DaemonHost()).
		Post("/v" + docker.ClientVersion() + "/networks/create").
		Reply(http.StatusCreated).
		JSON(types.NetworkCreateResponse{})
	gock.New(docker.DaemonHost()).
		Post("/v" + docker.ClientVersion() + "/containers/create").
		Reply(http.StatusOK).
		JSON(container.CreateResponse{ID: containerID})
	gock.New(docker.DaemonHost()).
		Post("/v" + docker.ClientVersion() + "/containers/" + containerID + "/start").
		Reply(http.StatusAccepted)
}

// Ref: internal/utils/docker.go::DockerRunOnce
func MockDockerLogs(docker *client.Client, containerID, stdout string) error {
	var body bytes.Buffer
	writer := stdcopy.NewStdWriter(&body, stdcopy.Stdout)
	_, err := writer.Write([]byte(stdout))
	gock.New(docker.DaemonHost()).
		Get("/v"+docker.ClientVersion()+"/containers/"+containerID+"/logs").
		Reply(http.StatusOK).
		SetHeader("Content-Type", "application/vnd.docker.raw-stream").
		Body(&body)
	gock.New(docker.DaemonHost()).
		Get("/v" + docker.ClientVersion() + "/containers/" + containerID + "/json").
		Reply(http.StatusOK).
		JSON(types.ContainerJSONBase{State: &types.ContainerState{ExitCode: 0}})
	gock.New(docker.DaemonHost()).
		Delete("/v" + docker.ClientVersion() + "/containers/" + containerID).
		Reply(http.StatusOK)
	return err
}

func ListUnmatchedRequests() []string {
	result := make([]string, len(gock.GetUnmatchedRequests()))
	for i, r := range gock.GetUnmatchedRequests() {
		result[i] = fmt.Sprintln(r.Method, r.URL.Path)
	}
	return result
}
