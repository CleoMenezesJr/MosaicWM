#!/bin/bash
uuid="mosaicwm@cleomenezesjr.github.io"
./export-zip.sh # Export to zip
gnome-extensions install --force "$uuid.zip" # Install using gnome-extensions
rm "$uuid.zip"
