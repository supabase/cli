package remote

import (
	"io"
	"net"
	"time"

	"golang.org/x/crypto/ssh"
)

// stdioConn wraps stdin/stdout pipes as a net.Conn
// This is used to communicate with Docker via docker system dial-stdio
type stdioConn struct {
	io.Reader
	io.Writer
	session *ssh.Session
}

// Close closes the underlying SSH session
func (c *stdioConn) Close() error {
	if c.session != nil {
		return c.session.Close()
	}
	return nil
}

// LocalAddr returns a dummy local address
func (c *stdioConn) LocalAddr() net.Addr {
	return &net.UnixAddr{Name: "stdio", Net: "stdio"}
}

// RemoteAddr returns a dummy remote address
func (c *stdioConn) RemoteAddr() net.Addr {
	return &net.UnixAddr{Name: "docker", Net: "stdio"}
}

// SetDeadline is a no-op for stdio connections
func (c *stdioConn) SetDeadline(t time.Time) error {
	return nil
}

// SetReadDeadline is a no-op for stdio connections
func (c *stdioConn) SetReadDeadline(t time.Time) error {
	return nil
}

// SetWriteDeadline is a no-op for stdio connections
func (c *stdioConn) SetWriteDeadline(t time.Time) error {
	return nil
}

// Verify stdioConn implements net.Conn
var _ net.Conn = (*stdioConn)(nil)
