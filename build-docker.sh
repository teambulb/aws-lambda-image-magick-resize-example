
# https://docs.aws.amazon.com/lambda/latest/dg/nodejs-image.html#nodejs-image-instructions
# provenance=false is required, and buildx allows this to work on ARM mac
export QEMU_CPU=host
docker buildx build \
  --platform linux/arm64 \
  --provenance=false \
  -t image-resizer \
  --load \
  --progress=plain \
  .
