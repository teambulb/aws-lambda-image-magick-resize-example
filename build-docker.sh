#!/bin/bash
# https://docs.aws.amazon.com/lambda/latest/dg/nodejs-image.html#nodejs-image-instructions
# provenance=false is required, and buildx allows this to work on ARM mac
export QEMU_CPU=host
docker buildx build \
  --platform linux/arm64 \
  --build-arg BUILD_TIMESTAMP=$(date +%s) \
  --provenance=false \
  -t image-resizer:1.0.11 \
  --load \
  --progress=plain \
  .
