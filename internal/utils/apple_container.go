package utils

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/containerd/errdefs"
	"github.com/docker/cli/cli/compose/loader"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/go-connections/nat"
	"github.com/go-errors/errors"
)

const suggestAppleContainerInstall = "Apple's container CLI is a prerequisite for the apple-container runtime. Install it and run `container system start` first."

var execContainerCommand = exec.CommandContext

const (
	appleResourceReadyInterval = 100 * time.Millisecond
	appleResourceReadyTimeout  = 5 * time.Second
)

type appleContainerConfig struct {
	ID     string             `json:"id"`
	Labels map[string]string  `json:"labels"`
	Mounts []appleMountRecord `json:"mounts"`
}

type appleMountRecord struct {
	Source      string          `json:"source"`
	Target      string          `json:"target"`
	Destination string          `json:"destination"`
	Type        json.RawMessage `json:"type"`
	ReadOnly    bool            `json:"readOnly"`
	Options     []string        `json:"options"`
}

type appleContainerRecord struct {
	Configuration appleContainerConfig `json:"configuration"`
	Status        string               `json:"status"`
	Networks      []struct {
		Network     string `json:"network"`
		IPv4Address string `json:"ipv4Address"`
	} `json:"networks"`
}

type appleVolumeRecord struct {
	Name   string            `json:"name"`
	Labels map[string]string `json:"labels"`
}

type appleNetworkRecord struct {
	ID     string `json:"id"`
	Config struct {
		Labels map[string]string `json:"labels"`
	} `json:"config"`
}

func appleStart(ctx context.Context, config container.Config, hostConfig container.HostConfig, networkingConfig network.NetworkingConfig, containerName string) (string, error) {
	args, err := buildAppleContainerArgs(ctx, config, hostConfig, networkingConfig, containerName, true, false)
	if err != nil {
		return "", err
	}
	output, err := runContainerCommandOutput(ctx, args...)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(output), nil
}

func appleRunOnceWithConfig(ctx context.Context, config container.Config, hostConfig container.HostConfig, networkingConfig network.NetworkingConfig, containerName string, stdout, stderr io.Writer) error {
	args, err := buildAppleContainerArgs(ctx, config, hostConfig, networkingConfig, containerName, false, true)
	if err != nil {
		return err
	}
	return runContainerCommand(ctx, stdout, stderr, args...)
}

func appleExecOnceWithStream(ctx context.Context, containerId, workdir string, env, cmd []string, stdout, stderr io.Writer) error {
	args := []string{"exec"}
	for _, item := range env {
		args = append(args, "--env", item)
	}
	if len(workdir) > 0 {
		args = append(args, "--workdir", workdir)
	}
	args = append(args, containerId)
	args = append(args, cmd...)
	return runContainerCommand(ctx, stdout, stderr, args...)
}

func appleStreamLogs(ctx context.Context, containerId string, stdout, stderr io.Writer) error {
	return runContainerCommand(ctx, stdout, stderr, "logs", "--follow", containerId)
}

func appleStreamLogsOnce(ctx context.Context, containerId string, stdout, stderr io.Writer) error {
	return runContainerCommand(ctx, stdout, stderr, "logs", containerId)
}

func appleRemoveContainer(ctx context.Context, containerId string, force bool) error {
	args := []string{"delete"}
	if force {
		args = append(args, "--force")
	}
	args = append(args, containerId)
	if _, err := runContainerCommandOutput(ctx, args...); err != nil {
		if isAppleNotFound(err) {
			return errdefs.ErrNotFound
		}
		return err
	}
	return nil
}

func appleRemoveVolume(ctx context.Context, volumeName string, force bool) error {
	return appleRemoveVolumeWithRun(ctx, volumeName, force, runContainerCommandOutput)
}

func appleRemoveVolumeWithRun(ctx context.Context, volumeName string, force bool, run func(context.Context, ...string) (string, error)) error {
	args := []string{"volume", "delete"}
	// Apple container CLI does not support force-delete for volumes.
	_ = force
	args = append(args, volumeName)
	if _, err := run(ctx, args...); err != nil {
		if isAppleNotFound(err) {
			return errdefs.ErrNotFound
		}
		return err
	}
	return nil
}

func appleRestartContainer(ctx context.Context, containerId string) error {
	return appleRestartContainerWithRun(ctx, containerId, runContainerCommandOutput)
}

func appleRestartContainerWithRun(ctx context.Context, containerId string, run func(context.Context, ...string) (string, error)) error {
	if _, err := run(ctx, "stop", containerId); err != nil {
		if isAppleNotFound(err) {
			return errdefs.ErrNotFound
		}
		return err
	}
	if _, err := run(ctx, "start", containerId); err != nil {
		if isAppleNotFound(err) {
			return errdefs.ErrNotFound
		}
		return err
	}
	return nil
}

func appleInspectContainer(ctx context.Context, containerId string) (ContainerInfo, error) {
	output, err := runContainerCommandOutput(ctx, "inspect", containerId)
	if err != nil {
		if isAppleNotFound(err) {
			return ContainerInfo{}, errdefs.ErrNotFound
		}
		return ContainerInfo{}, err
	}
	var records []appleContainerRecord
	if err := json.Unmarshal([]byte(output), &records); err != nil {
		return ContainerInfo{}, errors.Errorf("failed to decode container inspect: %w", err)
	}
	if len(records) == 0 {
		return ContainerInfo{}, errdefs.ErrNotFound
	}
	item := records[0]
	info := ContainerInfo{
		ID:         item.Configuration.ID,
		Names:      []string{item.Configuration.ID},
		Labels:     item.Configuration.Labels,
		Status:     item.Status,
		Running:    item.Status == "running",
		Mounts:     make([]ContainerMount, 0, len(item.Configuration.Mounts)),
		NetworkIPs: map[string]string{},
	}
	for _, network := range item.Networks {
		if len(network.Network) > 0 && len(network.IPv4Address) > 0 {
			info.NetworkIPs[network.Network] = strings.TrimSuffix(network.IPv4Address, "/24")
		}
	}
	for _, m := range item.Configuration.Mounts {
		info.Mounts = append(info.Mounts, ContainerMount{
			Source:   m.Source,
			Target:   m.mountTarget(),
			Type:     m.mountType(),
			ReadOnly: m.isReadOnly(),
		})
	}
	return info, nil
}

func appleListContainers(ctx context.Context, all bool) ([]ContainerInfo, error) {
	args := []string{"list", "--format", "json"}
	if all {
		args = append(args, "--all")
	}
	output, err := runContainerCommandOutput(ctx, args...)
	if err != nil {
		return nil, err
	}
	var records []appleContainerRecord
	if err := json.Unmarshal([]byte(output), &records); err != nil {
		return nil, errors.Errorf("failed to decode container list: %w", err)
	}
	result := make([]ContainerInfo, 0, len(records))
	for _, item := range records {
		info := ContainerInfo{
			ID:         item.Configuration.ID,
			Names:      []string{item.Configuration.ID},
			Labels:     item.Configuration.Labels,
			Status:     item.Status,
			Running:    item.Status == "running",
			NetworkIPs: map[string]string{},
		}
		for _, network := range item.Networks {
			if len(network.Network) > 0 && len(network.IPv4Address) > 0 {
				info.NetworkIPs[network.Network] = strings.TrimSuffix(network.IPv4Address, "/24")
			}
		}
		result = append(result, info)
	}
	return result, nil
}

func appleListVolumes(ctx context.Context) ([]VolumeInfo, error) {
	output, err := runContainerCommandOutput(ctx, "volume", "list", "--format", "json")
	if err != nil {
		return nil, err
	}
	var records []appleVolumeRecord
	if err := json.Unmarshal([]byte(output), &records); err != nil {
		return nil, errors.Errorf("failed to decode volume list: %w", err)
	}
	result := make([]VolumeInfo, 0, len(records))
	for _, item := range records {
		result = append(result, VolumeInfo(item))
	}
	return result, nil
}

func appleVolumeExists(ctx context.Context, name string) (bool, error) {
	_, err := runContainerCommandOutput(ctx, "volume", "inspect", name)
	if err == nil {
		return true, nil
	}
	if isAppleNotFound(err) {
		return false, nil
	}
	return false, err
}

func appleRunHealthcheck(ctx context.Context, containerId string, test []string) error {
	if len(test) == 0 {
		return nil
	}
	switch test[0] {
	case "NONE":
		return nil
	case "CMD":
		return appleExecOnceWithStream(ctx, containerId, "", nil, test[1:], io.Discard, io.Discard)
	case "CMD-SHELL":
		command := ""
		if len(test) > 1 {
			command = test[1]
		}
		return appleExecOnceWithStream(ctx, containerId, "", nil, []string{"sh", "-c", command}, io.Discard, io.Discard)
	default:
		return appleExecOnceWithStream(ctx, containerId, "", nil, test, io.Discard, io.Discard)
	}
}

func appleRemoveAll(ctx context.Context, w io.Writer, projectId string) error {
	fmt.Fprintln(w, "Stopping containers...")
	containers, err := appleListContainers(ctx, true)
	if err != nil {
		return errors.Errorf("failed to list containers: %w", err)
	}
	containers = filterProjectContainers(containers, projectId)
	var running []string
	var all []string
	for _, item := range containers {
		all = append(all, item.ID)
		if item.Running {
			running = append(running, item.ID)
		}
	}
	if err := appleStopAndDeleteContainers(ctx, running, all, runContainerCommandOutput); err != nil {
		return err
	}
	if NoBackupVolume {
		volumes, err := appleListVolumes(ctx)
		if err != nil {
			return errors.Errorf("failed to list volumes: %w", err)
		}
		volumes = filterProjectVolumes(volumes, projectId)
		if len(volumes) > 0 {
			args := []string{"volume", "delete"}
			for _, item := range volumes {
				args = append(args, item.Name)
			}
			if _, err := runContainerCommandOutput(ctx, args...); err != nil {
				return errors.Errorf("failed to delete volumes: %w", err)
			}
		}
	}
	networks, err := appleListNetworks(ctx)
	if err != nil {
		return errors.Errorf("failed to list networks: %w", err)
	}
	var networkNames []string
	for _, item := range networks {
		if matchesProjectLabel(item.Config.Labels, projectId) {
			networkNames = append(networkNames, item.ID)
		}
	}
	if len(networkNames) > 0 {
		args := append([]string{"network", "delete"}, networkNames...)
		if _, err := runContainerCommandOutput(ctx, args...); err != nil {
			return errors.Errorf("failed to delete networks: %w", err)
		}
	}
	return nil
}

func appleStopAndDeleteContainers(ctx context.Context, running, all []string, run func(context.Context, ...string) (string, error)) error {
	if len(running) > 0 {
		args := append([]string{"stop"}, running...)
		if _, err := run(ctx, args...); err != nil {
			if len(all) == 0 {
				return errors.Errorf("failed to stop containers: %w", err)
			}
			deleteArgs := append([]string{"delete", "--force"}, all...)
			if _, deleteErr := run(ctx, deleteArgs...); deleteErr != nil {
				return errors.Errorf("failed to stop containers: %v; failed to delete containers: %w", err, deleteErr)
			}
			return nil
		}
	}
	if len(all) > 0 {
		args := append([]string{"delete", "--force"}, all...)
		if _, err := run(ctx, args...); err != nil {
			return errors.Errorf("failed to delete containers: %w", err)
		}
	}
	return nil
}

func appleListNetworks(ctx context.Context) ([]appleNetworkRecord, error) {
	output, err := runContainerCommandOutput(ctx, "network", "list", "--format", "json")
	if err != nil {
		return nil, err
	}
	var records []appleNetworkRecord
	if err := json.Unmarshal([]byte(output), &records); err != nil {
		return nil, errors.Errorf("failed to decode network list: %w", err)
	}
	return records, nil
}

func appleEnsureNetwork(ctx context.Context, name string, labels map[string]string) error {
	if len(name) == 0 || name == "default" {
		return nil
	}
	if output, err := runContainerCommandOutput(ctx, "network", "inspect", name); err == nil {
		if hasAppleInspectRecords(output) {
			return nil
		}
	} else if !isAppleNotFound(err) {
		return err
	}
	args := []string{"network", "create"}
	for _, key := range sortedKeys(labels) {
		args = append(args, "--label", key+"="+labels[key])
	}
	args = append(args, name)
	if _, err := runContainerCommandOutput(ctx, args...); err != nil && !isAppleAlreadyExists(err) {
		return err
	}
	return waitForAppleInspectReady(ctx, "network", "network", "inspect", name)
}

func appleEnsureVolume(ctx context.Context, name string, labels map[string]string) error {
	exists, err := appleVolumeExists(ctx, name)
	if err != nil || exists {
		return err
	}
	args := []string{"volume", "create"}
	for _, key := range sortedKeys(labels) {
		args = append(args, "--label", key+"="+labels[key])
	}
	args = append(args, name)
	_, err = runContainerCommandOutput(ctx, args...)
	return err
}

func appleEnsureImage(ctx context.Context, imageName string) error {
	_, err := runContainerCommandOutput(ctx, "image", "inspect", imageName)
	if err == nil {
		return nil
	}
	if !isAppleImageNotFound(err) {
		return err
	}
	return runContainerCommand(ctx, io.Discard, io.Discard, "image", "pull", imageName)
}

func buildAppleContainerArgs(ctx context.Context, config container.Config, hostConfig container.HostConfig, _ network.NetworkingConfig, containerName string, detach bool, remove bool) ([]string, error) {
	applyContainerLabels(&config)
	imageName := GetRegistryImageUrl(config.Image)
	if err := appleEnsureImage(ctx, imageName); err != nil {
		return nil, err
	}
	args := []string{"run"}
	if detach {
		args = append(args, "--detach")
	}
	if remove {
		args = append(args, "--remove")
	}
	if len(containerName) > 0 {
		args = append(args, "--name", containerName)
	}
	for _, key := range sortedKeys(config.Labels) {
		args = append(args, "--label", key+"="+config.Labels[key])
	}
	for _, item := range config.Env {
		args = append(args, "--env", item)
	}
	if len(config.WorkingDir) > 0 {
		args = append(args, "--workdir", config.WorkingDir)
	}
	if len(config.User) > 0 {
		args = append(args, "--user", config.User)
	}
	if hostConfig.ReadonlyRootfs {
		args = append(args, "--read-only")
	}
	if hostConfig.NanoCPUs > 0 {
		args = append(args, "--cpus", strconv.FormatInt(hostConfig.NanoCPUs/1_000_000_000, 10))
	}
	if hostConfig.Memory > 0 {
		args = append(args, "--memory", strconv.FormatInt(hostConfig.Memory, 10))
	}
	for path := range hostConfig.Tmpfs {
		args = append(args, "--tmpfs", path)
	}
	networkName := hostConfig.NetworkMode.NetworkName()
	if len(networkName) == 0 {
		networkName = NetId
	}
	if err := appleEnsureNetwork(ctx, networkName, config.Labels); err != nil {
		return nil, errors.Errorf("failed to create network: %w", err)
	}
	args = append(args, "--network", networkName)
	mounts, err := buildAppleMounts(ctx, config.Labels, hostConfig)
	if err != nil {
		return nil, err
	}
	for _, item := range mounts {
		args = append(args, "--mount", item)
	}
	for _, item := range buildApplePortBindings(hostConfig.PortBindings) {
		args = append(args, "--publish", item)
	}
	if len(config.Entrypoint) > 0 {
		args = append(args, "--entrypoint", config.Entrypoint[0])
	}
	args = append(args, imageName)
	switch {
	case len(config.Entrypoint) > 0:
		args = append(args, config.Entrypoint[1:]...)
		args = append(args, config.Cmd...)
	default:
		args = append(args, config.Cmd...)
	}
	return args, nil
}

func buildAppleMounts(ctx context.Context, labels map[string]string, hostConfig container.HostConfig) ([]string, error) {
	var result []string
	for _, bind := range hostConfig.Binds {
		spec, err := loader.ParseVolume(bind)
		if err != nil {
			return nil, errors.Errorf("failed to parse docker volume: %w", err)
		}
		mountArg, err := dockerVolumeToAppleMount(ctx, labels, spec.Type, spec.Source, spec.Target, spec.ReadOnly)
		if err != nil {
			return nil, err
		}
		result = append(result, mountArg)
	}
	for _, source := range hostConfig.VolumesFrom {
		info, err := appleInspectContainer(ctx, source)
		if err != nil {
			return nil, errors.Errorf("failed to inspect volumes-from container %s: %w", source, err)
		}
		for _, item := range info.Mounts {
			mountArg := fmt.Sprintf("type=%s,source=%s,target=%s", item.Type, item.Source, item.Target)
			if item.ReadOnly {
				mountArg += ",readonly"
			}
			result = append(result, mountArg)
		}
	}
	return RemoveDuplicates(result), nil
}

func dockerVolumeToAppleMount(ctx context.Context, labels map[string]string, mountType, source, target string, readOnly bool) (string, error) {
	if mountType == "volume" {
		if err := appleEnsureVolume(ctx, source, labels); err != nil {
			return "", errors.Errorf("failed to create volume: %w", err)
		}
	}
	mountArg := fmt.Sprintf("type=%s,source=%s,target=%s", mountType, source, target)
	if readOnly {
		mountArg += ",readonly"
	}
	return mountArg, nil
}

func buildApplePortBindings(bindings nat.PortMap) []string {
	var result []string
	ports := make([]string, 0, len(bindings))
	for port := range bindings {
		ports = append(ports, string(port))
	}
	sort.Strings(ports)
	for _, key := range ports {
		for _, binding := range bindings[nat.Port(key)] {
			spec := ""
			if len(binding.HostIP) > 0 {
				spec += binding.HostIP + ":"
			}
			spec += binding.HostPort + ":" + nat.Port(key).Port()
			if proto := nat.Port(key).Proto(); len(proto) > 0 {
				spec += "/" + proto
			}
			result = append(result, spec)
		}
	}
	return result
}

func runContainerCommand(ctx context.Context, stdout, stderr io.Writer, args ...string) error {
	cmd := execContainerCommand(ctx, "container", args...)
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	if err := cmd.Run(); err != nil {
		return wrapAppleContainerError(err, nil)
	}
	return nil
}

func runContainerCommandOutput(ctx context.Context, args ...string) (string, error) {
	var stdout, stderr bytes.Buffer
	cmd := execContainerCommand(ctx, "container", args...)
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return "", wrapAppleContainerError(err, &stderr)
	}
	return strings.TrimSpace(stdout.String()), nil
}

func wrapAppleContainerError(err error, stderr *bytes.Buffer) error {
	if errors.Is(err, exec.ErrNotFound) {
		CmdSuggestion = suggestAppleContainerInstall
		return errors.Errorf("failed to run apple container CLI: %w", err)
	}
	if stderr == nil || stderr.Len() == 0 {
		return err
	}
	return errors.New(strings.TrimSpace(stderr.String()))
}

func isAppleNotFound(err error) bool {
	msg := err.Error()
	return strings.Contains(msg, "notFound") || strings.Contains(strings.ToLower(msg), "not found")
}

func isAppleImageNotFound(err error) bool {
	msg := err.Error()
	return strings.Contains(msg, "Image not found")
}

func (m appleMountRecord) mountTarget() string {
	if len(m.Target) > 0 {
		return m.Target
	}
	return m.Destination
}

func (m appleMountRecord) mountType() string {
	var kind string
	if err := json.Unmarshal(m.Type, &kind); err == nil {
		return kind
	}
	var typed map[string]json.RawMessage
	if err := json.Unmarshal(m.Type, &typed); err == nil {
		for kind := range typed {
			return kind
		}
	}
	return ""
}

func (m appleMountRecord) isReadOnly() bool {
	if m.ReadOnly {
		return true
	}
	for _, option := range m.Options {
		if strings.EqualFold(option, "readonly") || strings.EqualFold(option, "ro") {
			return true
		}
	}
	return false
}

func isAppleAlreadyExists(err error) bool {
	return strings.Contains(strings.ToLower(err.Error()), "already exists")
}

func hasAppleInspectRecords(output string) bool {
	output = strings.TrimSpace(output)
	if len(output) == 0 || output == "[]" {
		return false
	}
	var values []json.RawMessage
	return json.Unmarshal([]byte(output), &values) == nil && len(values) > 0
}

func waitForAppleInspectReady(ctx context.Context, resource string, args ...string) error {
	return waitForAppleReady(ctx, resource, func() (bool, error) {
		output, err := runContainerCommandOutput(ctx, args...)
		if err != nil {
			if isAppleNotFound(err) {
				return false, nil
			}
			return false, err
		}
		return hasAppleInspectRecords(output), nil
	})
}

func waitForAppleReady(ctx context.Context, resource string, probe func() (bool, error)) error {
	timeoutCtx, cancel := context.WithTimeout(ctx, appleResourceReadyTimeout)
	defer cancel()
	for {
		ready, err := probe()
		if err != nil {
			return err
		}
		if ready {
			return nil
		}
		select {
		case <-timeoutCtx.Done():
			return errors.Errorf("%s was not ready in time: %w", resource, timeoutCtx.Err())
		case <-time.After(appleResourceReadyInterval):
		}
	}
}

func sortedKeys(values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
