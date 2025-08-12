package config

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rsa"
	"encoding/base64"
	"fmt"
	"io/fs"
	"math/big"
	"os"
	"time"

	"github.com/go-errors/errors"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/supabase/cli/pkg/fetcher"
)

// generateAPIKeys generates JWT tokens using the appropriate signing method
func (c *config) generateAPIKeys(fsys fs.FS) error {
	// Load signing keys if path is provided
	var signingKeys []JWK
	if len(c.Auth.SigningKeysPath) > 0 {
		f, err := fsys.Open(c.Auth.SigningKeysPath)
		if err != nil {
			// Ignore missing signing key path - will fall back to symmetric signing
			fmt.Fprintf(os.Stderr, "Warning: Failed to generate asymmetric keys, falling back to symmetric: %v\n", err)
		} else {
			parsedKeys, _ := fetcher.ParseJSON[[]JWK](f)
			signingKeys = parsedKeys
			c.Auth.SigningKeys = signingKeys // Store for later use
		}
	}

	// Generate anon key if not provided
	if len(c.Auth.AnonKey.Value) == 0 {
		if len(signingKeys) > 0 {
			if signed, err := generateAsymmetricJWT(signingKeys[0], "anon"); err != nil {
				// Fall back to symmetric signing if asymmetric fails
				fmt.Fprintf(os.Stderr, "Warning: Failed to generate asymmetric anon key, falling back to symmetric: %v\n", err)
				c.Auth.AnonKey.Value = generateSymmetricJWT(c.Auth.JwtSecret.Value, "anon")
			} else {
				c.Auth.AnonKey.Value = signed
			}
		} else {
			c.Auth.AnonKey.Value = generateSymmetricJWT(c.Auth.JwtSecret.Value, "anon")
		}
	}

	// Generate service_role key if not provided
	if len(c.Auth.ServiceRoleKey.Value) == 0 {
		if len(signingKeys) > 0 {
			if signed, err := generateAsymmetricJWT(signingKeys[0], "service_role"); err != nil {
				// Fall back to symmetric signing if asymmetric fails
				fmt.Fprintf(os.Stderr, "Warning: Failed to generate asymmetric service_role key, falling back to symmetric: %v\n", err)
				c.Auth.ServiceRoleKey.Value = generateSymmetricJWT(c.Auth.JwtSecret.Value, "service_role")
			} else {
				c.Auth.ServiceRoleKey.Value = signed
			}
		} else {
			c.Auth.ServiceRoleKey.Value = generateSymmetricJWT(c.Auth.JwtSecret.Value, "service_role")
		}
	}

	return nil
}

// createJWTClaims creates standardized JWT claims for API keys
func createJWTClaims(role string) CustomClaims {
	now := time.Now()
	return CustomClaims{
		Issuer: "supabase-demo",
		Role:   role,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(now.Add(time.Hour * 24 * 365 * 10)), // 10 years
		},
	}
}

// generateSymmetricJWT generates a JWT using symmetric signing with jwt_secret
func generateSymmetricJWT(jwtSecret, role string) string {
	claims := createJWTClaims(role)
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)

	signed, err := token.SignedString([]byte(jwtSecret))
	if err != nil {
		// This should not happen if JWT secret is valid, but return empty string as fallback
		fmt.Fprintf(os.Stderr, "Error: Failed to generate %s key: %v\n", role, err)
		return ""
	}
	return signed
}

// generateAsymmetricJWT generates a JWT token signed with the provided JWK private key
func generateAsymmetricJWT(jwk JWK, role string) (string, error) {
	privateKey, err := jwkToPrivateKey(jwk)
	if err != nil {
		return "", errors.Errorf("failed to convert JWK to private key: %w", err)
	}

	claims := createJWTClaims(role)

	// Determine signing method based on algorithm
	var token *jwt.Token
	switch jwk.Algorithm {
	case "RS256":
		token = jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	case "ES256":
		token = jwt.NewWithClaims(jwt.SigningMethodES256, claims)
	default:
		return "", errors.Errorf("unsupported algorithm: %s", jwk.Algorithm)
	}

	if jwk.KeyID != uuid.Nil {
		token.Header["kid"] = jwk.KeyID.String()
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
