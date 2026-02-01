package services

import "context"

type Service interface {
	Start(context.Context) error
	Close() error
	HealthCheck(context.Context) error
	GetURL() string
}
