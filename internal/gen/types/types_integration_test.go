package types

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/containerd/errdefs"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/go-connections/nat"
	"github.com/jackc/pgx/v4"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/utils"
)

// TestGetRootCA_SSLProbeAgainstRealPostgres verifies that isRequireSSL and GetRootCA
// work correctly when connecting to a real Postgres instance with SSL enabled (certificate
// signed by a CA not in the system trust store). This reproduces the "x509: certificate
// signed by unknown authority" failure that affected db pull against Supabase poolers.
func TestGetRootCA_SSLProbeAgainstRealPostgres(t *testing.T) {
	ctx := context.Background()
	if !utils.IsDockerRunning(ctx) {
		t.Skip("Docker is not running, skipping SSL probe integration test")
	}

	// Generate self-signed CA and server certificate so Postgres uses TLS with
	// a cert not in the system CA store (same situation as Supabase pooler).
	tmpDir := t.TempDir()
	_, serverCertPEM, serverKeyPEM, err := generateTestCertificates()
	require.NoError(t, err)

	serverCertPath := filepath.Join(tmpDir, "server.crt")
	serverKeyPath := filepath.Join(tmpDir, "server.key")
	require.NoError(t, os.WriteFile(serverCertPath, serverCertPEM, 0600))
	require.NoError(t, os.WriteFile(serverKeyPath, serverKeyPEM, 0600))

	// Use postgres:15 from Docker Hub (no registry transform).
	const postgresImage = "postgres:15"
	if _, err := utils.Docker.ImageInspect(ctx, postgresImage); err != nil {
		if errdefs.IsNotFound(err) {
			out, pullErr := utils.Docker.ImagePull(ctx, postgresImage, image.PullOptions{})
			require.NoError(t, pullErr)
			_, _ = io.Copy(io.Discard, out)
			_ = out.Close()
		} else {
			require.NoError(t, err)
		}
	}

	// Use a fixed port for the test; avoid conflicts by using a high port.
	hostPort := "15433"
	config := container.Config{
		Image: postgresImage,
		Env:   []string{"POSTGRES_PASSWORD=test"},
		Cmd: []string{
			"postgres",
			"-c", "ssl=on",
			"-c", "ssl_cert_file=/ssl/server.crt",
			"-c", "ssl_key_file=/ssl/server.key",
		},
	}
	hostConfig := container.HostConfig{
		Binds:        []string{tmpDir + ":/ssl:ro"},
		PortBindings: nat.PortMap{"5432/tcp": []nat.PortBinding{{HostPort: hostPort}}},
		AutoRemove:   true,
	}
	// Create and start container manually so we can use docker.io/postgres:15
	// without going through the registry URL transform.
	created, err := utils.Docker.ContainerCreate(ctx, &config, &hostConfig, nil, nil, "")
	require.NoError(t, err)
	containerID := created.ID
	defer func() {
		_ = utils.Docker.ContainerStop(ctx, containerID, container.StopOptions{})
	}()
	require.NoError(t, utils.Docker.ContainerStart(ctx, containerID, container.StartOptions{}))

	// Wait for Postgres to accept connections.
	dbURL := fmt.Sprintf("postgres://postgres:test@127.0.0.1:%s/postgres?connect_timeout=5", hostPort)
	require.Eventually(t, func() bool {
		conn, err := utils.ConnectByUrl(ctx, dbURL+"&sslmode=disable")
		if err != nil {
			return false
		}
		_ = conn.Close(ctx)
		return true
	}, 15*time.Second, 500*time.Millisecond, "postgres did not become ready")

	// Force certificate verification in this test to avoid relying on pgx/libpq
	// sslmode=require defaults. The pool intentionally excludes the test CA.
	forceVerifyOpt := func(cc *pgx.ConnConfig) {
		if cc.TLSConfig == nil {
			return
		}
		pool, poolErr := x509.SystemCertPool()
		if poolErr != nil || pool == nil {
			pool = x509.NewCertPool()
		}
		cc.TLSConfig.RootCAs = pool
		cc.TLSConfig.InsecureSkipVerify = false
	}
	// Sanity check: requiring ssl with forced verification should fail against
	// our test server cert when bypass is not applied.
	_, err = utils.ConnectByUrl(ctx, dbURL+"&sslmode=require", forceVerifyOpt)
	require.Error(t, err)

	// Probe with sslmode=require. With the fix, the probe appends
	// InsecureSkipVerify=true and succeeds; without the fix this will fail.
	requireSSL, err := isRequireSSL(ctx, dbURL, forceVerifyOpt)
	require.NoError(t, err)
	require.True(t, requireSSL, "isRequireSSL should detect TLS and return true")

	// GetRootCA should return the bundled Supabase CA bundle (so that downstream
	// migra/pgdelta can verify the connection). The probe must succeed for this to run.
	ca, err := GetRootCA(ctx, dbURL, forceVerifyOpt)
	require.NoError(t, err)
	require.NotEmpty(t, ca, "GetRootCA should return the CA bundle when SSL is required")

	// Ensure the returned bundle looks like PEM (for downstream use).
	require.Contains(t, ca, "-----BEGIN CERTIFICATE-----")
}

func generateTestCertificates() (caPEM, serverCertPEM, serverKeyPEM []byte, err error) {
	// Generate CA key and cert.
	caKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, nil, nil, err
	}
	caTemplate := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{Organization: []string{"Test CA"}},
		NotBefore:             time.Now(),
		NotAfter:              time.Now().Add(24 * time.Hour),
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
	}
	caCertDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
	if err != nil {
		return nil, nil, nil, err
	}
	caPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caCertDER})

	// Generate server key and cert signed by CA.
	serverKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, nil, nil, err
	}
	serverTemplate := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{Organization: []string{"Test Server"}},
		NotBefore:    time.Now(),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses:  []net.IP{net.IPv4(127, 0, 0, 1)},
		DNSNames:     []string{"localhost", "127.0.0.1"},
	}
	caCert, _ := x509.ParseCertificate(caCertDER)
	serverCertDER, err := x509.CreateCertificate(rand.Reader, serverTemplate, caCert, &serverKey.PublicKey, caKey)
	if err != nil {
		return nil, nil, nil, err
	}
	serverCertPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: serverCertDER})
	serverKeyPEM = pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(serverKey)})
	return caPEM, serverCertPEM, serverKeyPEM, nil
}
