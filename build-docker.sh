
# https://docs.aws.amazon.com/lambda/latest/dg/nodejs-image.html#nodejs-image-instructions
# provenance=false is required, and buildx allows this to work on ARM mac
docker buildx build --platform linux/amd64 --provenance=false -t image-resizer --load .
