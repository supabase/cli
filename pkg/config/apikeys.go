package config

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rsa"
	"encoding/base64"
	"math/big"
	"time"

	"github.com/go-errors/errors"
	"github.com/golang-jwt/jwt/v5"
)

const (
	defaultJwtSecret      = "super-secret-jwt-token-with-at-least-32-characters-long"
	defaultJwtExpiry      = 1983812996
	defaultPublishableKey = "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH"
	defaultSecretKey      = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz"
)

type CustomClaims struct {
	// Overrides Issuer to maintain json order when marshalling
	Issuer string `json:"iss,omitempty"`
	Ref    string `json:"ref,omitempty"`
	Role   string `json:"role"`
	IsAnon bool   `json:"is_anonymous,omitempty"`
	jwt.RegisteredClaims
}

func (c CustomClaims) NewToken() *jwt.Token {
	if c.ExpiresAt == nil {
		c.ExpiresAt = jwt.NewNumericDate(time.Unix(defaultJwtExpiry, 0))
	}
	if len(c.Issuer) == 0 {
		c.Issuer = "supabase-demo"
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, c)
}

// generateAPIKeys generates JWT tokens using the appropriate signing method
func (a *auth) generateAPIKeys() error {
	if len(a.JwtSecret.Value) == 0 {
		a.JwtSecret.Value = defaultJwtSecret
	} else if len(a.JwtSecret.Value) < 16 {
		return errors.Errorf("Invalid config for auth.jwt_secret. Must be at least 16 characters")
	}
	// Generate anon key if not provided
	if len(a.AnonKey.Value) == 0 {
		signed, err := a.generateJWT("anon")
		if err != nil {
			return err
		}
		a.AnonKey.Value = signed
	}
	// Generate service_role key if not provided
	if len(a.ServiceRoleKey.Value) == 0 {
		signed, err := a.generateJWT("service_role")
		if err != nil {
			return err
		}
		a.ServiceRoleKey.Value = signed
	}
	// Set hardcoded opaque keys
	if len(a.PublishableKey.Value) == 0 {
		a.PublishableKey.Value = defaultPublishableKey
	}
	if len(a.SecretKey.Value) == 0 {
		a.SecretKey.Value = defaultSecretKey
	}
	return nil
}

func (a auth) generateJWT(role string) (string, error) {
	claims := CustomClaims{Issuer: "supabase-demo", Role: role}
	if len(a.SigningKeysPath) > 0 {
		claims.ExpiresAt = jwt.NewNumericDate(time.Now().Add(time.Hour * 24 * 365 * 10)) // 10 years
		return GenerateAsymmetricJWT(a.SigningKeys[0], claims)
	}
	// Fallback to generating symmetric keys
	signed, err := claims.NewToken().SignedString([]byte(a.JwtSecret.Value))
	if err != nil {
		return "", errors.Errorf("failed to generate JWT: %w", err)
	}
	return signed, nil
}

// GenerateAsymmetricJWT generates a JWT token signed with the provided JWK private key
func GenerateAsymmetricJWT(jwk JWK, claims jwt.Claims) (string, error) {
	privateKey, err := jwkToPrivateKey(jwk)
	if err != nil {
		return "", errors.Errorf("failed to convert JWK to private key: %w", err)
	}

	// Determine signing method based on algorithm
	var token *jwt.Token
	switch jwk.Algorithm {
	case AlgRS256:
		token = jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	case AlgES256:
		token = jwt.NewWithClaims(jwt.SigningMethodES256, claims)
	default:
		return "", errors.Errorf("unsupported algorithm: %s", jwk.Algorithm)
	}

	if len(jwk.KeyID) > 0 {
		token.Header["kid"] = jwk.KeyID
	}

	tokenString, err := token.SignedString(privateKey)
	if err != nil {
		return "", errors.Errorf("failed to sign JWT: %w", err)
	}

	return tokenString, nil
}

// jwkToPrivateKey converts a JWK to a crypto.PrivateKey
func jwkToPrivateKey(jwk JWK) (crypto.PrivateKey, error) {
	switch jwk.KeyType {
	case "RSA":
		return jwkToRSAPrivateKey(jwk)
	case "EC":
		return jwkToECDSAPrivateKey(jwk)
	default:
		return nil, errors.Errorf("unsupported key type: %s", jwk.KeyType)
	}
}

// jwkToRSAPrivateKey converts a JWK to an RSA private key
func jwkToRSAPrivateKey(jwk JWK) (*rsa.PrivateKey, error) {
	nBytes, err := base64.RawURLEncoding.DecodeString(jwk.Modulus)
	if err != nil {
		return nil, errors.Errorf("failed to decode modulus: %w", err)
	}
	n := new(big.Int).SetBytes(nBytes)

	eBytes, err := base64.RawURLEncoding.DecodeString(jwk.Exponent)
	if err != nil {
		return nil, errors.Errorf("failed to decode exponent: %w", err)
	}
	e := int(new(big.Int).SetBytes(eBytes).Int64())

	dBytes, err := base64.RawURLEncoding.DecodeString(jwk.PrivateExponent)
	if err != nil {
		return nil, errors.Errorf("failed to decode private exponent: %w", err)
	}
	d := new(big.Int).SetBytes(dBytes)

	pBytes, err := base64.RawURLEncoding.DecodeString(jwk.FirstPrimeFactor)
	if err != nil {
		return nil, errors.Errorf("failed to decode first prime factor: %w", err)
	}
	p := new(big.Int).SetBytes(pBytes)

	qBytes, err := base64.RawURLEncoding.DecodeString(jwk.SecondPrimeFactor)
	if err != nil {
		return nil, errors.Errorf("failed to decode second prime factor: %w", err)
	}
	q := new(big.Int).SetBytes(qBytes)

	return &rsa.PrivateKey{
		PublicKey: rsa.PublicKey{N: n, E: e},
		D:         d,
		Primes:    []*big.Int{p, q},
	}, nil
}

// jwkToECDSAPrivateKey converts a JWK to an ECDSA private key
func jwkToECDSAPrivateKey(jwk JWK) (*ecdsa.PrivateKey, error) {
	// Only support P-256 curve for ES256
	if jwk.Curve != "P-256" {
		return nil, errors.Errorf("unsupported curve: %s", jwk.Curve)
	}

	xBytes, err := base64.RawURLEncoding.DecodeString(jwk.X)
	if err != nil {
		return nil, errors.Errorf("failed to decode x coordinate: %w", err)
	}
	x := new(big.Int).SetBytes(xBytes)

	yBytes, err := base64.RawURLEncoding.DecodeString(jwk.Y)
	if err != nil {
		return nil, errors.Errorf("failed to decode y coordinate: %w", err)
	}
	y := new(big.Int).SetBytes(yBytes)

	dBytes, err := base64.RawURLEncoding.DecodeString(jwk.PrivateExponent)
	if err != nil {
		return nil, errors.Errorf("failed to decode private key: %w", err)
	}
	d := new(big.Int).SetBytes(dBytes)

	return &ecdsa.PrivateKey{
		PublicKey: ecdsa.PublicKey{
			Curve: elliptic.P256(),
			X:     x,
			Y:     y,
		},
		D: d,
	}, nil
}

func NewBigIntFromBase64(n string) (*big.Int, error) {
	nBytes, err := base64.RawURLEncoding.DecodeString(n)
	if err != nil {
		return nil, errors.Errorf("failed to decode base64: %w", err)
	}
	return new(big.Int).SetBytes(nBytes), nil
}
