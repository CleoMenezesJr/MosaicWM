#!/usr/bin/env bash
# Build and install script for Mosaic WM

set -e

UUID="mosaicwm@cleomenezesjr.github.io"
SRCDIR="extension"
ZIPFILE="$UUID.zip"

usage() {
    echo "Usage: $0 [OPTION]"
    echo ""
    echo "Options:"
    echo "  -b, --build     Build the extension (create zip)"
    echo "  -i, --install   Install the extension locally"
    echo "  -u, --uninstall Uninstall the extension"
    echo "  -h, --help      Show this help message"
}

build() {
    echo "Building extension..."
    
    # Remove compiled schemas
    rm -f "$SRCDIR/schemas/gschemas.compiled"
    (cd "$SRCDIR" && zip -r "../$ZIPFILE" .)
    
    echo "Build complete: $ZIPFILE"
}

install() {
    echo "Installing Mosaic WM..."
    
    # Build first
    build
    
    # Install using gnome-extensions
    gnome-extensions install --force "$ZIPFILE"
    
    # Clean up
    rm -f "$ZIPFILE"
    
    echo "Installation complete!"
    echo "Please restart GNOME Shell (log out and log back in)"
    echo "Then enable: gnome-extensions enable $UUID"
}

uninstall() {
    echo "Uninstalling Mosaic WM..."
    gnome-extensions uninstall "$UUID" 2>/dev/null || true
    echo "Uninstallation complete!"
}

# Parse arguments
if [ $# -eq 0 ]; then
    usage
    exit 1
fi

case "$1" in
    -b|--build)
        build
        ;;
    -i|--install)
        install
        ;;
    -u|--uninstall)
        uninstall
        ;;
    -h|--help)
        usage
        ;;
    *)
        echo "Unknown option: $1"
        usage
        exit 1
        ;;
esac
