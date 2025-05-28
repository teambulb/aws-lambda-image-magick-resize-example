# AWS Lambda Image Processing Example

This repository demonstrates how to use Sharp and libheif libraries for high-performance image processing in AWS Lambda, including support for HEIC/HEIF formats.

## Features

- High-performance image processing with Sharp
- Support for HEIC/HEIF formats with libheif
- Efficient memory usage for large images
- Comprehensive image manipulation operations (crop, resize, rotate)
- Automatic format conversion based on image content

## Quick Start

1. Checkout the repository:

   ```bash
   git clone git@github.com/teambulb/aws-lambda-image-magick-resize-example.git

   cd aws-lambda-image-processing-example
   ```

2. Build the docker image:

   ```shell
   docker build --platform linux/amd64 -t image-resizer .
   ```

3. Deploy the Lambda function using the provided CloudFormation templates.

## Project Structure

The project is organized into several modules, each responsible for a specific functionality:

### Core Components

- **handler.js**: The main Lambda handler that routes requests to the appropriate processor.
- **baseRequest.js**: Base class with common functionality for all image processing operations.
- **utils.js**: Utility functions used throughout the application.

### Image Operations

- **upload.js**: Classes for uploading images from URLs or S3 buckets.
- **tiles.js**: Class for creating horizontal and vertical tiles from an image.
- **imageManipulation.js**: Classes for image manipulation operations (crop, resize, rotate).

## Workflow

The Lambda function supports several image processing operations:

### 1. Upload Operations

#### From URL
```json
{
  "sourceUrl": "https://www.example.com/test.jpg",
  "assetId": "fromurl",
  "imageQuality": 90
}
```

#### From Bucket
```json
{
  "sourceBucketKey": "test.jpg",
  "assetId": "frombucket",
  "imageQuality": 90
}
```

### 2. Image Manipulation

#### Crop
```json
{
  "sourceBucketKey": "image.jpg",
  "newAssetId": "cropped",
  "crop": {
    "x": 800,
    "y": 100,
    "width": 300,
    "height": 300
  }
}
```

#### Resize
```json
{
  "sourceBucketKey": "image.jpg",
  "newAssetId": "resized",
  "resize": {
    "width": 300,
    "height": 300
  }
}
```

#### Rotate
```json
{
  "sourceBucketKey": "image.jpg",
  "newAssetId": "rotate",
  "rotate": 45
}
```

### 3. Tile Creation

#### By BucketKey
```json
{
  "sourceBucketKey": "test.jpg",
  "horizontalAssetId": "test_horizontal",
  "verticalAssetId": "test_vertical"
}
```

#### By URL
```json
{
  "sourceUrl": "https://www.example.com/test.jpg",
  "horizontalAssetId": "test_horizontal",
  "verticalAssetId": "test_vertical"
}
```

## Response Format

All operations return a JSON response with metadata about the processed image:

```json
{
  "assetId": "example",
  "bucketKey": "example.jpg",
  "mimeType": "JPEG",
  "width": 300,
  "height": 300,
  "transparent": false,
  "convertedFilesize": 22652
}
```

## Deployment

The Lambda function can be deployed using the provided CloudFormation templates:

- `buckets-cloudformation.yml`: Creates the necessary S3 buckets.
- `function-cloudformation.yml`: Creates the Lambda function.

## Development

To modify the Lambda function:

1. Update the relevant files in the `src` directory.
2. Build and deploy the Lambda function using the provided scripts.

## Image Processing Details

### Supported Formats

The Lambda function supports the following image formats:

- JPEG
- PNG
- WebP
- AVIF
- TIFF
- GIF
- SVG
- HEIC/HEIF (with libheif)

### Performance Considerations

Sharp is significantly faster than ImageMagick for most operations. However, there are a few things to keep in mind:

- Large images are automatically resized to a maximum resolution of 5000x5000 pixels to prevent memory issues
- The Lambda function uses a thread pool size of 64 to maximize performance
- Format conversion is automatic based on image content (transparent images are converted to PNG, others to JPEG)
- HEIC/HEIF images are supported through the libheif library

### HEIC/HEIF Support

HEIC/HEIF support is provided through the libheif library, which is installed in the Docker image. Sharp automatically uses libheif when processing HEIC/HEIF images.
