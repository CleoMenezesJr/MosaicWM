#!/usr/bin/env bash
# Creates a Fedora toolbox with gnome-shell, mutter-devkit and flatpak
# for running a nested GNOME Shell session with host apps and extensions.

set -e

DEFAULT_TOOLBOX=gnome-ext-test
DEFAULT_RELEASE=44
CONFIG_FILE=${XDG_CONFIG_HOME:-$HOME/.config}/gnome-shell-toolbox-tools.conf

PACKAGES=(
  gnome-shell
  mutter
  mutter-devkit
  flatpak
  dbus-tools
)

usage() {
  cat <<-EOF
	Usage: $(basename $0) [OPTION…]

	Create a toolbox for gnome-shell development

	Options:
	  -t, --toolbox=TOOLBOX   Use TOOLBOX instead of the default "$DEFAULT_TOOLBOX"
	  -r, --release=RELEASE   Use Fedora RELEASE instead of the default "$DEFAULT_RELEASE"

	  -h, --help              Display this help

	EOF
}

die() {
  echo "$@" >&2
  exit 1
}

TOOLBOX=$DEFAULT_TOOLBOX
RELEASE=$DEFAULT_RELEASE

TEMP=$(getopt \
 --name $(basename $0) \
 --options 't:r:h' \
 --longoptions 'toolbox:' \
 --longoptions 'release:' \
 --longoptions 'help' \
 -- "$@") || die "Run $(basename $0) --help to see available options"

eval set -- "$TEMP"
unset TEMP

while true; do
  case $1 in
    -t|--toolbox)
      TOOLBOX=$2
      shift 2
    ;;

    -r|--release)
      RELEASE=$2
      shift 2
    ;;

    -h|--help)
      usage
      exit 0
    ;;

    --)
      shift
      break
    ;;
  esac
done

echo "Creating toolbox $TOOLBOX (Fedora $RELEASE)..."
toolbox create --assumeyes --distro fedora --release "$RELEASE" "$TOOLBOX"

echo "Installing packages: ${PACKAGES[*]}..."
toolbox run --container "$TOOLBOX" sudo dnf install -y "${PACKAGES[@]}"

echo "Upgrading packages to avoid version mismatches..."
toolbox run --container "$TOOLBOX" sudo dnf upgrade -y --refresh

echo "Saving configuration..."
mkdir -p "$(dirname "$CONFIG_FILE")"
cat > "$CONFIG_FILE" <<-EOF
DEFAULT_TOOLBOX=$TOOLBOX
EOF

echo "Toolbox $TOOLBOX created successfully!"
echo "Run: ./scripts/run-gnome-shell.sh -t $TOOLBOX"
