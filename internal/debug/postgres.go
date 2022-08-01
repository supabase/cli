package debug

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net"
	"os"

	"github.com/jackc/pgproto3/v2"
	"github.com/jackc/pgx/v4"
	"google.golang.org/grpc/test/bufconn"
)

type Proxy struct {
	dialContext func(ctx context.Context, network, addr string) (net.Conn, error)
	errChan     chan error
}

func NewProxy() Proxy {
	dialer := net.Dialer{}
	return Proxy{
		dialContext: dialer.DialContext,
		errChan:     make(chan error, 1),
	}
}

func SetupPGX(config *pgx.ConnConfig) {
	proxy := Proxy{
		dialContext: config.DialFunc,
		errChan:     make(chan error, 1),
	}
	config.DialFunc = proxy.DialFunc
	config.TLSConfig = nil
}

func (p *Proxy) DialFunc(ctx context.Context, network, addr string) (net.Conn, error) {
	serverConn, err := p.dialContext(ctx, network, addr)
	if err != nil {
		return nil, err
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
			// Since pgx closes connection first, every EOF is seen as unexpected
			if err := <-p.errChan; err != nil && err != io.ErrUnexpectedEOF {
				panic(err)
			}
		}
	}()

	return ln.DialContext(ctx)
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
