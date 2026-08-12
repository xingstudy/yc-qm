#!/usr/bin/env bash
set -euo pipefail

target="${1:-.env.production}"
root="$(cd "$(dirname "$0")/.." && pwd)"
template="$root/.env.production.example"
images="${2:-$root/images.production.env}"
if [[ -e "$target" ]]; then
  echo "$target already exists" >&2
  exit 1
fi
target_dir="$(cd "$(dirname "$target")" && pwd)"
target="$target_dir/$(basename "$target")"
work_file="$(mktemp "$target_dir/.env.production.tmp.XXXXXX")"
temp_dir="$(mktemp -d)"
cleanup() {
  unlink "$work_file" 2>/dev/null || true
  find "$temp_dir" -type f -delete 2>/dev/null || true
  rmdir "$temp_dir" 2>/dev/null || true
}
trap cleanup EXIT
cp "$template" "$work_file"
chmod 600 "$work_file"

replace() {
  local name="$1"
  local value="$2"
  sed -i "s|^${name}=.*|${name}=${value}|" "$work_file"
}

if [[ ! -S /var/run/docker.sock ]]; then
  echo "/var/run/docker.sock is required to determine DOCKER_GID" >&2
  exit 1
fi
replace DOCKER_GID "$(stat -c %g /var/run/docker.sock)"

if [[ -f "$images" ]]; then
  while IFS='=' read -r name value; do
    [[ "$name" == QM_*_IMAGE ]] || continue
    replace "$name" "$value"
  done < "$images"
fi

for name in POSTGRES_PASSWORD CORE_SIGNING_SECRET CAPABILITY_SECRET PORTAL_IDENTITY_SECRET PORTAL_SESSION_SECRET CONNECTOR_SECRET_KEY SKILL_SIGNING_SECRET AUTH_TOKEN_SECRET; do
  replace "$name" "$(openssl rand -hex 32)"
done

auth_client_secret="$(openssl rand -hex 32)"
replace AUTH_CLIENT_SECRET "$auth_client_secret"
replace OIDC_CLIENT_SECRET "$auth_client_secret"

openssl ecparam -name prime256v1 -genkey -noout -out "$temp_dir/key.pem"
key_text="$(openssl ec -in "$temp_dir/key.pem" -text -noout 2>/dev/null)"
private_hex="$(printf '%s\n' "$key_text" | awk '/priv:/{take=1;next}/pub:/{take=0}take{gsub(/[:[:space:]]/,"");printf "%s",$0}')"
public_hex="$(printf '%s\n' "$key_text" | awk '/pub:/{take=1;next}/ASN1 OID:/{take=0}take{gsub(/[:[:space:]]/,"");printf "%s",$0}')"
public_hex="${public_hex#04}"
hex_to_base64url() {
  local escaped
  escaped="$(printf '%s' "$1" | sed 's/../\\x&/g')"
  printf '%b' "$escaped" | openssl base64 -A | tr '+/' '-_' | tr -d '='
}
jwk="$(printf '{"kty":"EC","x":"%s","y":"%s","crv":"P-256","d":"%s"}' \
  "$(hex_to_base64url "${public_hex:0:64}")" \
  "$(hex_to_base64url "${public_hex:64:64}")" \
  "$(hex_to_base64url "$private_hex")")"
replace AUTH_SIGNING_JWK "$jwk"

mv "$work_file" "$target"

echo "created $target with generated local secrets"
echo "replace the remaining qm.example.com, example.com, example email, SMTP, organization, admin, and image digest values before deployment"
