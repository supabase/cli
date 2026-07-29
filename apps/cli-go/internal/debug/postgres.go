package debug

import (
	"context"
	"crypto/tls"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"os"
	"time"

	"github.com/jackc/pgproto3/v2"
	"github.com/jackc/pgx/v4"
	"google.golang.org/grpc/test/bufconn"
)

type Proxy struct {
	dialContext func(ctx context.Context, network, addr string) (net.Conn, error)
	// tlsPlan is pgconn's TLS config per attempt, primary first. DialFunc walks it
	// so sslmode=allow keeps its plaintext-then-TLS retry, and completes the
	// handshake itself, leaving logged frames plaintext in memory but not on the wire.
	tlsPlan  []*tls.Config
	attempts map[string]int
	errChan  chan error
}

func NewProxy() Proxy {
	dialer := net.Dialer{}
	return Proxy{
		dialContext: dialer.DialContext,
		attempts:    map[string]int{},
		errChan:     make(chan error, 1),
	}
}

func SetupPGX(config *pgx.ConnConfig) {
	tlsPlan := []*tls.Config{config.TLSConfig}
	for _, fallback := range config.Fallbacks {
		if fallback.Host != config.Host {
			break
		}
		// ConnectByUrl drops plaintext fallbacks once the primary is TLS, and it
		// runs after this, so apply the same rule here or --debug reinstates them.
		if config.TLSConfig != nil && fallback.TLSConfig == nil {
			continue
		}
		tlsPlan = append(tlsPlan, fallback.TLSConfig)
	}
	proxy := Proxy{
		dialContext: config.DialFunc,
		tlsPlan:     tlsPlan,
		attempts:    map[string]int{},
		errChan:     make(chan error, 1),
	}
	config.DialFunc = proxy.DialFunc
	// pgx must not negotiate TLS again over the in-memory pipe; clearing these
	// *without* DialFunc's handshake is what downgraded sslmode=require (#5872).
	config.TLSConfig = nil
	for _, fallback := range config.Fallbacks {
		fallback.TLSConfig = nil
	}
}

// nextTLSConfig returns the TLS config for this attempt against addr. pgconn dials
// each plan entry once per resolved address, in plan order, so a per-address
// counter replays the same TLS/plaintext sequence it would have used itself.
func (p *Proxy) nextTLSConfig(addr string) *tls.Config {
	if p.attempts == nil {
		p.attempts = map[string]int{}
	}
	if len(p.tlsPlan) == 0 {
		return nil
	}
	i := p.attempts[addr]
	p.attempts[addr]++
	// pgconn redials an addr for the target_session_attrs retry, so clamp rather
	// than fall off the plan into plaintext.
	if i >= len(p.tlsPlan) {
		i = len(p.tlsPlan) - 1
	}
	return p.tlsPlan[i]
}

func (p *Proxy) DialFunc(ctx context.Context, network, addr string) (net.Conn, error) {
	tlsConfig := p.nextTLSConfig(addr)
	serverConn, err := p.dialContext(ctx, network, addr)
	if err != nil {
		return nil, err
	}
	if tlsConfig != nil {
		if serverConn, err = startTLS(ctx, serverConn, tlsConfig); err != nil {
			return nil, err
		}
	}

	const bufSize = 1024 * 1024
	ln := bufconn.Listen(bufSize)
	go func() {
		defer serverConn.Close()
		clientConn, err := ln.Accept()
		if err != nil {
			// Unreachable code as bufconn never throws, but just in case
			panic(err)
		}
		defer clientConn.Close()

		backend := NewBackend(clientConn)
		frontend := NewFrontend(serverConn)
		go backend.forward(frontend, p.errChan)
		go frontend.forward(backend, p.errChan)

		for {
			if err := <-p.errChan; err != nil &&
				// Since pgx closes connection first, every EOF is seen as unexpected
				!errors.Is(err, io.ErrUnexpectedEOF) &&
				// Frontend might receive a reply after pgx closes the connection, in
				// which case the backend will write to a closed pipe. So ignore.
				!errors.Is(err, io.ErrClosedPipe) {
				panic(err)
			}
		}
	}()

	return ln.DialContext(ctx)
}

// libpq's SSLRequest message code, PG_PROTOCOL(1234,5679).
const sslRequestCode = 80877103

// startTLS mirrors pgconn's own startTLS (pgconn@v1.14.3/pgconn.go:406-419), but
// handshakes eagerly so a refusal or bad certificate fails the dial rather than
// surfacing as a parse error inside the forwarding goroutines.
func startTLS(ctx context.Context, conn net.Conn, tlsConfig *tls.Config) (net.Conn, error) {
	// pgconn only watches ctx once DialFunc returns, so bound the negotiation here
	// or an endpoint that accepts TCP and never replies hangs the read forever.
	if deadline, ok := ctx.Deadline(); ok {
		if err := conn.SetDeadline(deadline); err != nil {
			conn.Close()
			return nil, err
		}
		defer func() { _ = conn.SetDeadline(time.Time{}) }()
	}
	if err := binary.Write(conn, binary.BigEndian, []int32{8, sslRequestCode}); err != nil {
		conn.Close()
		return nil, err
	}
	response := make([]byte, 1)
	if _, err := io.ReadFull(conn, response); err != nil {
		conn.Close()
		return nil, err
	}
	if response[0] != 'S' {
		conn.Close()
		return nil, errors.New("server refused TLS connection")
	}
	tlsConn := tls.Client(conn, tlsConfig)
	if err := tlsConn.HandshakeContext(ctx); err != nil {
		conn.Close()
		return nil, err
	}
	return tlsConn, nil
}

type Backend struct {
	*pgproto3.Backend
	logger *log.Logger
}

func NewBackend(clientConn net.Conn) Backend {
	return Backend{
		pgproto3.NewBackend(pgproto3.NewChunkReader(clientConn), clientConn),
		log.New(os.Stderr, "PG Recv: ", log.LstdFlags|log.Lmsgprefix),
	}
}

func (b *Backend) forward(frontend Frontend, errChan chan error) {
	startupMessage, err := b.ReceiveStartupMessage()
	if err != nil {
		errChan <- err
		return
	}

	buf, err := json.Marshal(startupMessage)
	if err != nil {
		errChan <- err
		return
	}
	frontend.logger.Println(string(buf))

	if err = frontend.Send(startupMessage); err != nil {
		errChan <- err
		return
	}

	for {
		msg, err := b.Receive()
		if err != nil {
			errChan <- err
			return
		}

		buf, err := json.Marshal(msg)
		if err != nil {
			errChan <- err
			return
		}
		frontend.logger.Println(string(buf))

		if err = frontend.Send(msg); err != nil {
			errChan <- err
			return
		}
	}
}

type Frontend struct {
	*pgproto3.Frontend
	logger *log.Logger
}

func NewFrontend(serverConn net.Conn) Frontend {
	return Frontend{
		pgproto3.NewFrontend(pgproto3.NewChunkReader(serverConn), serverConn),
		log.New(os.Stderr, "PG Send: ", log.LstdFlags|log.Lmsgprefix),
	}
}

func (f *Frontend) forward(backend Backend, errChan chan error) {
	for {
		msg, err := f.Receive()
		if err != nil {
			errChan <- err
			return
		}

		buf, err := json.Marshal(msg)
		if err != nil {
			errChan <- err
			return
		}
		backend.logger.Println(string(buf))

		if _, ok := msg.(pgproto3.AuthenticationResponseMessage); ok {
			// Set the authentication type so the next backend.Receive() will
			// properly decode the appropriate 'p' message.
			if err := backend.SetAuthType(f.GetAuthType()); err != nil {
				errChan <- err
				return
			}
		}

		if err := backend.Send(msg); err != nil {
			errChan <- err
			return
		}
	}
}
