#!/bin/bash
uuid="mosaicwm@cleomenezesjr.github.io"

# Export directory to zip
(cd extension && zip -r "../$uuid.zip" .)
