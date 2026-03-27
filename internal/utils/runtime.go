package utils

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"strings"

	"github.com/containerd/errdefs"
	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/api/types/volume"
	"github.com/docker/docker/client"
	"github.com/go-errors/errors"
)

// healthcheckLabel stores the container's health-check command as a
// base64-encoded JSON array inside a label.  Apple containers do not support
// native health-checks, so the CLI runs the check itself via `container exec`.
const healthcheckLabel = "com.supabase.cli.healthcheck"

type ContainerMount struct {
	Source   string
	Target   string
	Type     string
	ReadOnly bool
}

type ContainerInfo struct {
	ID           string
	Names        []string
	Labels       map[string]string
	Status       string
	Running      bool
	HealthStatus string
	Mounts       []ContainerMount
	NetworkIPs   map[string]string
}

type VolumeInfo struct {
	Name   string
	Labels map[string]string
}

type NetworkInfo struct {
	Name   string
	Labels map[string]string
}

func applyContainerLabels(config *container.Config) {
	if config.Labels == nil {
		config.Labels = make(map[string]string, 3)
	}
	config.Labels[CliProjectLabel] = Config.ProjectId
	config.Labels[composeProjectLabel] = Config.ProjectId
	if encoded := encodeHealthcheck(config.Healthcheck); len(encoded) > 0 {
		config.Labels[healthcheckLabel] = encoded
	}
}

func encodeHealthcheck(check *container.HealthConfig) string {
	if check == nil || len(check.Test) == 0 {
		return ""
	}
	payload, err := json.Marshal(check.Test)
	if err != nil {
		return ""
	}
	// Apple container labels reject "=" padding in values.
	return base64.RawStdEncoding.EncodeToString(payload)
}

func decodeHealthcheck(encoded string) ([]string, error) {
	var payload []byte
	var err error
	for _, value := range []string{encoded, strings.TrimRight(encoded, "=")} {
		payload, err = base64.StdEncoding.DecodeString(value)
		if err == nil {
			break
		}
		payload, err = base64.RawStdEncoding.DecodeString(value)
		if err == nil {
			break
		}
		payload, err = base64.URLEncoding.DecodeString(value)
		if err == nil {
			break
		}
		payload, err = base64.RawURLEncoding.DecodeString(value)
		if err == nil {
			break
		}
	}
	if err != nil {
		return nil, err
	}
	var test []string
	if err := json.Unmarshal(payload, &test); err != nil {
		return nil, err
	}
	return test, nil
}

// The runtime dispatcher functions below use a simple if/else pattern rather
// than an interface because:
//   - There are only two runtimes (Docker, Apple Container).
//   - Each Apple implementation is a thin wrapper around the `container` CLI,
//     keeping the logic co-located and easy to follow.
//   - An interface would require threading a runtime instance through many
//     call sites that currently use package-level helpers.

func DockerStart(ctx context.Context, config container.Config, hostConfig container.HostConfig, networkingConfig network.NetworkingConfig, containerName string) (string, error) {
	if UsesAppleContainerRuntime() {
		return appleStart(ctx, config, hostConfig, networkingConfig, containerName)
	}
	return dockerStart(ctx, config, hostConfig, networkingConfig, containerName)
}

func DockerRemoveAll(ctx context.Context, w io.Writer, projectId string) error {
	if UsesAppleContainerRuntime() {
		return appleRemoveAll(ctx, w, projectId)
	}
	return dockerRemoveAll(ctx, w, projectId)
}

func DockerRemove(containerId string) {
	if UsesAppleContainerRuntime() {
		_ = appleRemoveContainer(context.Background(), containerId, true)
		return
	}
	dockerRemove(containerId)
}

func DockerRunOnceWithConfig(ctx context.Context, config container.Config, hostConfig container.HostConfig, networkingConfig network.NetworkingConfig, containerName string, stdout, stderr io.Writer) error {
	if UsesAppleContainerRuntime() {
		return appleRunOnceWithConfig(ctx, config, hostConfig, networkingConfig, containerName, stdout, stderr)
	}
	return dockerRunOnceWithConfig(ctx, config, hostConfig, networkingConfig, containerName, stdout, stderr)
}

func DockerStreamLogs(ctx context.Context, containerId string, stdout, stderr io.Writer, opts ...func(*container.LogsOptions)) error {
	if UsesAppleContainerRuntime() {
		return appleStreamLogs(ctx, containerId, stdout, stderr)
	}
	return dockerStreamLogs(ctx, containerId, stdout, stderr, opts...)
}

func DockerStreamLogsOnce(ctx context.Context, containerId string, stdout, stderr io.Writer) error {
	if UsesAppleContainerRuntime() {
		return appleStreamLogsOnce(ctx, containerId, stdout, stderr)
	}
	return dockerStreamLogsOnce(ctx, containerId, stdout, stderr)
}

func DockerExecOnceWithStream(ctx context.Context, containerId, workdir string, env, cmd []string, stdout, stderr io.Writer) error {
	if UsesAppleContainerRuntime() {
		return appleExecOnceWithStream(ctx, containerId, workdir, env, cmd, stdout, stderr)
	}
	return dockerExecOnceWithStream(ctx, containerId, workdir, env, cmd, stdout, stderr)
}

func RemoveContainer(ctx context.Context, containerId string, removeVolumes, force bool) error {
	if UsesAppleContainerRuntime() {
		return appleRemoveContainer(ctx, containerId, force)
	}
	return Docker.ContainerRemove(ctx, containerId, container.RemoveOptions{
		RemoveVolumes: removeVolumes,
		Force:         force,
	})
}

func RemoveVolume(ctx context.Context, volumeName string, force bool) error {
	if UsesAppleContainerRuntime() {
		return appleRemoveVolume(ctx, volumeName, force)
	}
	return Docker.VolumeRemove(ctx, volumeName, force)
}

func RestartContainer(ctx context.Context, containerId string) error {
	if UsesAppleContainerRuntime() {
		return appleRestartContainer(ctx, containerId)
	}
	return Docker.ContainerRestart(ctx, containerId, container.StopOptions{})
}

func InspectContainer(ctx context.Context, containerId string) (ContainerInfo, error) {
	if UsesAppleContainerRuntime() {
		return appleInspectContainer(ctx, containerId)
	}
	resp, err := Docker.ContainerInspect(ctx, containerId)
	if err != nil {
		return ContainerInfo{}, err
	}
	name := ""
	if resp.ContainerJSONBase != nil {
		name = resp.Name
	}
	info := ContainerInfo{
		ID:         name,
		Labels:     map[string]string{},
		Status:     "",
		Running:    false,
		Names:      nil,
		NetworkIPs: map[string]string{},
	}
	if len(name) > 0 {
		info.Names = []string{name}
	}
	if len(info.ID) > 0 && info.ID[0] == '/' {
		info.ID = info.ID[1:]
		info.Names = []string{name}
	}
	if resp.Config != nil && resp.Config.Labels != nil {
		info.Labels = resp.Config.Labels
	}
	if resp.ContainerJSONBase != nil && resp.State != nil {
		info.Status = resp.State.Status
		info.Running = resp.State.Running
		if resp.State.Health != nil {
			info.HealthStatus = resp.State.Health.Status
		}
	}
	if resp.NetworkSettings != nil {
		for name, details := range resp.NetworkSettings.Networks {
			if details != nil && len(details.IPAddress) > 0 {
				info.NetworkIPs[name] = details.IPAddress
			}
		}
	}
	if len(resp.Mounts) > 0 {
		info.Mounts = make([]ContainerMount, 0, len(resp.Mounts))
		for _, m := range resp.Mounts {
			info.Mounts = append(info.Mounts, ContainerMount{
				Source:   m.Name,
				Target:   m.Destination,
				Type:     string(m.Type),
				ReadOnly: !m.RW,
			})
		}
	}
	return info, nil
}

func GetContainerIP(ctx context.Context, containerId, networkName string) (string, error) {
	info, err := InspectContainer(ctx, containerId)
	if err != nil {
		return "", err
	}
	if len(networkName) > 0 {
		if ip, ok := info.NetworkIPs[networkName]; ok && len(ip) > 0 {
			return strings.TrimSuffix(ip, "/24"), nil
		}
	}
	for _, ip := range info.NetworkIPs {
		if len(ip) > 0 {
			return strings.TrimSuffix(ip, "/24"), nil
		}
	}
	return "", errors.Errorf("failed to detect IP address for container: %s", containerId)
}

func ListContainers(ctx context.Context, all bool) ([]ContainerInfo, error) {
	if UsesAppleContainerRuntime() {
		return appleListContainers(ctx, all)
	}
	resp, err := Docker.ContainerList(ctx, container.ListOptions{All: all})
	if err != nil {
		return nil, err
	}
	result := make([]ContainerInfo, 0, len(resp))
	for _, item := range resp {
		id := item.ID
		if len(id) == 0 && len(item.Names) > 0 {
			id = item.Names[0]
		}
		if len(id) > 0 && id[0] == '/' {
			id = id[1:]
		}
		result = append(result, ContainerInfo{
			ID:      id,
			Names:   item.Names,
			Labels:  item.Labels,
			Status:  item.State,
			Running: item.State == "running",
		})
	}
	return result, nil
}

func ListVolumes(ctx context.Context) ([]VolumeInfo, error) {
	if UsesAppleContainerRuntime() {
		return appleListVolumes(ctx)
	}
	resp, err := Docker.VolumeList(ctx, volume.ListOptions{})
	if err != nil {
		return nil, err
	}
	result := make([]VolumeInfo, 0, len(resp.Volumes))
	for _, item := range resp.Volumes {
		result = append(result, VolumeInfo{Name: item.Name, Labels: item.Labels})
	}
	return result, nil
}

func ListNetworks(ctx context.Context) ([]NetworkInfo, error) {
	if UsesAppleContainerRuntime() {
		resp, err := appleListNetworks(ctx)
		if err != nil {
			return nil, err
		}
		result := make([]NetworkInfo, 0, len(resp))
		for _, item := range resp {
			result = append(result, NetworkInfo{Name: item.ID, Labels: item.Config.Labels})
		}
		return result, nil
	}
	resp, err := Docker.NetworkList(ctx, network.ListOptions{})
	if err != nil {
		return nil, err
	}
	result := make([]NetworkInfo, 0, len(resp))
	for _, item := range resp {
		result = append(result, NetworkInfo{Name: item.Name, Labels: item.Labels})
	}
	return result, nil
}

func VolumeExists(ctx context.Context, name string) (bool, error) {
	if UsesAppleContainerRuntime() {
		return appleVolumeExists(ctx, name)
	}
	if _, err := Docker.VolumeInspect(ctx, name); err == nil {
		return true, nil
	} else if errdefs.IsNotFound(err) {
		return false, nil
	} else {
		return false, err
	}
}

func AssertServiceHealthy(ctx context.Context, containerId string) error {
	info, err := InspectContainer(ctx, containerId)
	if err != nil {
		if errdefs.IsNotFound(err) {
			return errors.New(ErrNotRunning)
		}
		if client.IsErrConnectionFailed(err) {
			if UsesAppleContainerRuntime() {
				CmdSuggestion = suggestAppleContainerInstall
			} else {
				CmdSuggestion = suggestDockerInstall
			}
		}
		return errors.Errorf("failed to inspect service: %w", err)
	}
	if !info.Running {
		return errors.Errorf("%s container is not running: %s", containerId, info.Status)
	}
	if UsesAppleContainerRuntime() {
		if encoded, ok := info.Labels[healthcheckLabel]; ok && len(encoded) > 0 {
			test, err := decodeHealthcheck(encoded)
			if err != nil {
				return errors.Errorf("failed to decode service healthcheck: %w", err)
			}
			if err := appleRunHealthcheck(ctx, containerId, test); err != nil {
				return errors.Errorf("%s container is not ready: %w", containerId, err)
			}
		}
		return nil
	}
	if len(info.HealthStatus) > 0 && info.HealthStatus != types.Healthy {
		return errors.Errorf("%s container is not ready: %s", containerId, info.HealthStatus)
	}
	return nil
}

func ListProjectVolumes(ctx context.Context, projectId string) ([]VolumeInfo, error) {
	volumes, err := ListVolumes(ctx)
	if err != nil {
		return nil, err
	}
	var result []VolumeInfo
	for _, item := range volumes {
		if matchesProjectLabel(item.Labels, projectId) || matchesProjectName(item.Name, projectId) {
			result = append(result, item)
		}
	}
	return result, nil
}

func ListProjectNetworks(ctx context.Context, projectId string) ([]NetworkInfo, error) {
	networks, err := ListNetworks(ctx)
	if err != nil {
		return nil, err
	}
	var result []NetworkInfo
	for _, item := range networks {
		if matchesProjectLabel(item.Labels, projectId) || matchesProjectName(item.Name, projectId) {
			result = append(result, item)
		}
	}
	return result, nil
}

func ListProjectContainers(ctx context.Context, projectId string, all bool) ([]ContainerInfo, error) {
	containers, err := ListContainers(ctx, all)
	if err != nil {
		return nil, err
	}
	var result []ContainerInfo
	for _, item := range containers {
		if matchesProjectLabel(item.Labels, projectId) || matchesProjectContainer(item, projectId) {
			result = append(result, item)
		}
	}
	return result, nil
}

func matchesProjectLabel(labels map[string]string, projectId string) bool {
	if len(labels) == 0 {
		return false
	}
	value, ok := labels[CliProjectLabel]
	if !ok {
		return false
	}
	return len(projectId) == 0 || value == projectId
}

func matchesProjectContainer(info ContainerInfo, projectId string) bool {
	if matchesProjectName(info.ID, projectId) {
		return true
	}
	for _, name := range info.Names {
		if matchesProjectName(name, projectId) {
			return true
		}
	}
	return false
}

func matchesProjectName(name, projectId string) bool {
	if len(projectId) == 0 || len(name) == 0 {
		return false
	}
	trimmed := strings.TrimPrefix(name, "/")
	return strings.HasSuffix(trimmed, "_"+projectId) || strings.HasSuffix(trimmed, "-"+projectId)
}

func filterProjectVolumes(volumes []VolumeInfo, projectId string) []VolumeInfo {
	var result []VolumeInfo
	for _, item := range volumes {
		if matchesProjectLabel(item.Labels, projectId) {
			result = append(result, item)
		}
	}
	return result
}

func filterProjectContainers(containers []ContainerInfo, projectId string) []ContainerInfo {
	var result []ContainerInfo
	for _, item := range containers {
		if matchesProjectLabel(item.Labels, projectId) {
			result = append(result, item)
		}
	}
	return result
}
