#!/bin/bash
# Copied from: https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/tools/toolbox/create-toolbox.sh

set -e

DEFAULT_TOOLBOX=gnome-shell-devel
DEFAULT_IMAGE=registry.fedoraproject.org/fedora-toolbox:42
CONFIG_FILE=${XDG_CONFIG_HOME:-$HOME/.config}/gnome-shell-toolbox-tools.conf

usage() {
  cat <<-EOF
	Usage: $(basename $0) [OPTION…]

	Create a toolbox for gnome-shell development

	Options:
	  -t, --toolbox=TOOLBOX   Use TOOLBOX instead of the default "$DEFAULT_TOOLBOX"
	  -i, --image=IMAGE       Use IMAGE instead of the default "$DEFAULT_IMAGE"

	  -h, --help              Display this help

	EOF
}

die() {
  echo "$@" >&2
  exit 1
}

TOOLBOX=$DEFAULT_TOOLBOX
IMAGE=$DEFAULT_IMAGE

TEMP=$(getopt \
 --name $(basename $0) \
 --options 't:i:h' \
 --longoptions 'toolbox:' \
 --longoptions 'image:' \
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

    -i|--image)
      IMAGE=$2
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

PACKAGES=(
  gnome-shell
  glib2-devel
)

echo "Creating toolbox $TOOLBOX from $IMAGE..."

toolbox create --image $IMAGE $TOOLBOX

echo "Installing packages..."
toolbox run --container $TOOLBOX sudo dnf install -y ${PACKAGES[@]}

echo "Saving configuration..."
mkdir -p $(dirname $CONFIG_FILE)
cat > $CONFIG_FILE <<-EOF
DEFAULT_TOOLBOX=$TOOLBOX
EOF

echo "Toolbox $TOOLBOX created successfully!"
