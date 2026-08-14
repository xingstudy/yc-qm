#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
env_file="${1:-$root/.env.production}"
action="${2:-deploy}"
if [[ "$action" != "deploy" ]] && [[ "$action" != "prepare" ]] && [[ "$action" != "apply" ]] && [[ "$action" != "down" ]]; then
  echo "action must be deploy, prepare, apply, or down" >&2
  exit 1
fi
if [[ ! -f "$env_file" ]]; then
  echo "$env_file does not exist" >&2
  exit 1
fi
env_dir="$(cd "$(dirname "$env_file")" && pwd)"
env_file="$env_dir/$(basename "$env_file")"
mode="$(stat -c %a "$env_file")"
if (( (8#$mode & 077) != 0 )); then
  echo "$env_file must not be readable or writable by group or others" >&2
  exit 1
fi

env_value() {
  local name="$1"
  local count
  count="$(awk -F= -v key="$name" '$1 == key { count++ } END { print count + 0 }' "$env_file")"
  if [[ "$count" != "1" ]]; then
    echo "$env_file must contain exactly one $name value" >&2
    exit 1
  fi
  sed -n "s/^${name}=//p" "$env_file"
}

release_tag="$(env_value QM_RELEASE_TAG)"
compose_project="$(env_value QM_COMPOSE_PROJECT)"
if [[ ! "$release_tag" =~ ^prod-v[0-9]+\.[0-9]+\.[0-9]+$ ]] || [[ "$release_tag" == "prod-v0.0.0" ]]; then
  echo "QM_RELEASE_TAG must use prod-vMAJOR.MINOR.PATCH and must not be prod-v0.0.0" >&2
  exit 1
fi
if [[ ! "$compose_project" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
  echo "QM_COMPOSE_PROJECT must use lowercase letters, digits, hyphens, or underscores" >&2
  exit 1
fi

for command_name in sha256sum docker; do
  if ! command -v "$command_name" > /dev/null; then
    echo "$command_name is required" >&2
    exit 1
  fi
done
if ! docker compose version > /dev/null; then
  echo "Docker Compose v2 is required" >&2
  exit 1
fi
docker_bin="$(command -v docker)"

release_root="$root/.releases"
release_dir="$release_root/$release_tag"
mkdir -p "$release_root"
assets=(
  compose.production.yaml
  release.production.tag
  images.production.env
  images.production.json
  SHA256SUMS
  SHA256SUMS.bundle
)
runtime_assets=(compose.production.yaml release.production.tag images.production.env images.production.json)
identity="https://github.com/xingstudy/yc-qm/.github/workflows/release-production-images.yml@refs/heads/main"
issuer="https://token.actions.githubusercontent.com"
stage=""
required_sums=""
cleanup() {
  if [[ -n "$required_sums" && -f "$required_sums" ]]; then
    unlink "$required_sums" 2>/dev/null || true
  fi
  if [[ -n "$stage" && -d "$stage" ]]; then
    find "$stage" -type f -delete 2>/dev/null || true
    rmdir "$stage" 2>/dev/null || true
  fi
}
trap cleanup EXIT

declare -A expected_images=(
  [QM_CORE_IMAGE]=docker.io/lijixing/qm-core
  [QM_WEB_UI_IMAGE]=docker.io/lijixing/qm-web-ui
  [QM_ADMIN_IMAGE]=docker.io/lijixing/qm-admin
  [QM_PORTAL_IMAGE]=docker.io/lijixing/qm-portal
  [QM_AUTH_IMAGE]=docker.io/lijixing/qm-auth
  [QM_EDGE_IMAGE]=docker.io/lijixing/qm-edge
  [QM_SANDBOX_IMAGE]=docker.io/lijixing/qm-sandbox-local
)

validate_release() {
  local directory="$1"
  local verify_images="$2"
  local asset
  local match_count
  local name
  local image
  local expected_prefix
  local digest
  declare -A seen_images=()
  required_sums="$(mktemp "$release_root/.required-sums.XXXXXX")"
  for asset in "${runtime_assets[@]}"; do
    match_count="$(awk -v file="$asset" '$2 == file { count++ } END { print count + 0 }' "$directory/SHA256SUMS")"
    if [[ "$match_count" != "1" ]]; then
      echo "SHA256SUMS must contain exactly one entry for $asset" >&2
      exit 1
    fi
    awk -v file="$asset" '$2 == file { print }' "$directory/SHA256SUMS" >> "$required_sums"
  done
  (cd "$directory" && sha256sum -c "$required_sums" > /dev/null)
  unlink "$required_sums"
  required_sums=""
  if [[ "$(< "$directory/release.production.tag")" != "$release_tag" ]]; then
    echo "the signed release identity does not match QM_RELEASE_TAG" >&2
    exit 1
  fi
  while IFS='=' read -r name image; do
    if [[ -z "${expected_images[$name]+set}" ]] || [[ -n "${seen_images[$name]+set}" ]]; then
      echo "images.production.env contains an unexpected or duplicate key" >&2
      exit 1
    fi
    expected_prefix="${expected_images[$name]}@sha256:"
    digest="${image#"$expected_prefix"}"
    if [[ "$image" != "$expected_prefix$digest" ]] || [[ ! "$digest" =~ ^[0-9a-f]{64}$ ]] || [[ "$digest" == "$(printf '%064d' 0)" ]]; then
      echo "$name must use the expected Docker Hub repository and a non-sentinel digest" >&2
      exit 1
    fi
    if [[ "$verify_images" == "1" ]]; then
      cosign verify "$image" \
        --certificate-identity="$identity" \
        --certificate-oidc-issuer="$issuer" > /dev/null
    fi
    seen_images[$name]=1
  done < "$directory/images.production.env"
  for name in "${!expected_images[@]}"; do
    if [[ -z "${seen_images[$name]+set}" ]]; then
      echo "images.production.env is missing $name" >&2
      exit 1
    fi
  done
}

if [[ "$action" == "deploy" || "$action" == "prepare" ]]; then
  for command_name in curl cosign; do
    if ! command -v "$command_name" > /dev/null; then
      echo "$command_name is required" >&2
      exit 1
    fi
  done
  stage="$(mktemp -d "$release_root/.${release_tag}.tmp.XXXXXX")"
  base_url="${QM_RELEASE_BASE_URL:-https://github.com/xingstudy/yc-qm/releases/download}/$release_tag"
  for asset in "${assets[@]}"; do
    curl -fsSL "$base_url/$asset" -o "$stage/$asset"
  done
  cosign verify-blob \
    --bundle "$stage/SHA256SUMS.bundle" \
    --certificate-identity="$identity" \
    --certificate-oidc-issuer="$issuer" \
    "$stage/SHA256SUMS" > /dev/null
  validate_release "$stage" 1
  chmod 600 "$stage/images.production.env"
  if [[ -d "$release_dir" ]]; then
    for asset in "${assets[@]}"; do
      if ! cmp -s "$stage/$asset" "$release_dir/$asset"; then
        echo "$release_dir does not match the verified release assets" >&2
        exit 1
      fi
    done
  else
    mv "$stage" "$release_dir"
    stage=""
  fi
else
  if [[ ! -d "$release_dir" ]]; then
    echo "$release_dir is not prepared; run the prepare action while the current stack is available" >&2
    exit 1
  fi
  validate_release "$release_dir" 0
fi

compose=(
  "$docker_bin" compose
  --project-name "$compose_project"
  --env-file "$env_file"
  --env-file "$release_dir/images.production.env"
  -f "$release_dir/compose.production.yaml"
)
mapfile -t interpolation_names < <(
  {
    grep -oE '\$\{[A-Z][A-Z0-9_]*' "$release_dir/compose.production.yaml" | sed 's/^\${//' || true
    sed -n 's/^\([A-Z][A-Z0-9_]*\)=.*/\1/p' "$env_file"
    sed -n 's/^\([A-Z][A-Z0-9_]*\)=.*/\1/p' "$release_dir/images.production.env"
    printf '%s\n' \
      COMPOSE_DISABLE_ENV_FILE \
      COMPOSE_ENV_FILES \
      COMPOSE_FILE \
      COMPOSE_IGNORE_ORPHANS \
      COMPOSE_PROFILES \
      COMPOSE_PROJECT_NAME \
      COMPOSE_REMOVE_ORPHANS
  } | sort -u
)
clean_environment=(env)
for name in "${interpolation_names[@]}"; do
  clean_environment+=(-u "$name")
done
"${clean_environment[@]}" "${compose[@]}" config --quiet
if [[ "$action" == "down" ]]; then
  "${clean_environment[@]}" "${compose[@]}" down --remove-orphans
  exit 0
fi
if [[ "$action" == "deploy" || "$action" == "prepare" ]]; then
  "${clean_environment[@]}" "${compose[@]}" pull
fi
if [[ "$action" == "prepare" ]]; then
  echo "prepared $release_tag without changing the running stack"
  exit 0
fi
"${clean_environment[@]}" "${compose[@]}" up -d --wait --pull never --remove-orphans
"${clean_environment[@]}" "${compose[@]}" ps
