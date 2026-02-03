package remote

import (
	"context"
	"fmt"
	"io"
	"net"
	"sync"
	"time"

	"github.com/go-errors/errors"
	"golang.org/x/crypto/ssh"
)

// SSHClient wraps an SSH connection with helpers for Docker and port forwarding
type SSHClient struct {
	client *ssh.Client
	config *ssh.ClientConfig
	addr   string
	mu     sync.Mutex
}

// SSHConfig holds SSH connection parameters
type SSHConfig struct {
	Host       string
	Port       int
	Username   string
	PrivateKey string
}

// NewSSHClient creates a new SSH client from the given config
func NewSSHClient(config SSHConfig) (*SSHClient, error) {
	var authMethods []ssh.AuthMethod

	if config.PrivateKey != "" {
		// Use private key auth
		signer, err := ssh.ParsePrivateKey([]byte(config.PrivateKey))
		if err != nil {
			return nil, errors.Errorf("failed to parse private key: %w", err)
		}
		authMethods = append(authMethods, ssh.PublicKeys(signer))
	} else {
		// Daytona uses token-based auth - the token IS the username
		// Try keyboard-interactive with no responses (token auth)
		authMethods = append(authMethods, ssh.KeyboardInteractive(
			func(user, instruction string, questions []string, echos []bool) (answers []string, err error) {
				return []string{}, nil
			},
		))
		// Also try password auth with empty password as fallback
		authMethods = append(authMethods, ssh.Password(""))
	}

	sshConfig := &ssh.ClientConfig{
		User:            config.Username,
		Auth:            authMethods,
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), // TODO: implement proper host key verification
		Timeout:         30 * time.Second,
	}

	addr := fmt.Sprintf("%s:%d", config.Host, config.Port)

	client, err := ssh.Dial("tcp", addr, sshConfig)
	if err != nil {
		return nil, errors.Errorf("failed to connect via SSH: %w", err)
	}

	return &SSHClient{
		client: client,
		config: sshConfig,
		addr:   addr,
	}, nil
}

// Close closes the SSH connection
func (s *SSHClient) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.client != nil {
		return s.client.Close()
	}
	return nil
}

// DialDockerStdio creates a connection to the remote Docker daemon using dial-stdio
// This mirrors how the Docker CLI handles ssh:// hosts
func (s *SSHClient) DialDockerStdio(ctx context.Context) (net.Conn, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	session, err := s.client.NewSession()
	if err != nil {
		return nil, errors.Errorf("failed to create SSH session: %w", err)
	}

	stdin, err := session.StdinPipe()
	if err != nil {
		session.Close()
		return nil, errors.Errorf("failed to get stdin pipe: %w", err)
	}

	stdout, err := session.StdoutPipe()
	if err != nil {
		session.Close()
		return nil, errors.Errorf("failed to get stdout pipe: %w", err)
	}

	// Start docker system dial-stdio on the remote
	if err := session.Start("docker system dial-stdio"); err != nil {
		session.Close()
		return nil, errors.Errorf("failed to start dial-stdio: %w", err)
	}

	return &stdioConn{
		Reader:  stdout,
		Writer:  stdin,
		session: session,
	}, nil
}

// ForwardPort creates a local port forward to the remote host
// Local connections to localAddr will be forwarded to remoteAddr on the remote host
func (s *SSHClient) ForwardPort(ctx context.Context, localAddr, remoteAddr string) error {
	listener, err := net.Listen("tcp", localAddr)
	if err != nil {
		return errors.Errorf("failed to listen on %s: %w", localAddr, err)
	}

	go func() {
		<-ctx.Done()
		listener.Close()
	}()

	go func() {
		for {
			localConn, err := listener.Accept()
			if err != nil {
				// Listener closed
				return
			}

			go s.handleForward(localConn, remoteAddr)
		}
	}()

	return nil
}

func (s *SSHClient) handleForward(localConn net.Conn, remoteAddr string) {
	defer localConn.Close()

	remoteConn, err := s.client.Dial("tcp", remoteAddr)
	if err != nil {
		fmt.Printf("Failed to connect to remote %s: %v\n", remoteAddr, err)
		return
	}
	defer remoteConn.Close()

	// Bidirectional copy
	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		io.Copy(remoteConn, localConn)
	}()

	go func() {
		defer wg.Done()
		io.Copy(localConn, remoteConn)
	}()

	wg.Wait()
}

// Exec runs a command on the remote host and returns the output
func (s *SSHClient) Exec(ctx context.Context, cmd string) (string, error) {
	session, err := s.client.NewSession()
	if err != nil {
		return "", errors.Errorf("failed to create SSH session: %w", err)
	}
	defer session.Close()

	output, err := session.CombinedOutput(cmd)
	if err != nil {
		return string(output), errors.Errorf("command failed: %w", err)
	}

	return string(output), nil
}
