#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="horus-surveillance-feed"
SERVICE_UNIT_FILE="horus-surveillance-feed.service"
ENV_FILE="${SCRIPT_DIR}/.env"
DATA_DIR="${SCRIPT_DIR}/data"
DEFAULT_BIND="127.0.0.1"
DEFAULT_PORT="7800"
DEFAULT_DB="${DATA_DIR}/surveillance-feed.sqlite"

prompt_default() {
  local label="$1"
  local default_value="$2"
  local var_name="$3"
  local value
  read -r -p "${label} [${default_value}]: " value
  printf -v "${var_name}" '%s' "${value:-$default_value}"
}

prompt_secret() {
  local label="$1"
  local var_name="$2"
  local value
  read -r -s -p "${label} [generate]: " value
  echo
  if [[ -z "${value}" ]]; then
    value="$(generate_token)"
    echo "Generated admin token."
  fi
  if [[ "${value}" =~ [[:space:]] ]]; then
    echo "Admin token must not contain whitespace." >&2
    exit 1
  fi
  printf -v "${var_name}" '%s' "${value}"
}

generate_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
    return
  fi
  if command -v node >/dev/null 2>&1; then
    node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
    return
  fi
  tr -dc 'a-f0-9' </dev/urandom | head -c 64
  echo
}

validate_port() {
  local port="$1"
  if ! [[ "${port}" =~ ^[0-9]+$ ]] || (( port < 1 || port > 65535 )); then
    echo "Port must be a number from 1 to 65535." >&2
    exit 1
  fi
}

validate_bind() {
  local bind_addr="$1"
  if [[ -z "${bind_addr}" ]] || [[ "${bind_addr}" =~ [[:space:]] ]]; then
    echo "Bind address must be non-empty and contain no whitespace." >&2
    exit 1
  fi
}

require_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js is required. Install Node.js 24 LTS or newer, then rerun this installer." >&2
    exit 1
  fi
  node -e "
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 5)) {
      console.error('Node.js >=22.5 is required for node:sqlite. Current: ' + process.versions.node);
      process.exit(1);
    }
  "
  if ! command -v npm >/dev/null 2>&1; then
    echo "npm is required." >&2
    exit 1
  fi
}

install_dependencies() {
  cd "${SCRIPT_DIR}"
  if [[ -f package-lock.json ]]; then
    npm ci --omit=dev --no-audit --no-fund
  else
    npm install --omit=dev --no-audit --no-fund
  fi
}

write_env() {
  mkdir -p "${DATA_DIR}"
  if [[ -f "${ENV_FILE}" ]]; then
    cp "${ENV_FILE}" "${ENV_FILE}.bak.$(date +%Y%m%d%H%M%S)"
    echo "Existing .env backed up."
  fi

  cat >"${ENV_FILE}" <<ENV
SURVEILLANCE_FEED_BIND=${BIND_ADDR}
SURVEILLANCE_FEED_PORT=${PORT}
SURVEILLANCE_FEED_DB=${DEFAULT_DB}
SURVEILLANCE_FEED_ADMIN_TOKEN=${ADMIN_TOKEN}
SURVEILLANCE_FEED_REFRESH_MS=604800000
SURVEILLANCE_FEED_MAX_BBOX_AREA=25
SURVEILLANCE_FEED_MAX_ROWS=5000
SURVEILLANCE_FEED_OVERPASS_TIMEOUT_MS=45000
SURVEILLANCE_FEED_OVERPASS_URLS=https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter
ENV
  chmod 600 "${ENV_FILE}"
}

sudo_cmd() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

systemd_user() {
  if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
    printf '%s\n' "${SUDO_USER}"
  else
    id -un
  fi
}

install_systemd_service() {
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "systemctl not found; skipping systemd service install."
    return
  fi

  local answer
  read -r -p "Install and start systemd service ${SERVICE_UNIT_FILE}? [Y/n]: " answer
  if [[ "${answer,,}" == "n" || "${answer,,}" == "no" ]]; then
    return
  fi

  local node_bin
  local run_user
  local run_group
  local unit_tmp
  node_bin="$(command -v node)"
  run_user="$(systemd_user)"
  run_group="$(id -gn "${run_user}" 2>/dev/null || printf '%s' "${run_user}")"
  unit_tmp="$(mktemp)"

  cat >"${unit_tmp}" <<UNIT
[Unit]
Description=HORUS Surveillance Feed
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${run_user}
Group=${run_group}
WorkingDirectory=${SCRIPT_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=${node_bin} ${SCRIPT_DIR}/server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT

  sudo_cmd install -m 0644 "${unit_tmp}" "/etc/systemd/system/${SERVICE_UNIT_FILE}"
  rm -f "${unit_tmp}"
  sudo_cmd systemctl daemon-reload
  sudo_cmd systemctl enable --now "${SERVICE_UNIT_FILE}"
}

health_host() {
  case "${BIND_ADDR}" in
    "0.0.0.0"|"::"|"[::]") printf '127.0.0.1' ;;
    *) printf '%s' "${BIND_ADDR}" ;;
  esac
}

main() {
  echo "HORUS surveillance-feed installer"
  echo

  prompt_default "Bind address" "${DEFAULT_BIND}" BIND_ADDR
  validate_bind "${BIND_ADDR}"
  prompt_default "Port" "${DEFAULT_PORT}" PORT
  validate_port "${PORT}"
  prompt_secret "Admin bearer token" ADMIN_TOKEN

  require_node
  install_dependencies
  write_env
  install_systemd_service

  echo
  echo "Installed surveillance-feed configuration:"
  echo "  ${ENV_FILE}"
  echo
  echo "Health check:"
  echo "  curl http://$(health_host):${PORT}/health"
  echo
  echo "Admin requests require:"
  echo "  Authorization: Bearer <your token>"
  echo
  echo "Set the HORUS app GUI Service URL to:"
  echo "  http://$(health_host):${PORT}"
}

main "$@"
