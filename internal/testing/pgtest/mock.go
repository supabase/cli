package pgtest

import (
	"context"
	"net"
	"reflect"
	"time"

	"github.com/jackc/pgmock"
	"github.com/jackc/pgproto3/v2"
	"github.com/jackc/pgtype"
	"github.com/jackc/pgx/v4"
	"google.golang.org/grpc/test/bufconn"
)

var ci = pgtype.NewConnInfo()

type MockConn struct {
	// Duplex server listener backed by in-memory buffer
	server *bufconn.Listener

	// Mock server requests and responses
	script pgmock.Script

	// Status parameters emitted by postgres on first connect
	status map[string]string

	// Channel for reporting all server error
	ErrChan chan error
}

func (r *MockConn) getStartupMessage(config *pgx.ConnConfig) []pgmock.Step {
	var steps []pgmock.Step
	// Add auth message
	steps = append(
		steps,
		pgmock.ExpectMessage(&pgproto3.StartupMessage{
			ProtocolVersion: pgproto3.ProtocolVersionNumber,
			Parameters:      map[string]string{"database": config.Database, "user": config.User},
		}),
		pgmock.SendMessage(&pgproto3.AuthenticationOk{}),
	)
	// Add status message
	r.status["session_authorization"] = config.User
	for key, value := range r.status {
		steps = append(steps, pgmock.SendMessage(&pgproto3.ParameterStatus{Name: key, Value: value}))
	}
	// Add ready message
	steps = append(
		steps,
		pgmock.SendMessage(&pgproto3.BackendKeyData{ProcessID: 0, SecretKey: 0}),
		pgmock.SendMessage(&pgproto3.ReadyForQuery{TxStatus: 'I'}),
	)
	return steps
}

// Configures pgx to use the mock dialer.
//
// The mock dialer provides a full duplex net.Conn backed by an in-memory buffer.
// It is implemented by grcp/test/bufconn package.
func (r *MockConn) Intercept(config *pgx.ConnConfig) {
	// TODO: check for config.PreferSimpleProtocol
	config.DialFunc = func(ctx context.Context, network, addr string) (net.Conn, error) {
		return r.server.DialContext(ctx)
	}
	config.TLSConfig = nil
	// Add startup message
	r.script.Steps = append(r.getStartupMessage(config), r.script.Steps...)
}

// Adds a simple query to the mock connection.
//
// TODO: support prepared statements that involve multiple round trips, ie. Parse -> Bind.
func (r *MockConn) Query(psql string) *MockConn {
	r.script.Steps = append(r.script.Steps, pgmock.ExpectMessage(&pgproto3.Query{String: psql}))
	return r
}

func getDataTypeSize(v interface{}) int16 {
	t := reflect.TypeOf(v)
	k := t.Kind()
	if k < reflect.Int || k > reflect.Complex128 {
		return -1
	}
	return int16(t.Size())
}

// Adds a server reply using text protocol format.
//
// TODO: support binary protocol
func (r *MockConn) Reply(tag string, rows ...map[string]interface{}) *MockConn {
	// Add field description
	if len(rows) > 0 {
		var desc pgproto3.RowDescription
		for k, v := range rows[0] {
			if dt, ok := ci.DataTypeForValue(v); ok {
				size := getDataTypeSize(v)
				desc.Fields = append(desc.Fields, pgproto3.FieldDescription{
					Name:                 []byte(k),
					TableOID:             17131,
					TableAttributeNumber: 1,
					DataTypeOID:          dt.OID,
					DataTypeSize:         size,
					TypeModifier:         -1,
					Format:               pgtype.TextFormatCode,
				})
			}
		}
		r.script.Steps = append(r.script.Steps, pgmock.SendMessage(&desc))
	} else {
		// Postgres emits field descriptions even if no rows are returned. However,
		// we do not need to handle this case because pgx does not care about it.
	}
	// Add row data
	for _, data := range rows {
		var dr pgproto3.DataRow
		for _, v := range data {
			if dt, ok := ci.DataTypeForValue(v); ok {
				if err := dt.Value.Set(v); err != nil {
					continue
				}
				if value, err := (dt.Value).(pgtype.TextEncoder).EncodeText(ci, []byte{}); err == nil {
					dr.Values = append(dr.Values, value)
				}
			}
		}
		r.script.Steps = append(r.script.Steps, pgmock.SendMessage(&dr))
	}
	// Subquery emits additional completion messages but pgx doesn't seem to care. For eg.
	// Reply("CREATE SCHEMA").
	// pgmock.SendMessage(&pgproto3.NoticeResponse{
	// 	Severity:            "NOTICE",
	// 	SeverityUnlocalized: "NOTICE",
	// 	Code:                "42P06",
	// 	Message:             "schema \"supabase_migrations\" already exists, skipping",
	// }),
	// pgmock.SendMessage(&pgproto3.CommandComplete{CommandTag: []byte("CREATE SCHEMA")}),
	// Add completion message
	r.script.Steps = append(
		r.script.Steps,
		pgmock.SendMessage(&pgproto3.CommandComplete{CommandTag: []byte(tag)}),
		pgmock.SendMessage(&pgproto3.ReadyForQuery{TxStatus: 'I'}),
	)
	return r
}

// Simulates an error reply from the server.
//
// TODO: simulate a notice reply
func (r *MockConn) ReplyError(code, message string) *MockConn {
	r.script.Steps = append(
		r.script.Steps,
		pgmock.SendMessage(&pgproto3.ErrorResponse{
			Severity:            "ERROR",
			SeverityUnlocalized: "ERROR",
			Code:                code,
			Message:             message,
		}),
		pgmock.SendMessage(&pgproto3.ReadyForQuery{TxStatus: 'I'}),
	)
	return r
}

func (r *MockConn) Close() {
	_ = r.server.Close()
}

func NewWithStatus(status map[string]string) *MockConn {
	const bufSize = 1024 * 1024
	mock := MockConn{
		server:  bufconn.Listen(bufSize),
		status:  status,
		ErrChan: make(chan error, 1),
	}
	// Start server in background
	const timeout = time.Millisecond * 450
	go func() {
		defer close(mock.ErrChan)
		// Block until we've opened a TCP connection
		conn, err := mock.server.Accept()
		if err != nil {
			mock.ErrChan <- err
			return
		}
		defer conn.Close()
		// Prevent server from hanging the test
		err = conn.SetDeadline(time.Now().Add(timeout))
		if err != nil {
			mock.ErrChan <- err
			return
		}
		// Always expect clients to terminate the request
		mock.script.Steps = append(mock.script.Steps, pgmock.ExpectMessage(&pgproto3.Terminate{}))
		err = mock.script.Run(pgproto3.NewBackend(pgproto3.NewChunkReader(conn), conn))
		if err != nil {
			mock.ErrChan <- err
			return
		}
	}()

	return &mock
}

func NewConn() *MockConn {
	return NewWithStatus(map[string]string{
		"application_name":              "",
		"client_encoding":               "UTF8",
		"DateStyle":                     "ISO, MDY",
		"default_transaction_read_only": "off",
		"in_hot_standby":                "off",
		"integer_datetimes":             "on",
		"IntervalStyle":                 "postgres",
		"is_superuser":                  "on",
		"server_encoding":               "UTF8",
		"server_version":                "14.3 (Debian 14.3-1.pgdg110+1)",
		"standard_conforming_strings":   "on",
		"TimeZone":                      "UTC",
	})
}
