package apitest

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"

	"github.com/h2non/gock"
	"github.com/moby/moby/api/pkg/stdcopy"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/image"
	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/api/types/volume"
	"github.com/moby/moby/client"
)

const mockHost = "http://127.0.0.1"
const mockAPIVersion = "1.54"

type stdWriter struct {
	io.Writer
	stream stdcopy.StdType
}

func (w stdWriter) Write(p []byte) (int, error) {
	if len(p) > math.MaxUint32 {
		return 0, fmt.Errorf("docker stdcopy frame too large: %d", len(p))
	}
	header := [8]byte{byte(w.stream)}
	//nolint:gosec // len(p) is checked against math.MaxUint32 above.
	binary.BigEndian.PutUint32(header[4:], uint32(len(p)))
	if _, err := w.Writer.Write(header[:]); err != nil {
		return 0, err
	}
	if _, err := w.Writer.Write(p); err != nil {
		return 0, err
	}
	return len(p), nil
}

func NewStdoutWriter(w io.Writer) io.Writer {
	return stdWriter{Writer: w, stream: stdcopy.Stdout}
}

func MockDocker(docker **client.Client) error {
	// Skip setup if docker is already mocked
	if (*docker).DaemonHost() == mockHost {
		return nil
	}
	mock, err := client.New(
		client.WithHost(mockHost),
		client.WithAPIVersion(mockAPIVersion),
		client.WithHTTPClient(&http.Client{Transport: gock.NewTransport()}),
	)
	if err != nil {
		return err
	}
	*docker = mock
	return nil
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
	writer := NewStdoutWriter(&body)
	_, err := io.Copy(writer, r)
	gock.New(docker.DaemonHost()).
		Get("/v"+docker.ClientVersion()+"/containers/"+containerID+"/logs").
		Reply(http.StatusOK).
		SetHeader("Content-Type", "application/vnd.docker.raw-stream").
		Body(&body)
	gock.New(docker.DaemonHost()).
		Get("/v" + docker.ClientVersion() + "/containers/" + containerID + "/json").
		Reply(http.StatusOK).
		JSON(container.InspectResponse{
			State: &container.State{
				ExitCode: exitCode,
			},
		})
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
