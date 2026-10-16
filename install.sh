#!/usr/bin/env bash
# Keep execution in the final main call: safe to download before running.
main() (
  set -eu
  local action=${1-install} tool version major minor patch os arch checkout
  local temporary=''
  if [ "$#" -gt 1 ]; then
    printf '%s\n' 'Usage: bash install.sh [install|update|uninstall|--help]' >&2
    exit 2
  fi
  case "$action" in
    help|--help)
      printf '%s\n' 'Usage: bash install.sh [install|update|uninstall]' \
        'Install builds main; update explicitly replaces an installed package.' \
        'Uninstall removes only the plugin package, not its data or the official Droid CLI.'
      exit 0 ;;
    install|update|uninstall) ;;
    *) printf 'Unknown action: %s\n' "$action" >&2; exit 2 ;;
  esac
  if ! command -v tern >/dev/null 2>&1; then
    printf '%s\n' 'Required command not found on PATH: tern' >&2
    exit 1
  fi
  if [ "$action" = uninstall ]; then
    printf '%s\n' 'Close Droid plugin sessions before removing the plugin.'
    tern plugin remove tern-bridge-droid </dev/null
    printf '%s\n' 'Plugin removed. Plugin data, account/session history and the official Droid CLI are unchanged.' \
      'Restart Tern and open a new local zsh pane.'
    exit 0
  fi
  for tool in git node npm bun droid uname mktemp rm; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      printf 'Required command not found on PATH: %s\n' "$tool" >&2
      exit 1
    fi
  done
  version=$(node --version)
  if [[ ! "$version" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    printf 'Cannot use Node version: %s (requires stable Node >=22.0.0).\n' "$version" >&2
    exit 1
  fi
  major=$((10#${BASH_REMATCH[1]}))
  if [ "$major" -lt 22 ]; then
    printf '%s\n' 'Node >=22.0.0 is required; upgrade Node before installing.' >&2
    exit 1
  fi
  version=$(bun --version)
  if [[ ! "$version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    printf 'Cannot use Bun version: %s (requires stable Bun >=1.3.14).\n' "$version" >&2
    exit 1
  fi
  major=$((10#${BASH_REMATCH[1]})); minor=$((10#${BASH_REMATCH[2]})); patch=$((10#${BASH_REMATCH[3]}))
  if (( major < 1 || (major == 1 && minor < 3) || (major == 1 && minor == 3 && patch < 14) )); then
    printf '%s\n' 'Bun >=1.3.14 is required; upgrade Bun before installing.' >&2
    exit 1
  fi
  os=$(uname -s); arch=$(uname -m)
  case "$os" in Darwin|Linux) ;; *) printf 'Unsupported operating system: %s\n' "$os" >&2; exit 1 ;; esac
  case "$arch" in arm64|aarch64|x86_64) ;; *) printf 'Unsupported architecture: %s\n' "$arch" >&2; exit 1 ;; esac
  if [ "$os/$arch" != Darwin/arm64 ]; then
    printf 'Warning: build target %s/%s is unverified; only Darwin arm64 is verified.\n' "$os" "$arch" >&2
  fi
  printf '%s\n' 'Close Droid plugin sessions before installing or updating.' \
    'The official Droid CLI is on PATH; this does not verify authentication or account readiness.'
  cleanup() {
    if [ -n "$temporary" ]; then rm -rf -- "$temporary"; fi
  }
  trap cleanup EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  temporary=$(mktemp -d "${TMPDIR:-/tmp}/tern-bridge-droid.XXXXXXXX")
  checkout="$temporary/repository"
  GIT_TERMINAL_PROMPT=0 git clone --branch main --single-branch --depth 1 \
    https://github.com/justdoswift/tern-bridge-droid.git "$checkout" </dev/null
  version=$(git -C "$checkout" rev-parse HEAD </dev/null)
  printf 'Downloaded commit: %s\n' "$version"
  cd "$checkout"
  npm ci --ignore-scripts --include=dev --include=optional </dev/null
  npm run package </dev/null
  if [ ! -d "$checkout/artifacts/package/tern-bridge-droid" ]; then
    printf '%s\n' 'Build did not produce the expected plugin package.' >&2
    exit 1
  fi
  if [ "$action" = update ]; then
    tern plugin install "$checkout/artifacts/package/tern-bridge-droid" --force </dev/null
  elif ! tern plugin install "$checkout/artifacts/package/tern-bridge-droid" </dev/null; then
    printf '%s\n' 'Install failed. If already installed, explicitly run: bash install.sh update' \
      'Linked installs remain protected by Tern; no automatic unlink is attempted.' >&2
    exit 1
  fi
  printf '%s\n' 'Droid bridge installed. Restart Tern and open a new local zsh pane.'
)
main "$@"
