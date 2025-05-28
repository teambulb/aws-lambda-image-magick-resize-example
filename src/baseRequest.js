/**
 * @fileoverview Base request class for image processing operations
 * @author Bulb Inc.
 * @copyright 2021, Bulb Inc.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const process = require("process");
const { Readable } = require('stream');

// Third Party Dependencies
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const AWSXRay = require("aws-xray-sdk-core");
const s3Client = new S3Client();

const { exists, contains, execPromise } = require("./utils");

const tempFolder = "/tmp/";
const defaultJpegQuality = 90;
const defaultMaxResolution = 5000;
const bucketName = process.env.image_bucket;

/**
 * Base class for all image processing requests
 * Contains common functionality used by all request types
 */
class BaseRequest {
  /**
   * Creates a new BaseRequest instance
   */
  constructor() {
    this.xRayBaseSegment = AWSXRay.getSegment();
  }

  /**
   * Creates a new analytics segment for tracking
   * @param {string} name - The name of the segment
   * @returns {Object} The created segment
   */
  createAnalyticsSegment(name) {
    return this.xRayBaseSegment.addNewSubsegment(name);
  }

  /**
   * Gets the asset ID for the request
   * @returns {string} The asset ID
   */
  getAssetId() {
    if (!this.assetId) {
      this.sendJSONErrorResponse("Missing assetID variable", "Unknown");
      return "ERROR";
    }
    return String(this.assetId);
  }

  /**
   * Gets the image quality for the request
   * @returns {number} The image quality
   */
  getImageQuality() {
    if (
      exists(this.imageQuality) &&
      parseInt(this.imageQuality) <= 100 &&
      parseInt(this.imageQuality) > 0
    ) {
      return this.imageQuality;
    }
    return defaultJpegQuality;
  }

  /**
   * Gets the Lambda callback function
   * @returns {Function} The Lambda callback function
   */
  getLambdaCallback() {
    if (!this.lambdaCallback) {
      this.sendJSONErrorResponse(
        "Missing LAMBDA callback",
        "This should be impossible if deployed to AWS.",
      );
      return "ERROR";
    }
    return this.lambdaCallback;
  }

  /**
   * Sends a JSON response
   * @param {number} statusCode - The HTTP status code
   * @param {Object} body - The response body
   */
  sendJSONResponse(statusCode, body) {
    let response = {
      statusCode: statusCode,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    };
    if (global.currentRuntimeCounter) {
      clearInterval(global.currentRuntimeCounter);
    }
    this.getLambdaCallback()(null, response);
  }

  /**
   * Sends a JSON error response
   * @param {string} reason - The error reason
   * @param {string} detail - The error details
   */
  sendJSONErrorResponse(reason, detail) {
    let error = {
      reason: String(reason),
      detail: String(detail),
    };

    const analyticsSegment = this.createAnalyticsSegment("Error");
    const errorString = `${error.reason} ${error.detail}`;
    analyticsSegment.addAnnotation("Error", errorString);
    analyticsSegment.addError(errorString);
    analyticsSegment.addErrorFlag();
    analyticsSegment.close();

    this.sendJSONResponse(400, error);
  }

  /**
   * Creates a temporary folder for the asset
   */
  makeTempFolder() {
    fs.mkdirSync(tempFolder + this.getAssetId(), { recursive: true });
  }

  /**
   * Clears the temporary folder
   * @returns {Promise<void>}
   */
  async clearTempFolder() {
    await execPromise("rm -rf /tmp/*");
  }

  /**
   * Uploads an image to S3
   * @param {string} saveFile - The path to the file to upload
   * @param {string} uniqueNumber - A unique number for the file
   * @returns {Promise<void>}
   */
  async uploadImage(saveFile, uniqueNumber) {
    let meta = await this.imGetMeta(saveFile);
    if (meta === false) {
      // MetaData is invalid, exit
      return;
    }

    console.log(`UploadImage: Retrieved source meta: ${saveFile}`);
    let sourceMimeType = meta["mimeType"];
    let sourceWidth = meta["width"];
    let sourceHeight = meta["height"];
    let sourceTransparent = meta["transparent"];
    let sourceFileSize = meta["filesize"];
    let needsToBeResized = meta["needsToBeResized"];
    let saveFileExtension = meta["convertedFileExtension"];

    let saveFileModified = path.join(
      tempFolder,
      this.getAssetId(),
      uniqueNumber + saveFileExtension,
    );
    console.log(
      `UploadImage: File to convert destination: ${saveFileModified}`,
    );
    const destinationBucketKey = this.getAssetId() + saveFileExtension;

    let converted = await this.imConvert(
      needsToBeResized,
      saveFile,
      saveFileModified,
    );
    if (converted === false) {
      // Failed to convert, exit
      return;
    }

    console.log(`UploadImage: File converted: ${saveFileModified}`);

    let convertedMeta = await this.imGetMeta(saveFileModified);
    if (convertedMeta === false) {
      // MetaData is invalid, exit
      return;
    }

    console.log(`UploadImage: Retrieved converted meta: ${saveFileModified}`);
    let convertedFileSize = convertedMeta["filesize"];
    let convertedWidth = convertedMeta["width"];
    let convertedHeight = convertedMeta["height"];
    let convertedMimeType = convertedMeta["convertedMimeType"];

    console.log(
      `UploadImage: Uploading final image to s3: ${saveFileModified} destinationBucketKey: ${destinationBucketKey}`,
    );

    let uploaded = await this.uploadToS3(
      saveFileModified,
      convertedMimeType,
      destinationBucketKey,
    );
    if (uploaded === false) {
      // Failed to upload, exit
      return;
    }

    console.log(
      `UploadImage: Success uploading final image to s3: ${saveFileModified} destinationBucketKey: ${destinationBucketKey}`,
    );

    await this.printDiskSpace();
    this.removeFile(saveFile);
    this.removeFile(saveFileModified);

    this.sendJSONResponse(200, {
      assetId: this.getAssetId(),
      bucketKey: destinationBucketKey,
      sourceMimeType: sourceMimeType,
      sourceWidth: sourceWidth,
      sourceHeight: sourceHeight,
      sourceFilesize: sourceFileSize,
      convertedMimeType: convertedMimeType,
      convertedWidth: convertedWidth,
      convertedHeight: convertedHeight,
      convertedFilesize: convertedFileSize,
      transparent: sourceTransparent,
    });
  }

  /**
   * Uploads an image with the given parameters
   * @param {string} fileOnDisk - The path to the file on disk
   * @param {string} newBucketKey - The new bucket key
   * @param {string} assetId - The asset ID
   * @returns {Promise<Object>} The upload result
   */
  async uploadImageWith(fileOnDisk, newBucketKey, assetId) {
    let meta = await this.imGetMeta(fileOnDisk);
    if (meta === false) {
      // MetaData is invalid, exit
      return;
    }

    let sourceMimeType = meta["mimeType"];
    let convertedFileSize = meta["filesize"];
    let convertedWidth = meta["width"];
    let convertedHeight = meta["height"];
    let sourceTransparent = meta["transparent"];

    let uploaded = await this.uploadToS3(
      fileOnDisk,
      sourceMimeType,
      newBucketKey,
    );

    if (uploaded === false) {
      // Failed to upload, exit
      return;
    }

    await this.printDiskSpace();
    this.removeFile(fileOnDisk);

    return {
      assetId: assetId,
      bucketKey: newBucketKey,
      mimeType: sourceMimeType,
      width: convertedWidth,
      height: convertedHeight,
      transparent: sourceTransparent,
      convertedFilesize: convertedFileSize,
    };
  }

  /**
   * Uploads multiple images without conversion
   * @param {Array<Object>} multipleImages - Array of image objects
   * @returns {Promise<void>}
   */
  async uploadMultipleImagesWithoutConversion(multipleImages) {
    let uploadResults = [];
    for (const image of multipleImages) {
      let uploadResult = await this.uploadImageWith(
        image.fileOnDisk,
        image.newBucketKey,
        image.assetId,
      );
      uploadResults.push(uploadResult);
    }
    this.sendJSONResponse(200, uploadResults);
  }

  /**
   * Uploads an image without conversion
   * @param {string} fileOnDisk - The path to the file on disk
   * @param {string} newBucketKey - The new bucket key
   * @returns {Promise<void>}
   */
  async uploadImageWithoutConversion(fileOnDisk, newBucketKey) {
    let uploadResult = await this.uploadImageWith(
      fileOnDisk,
      newBucketKey,
      this.getAssetId(),
    );
    this.sendJSONResponse(200, uploadResult);
  }

  /**
   * Gets metadata for an image
   * @param {string} sourceFile - The path to the source file
   * @returns {Promise<Object|boolean>} The metadata or false if failed
   */
  async imGetMeta(sourceFile) {
    const analyticsSegment = this.createAnalyticsSegment("getMetaData");
    analyticsSegment.addMetadata("sourceFile", sourceFile);

    let meta = {
      mimeType: "",
      fileExtension: "",
      convertedMimeType: "",
      convertedFileExtension: "",
      width: 0,
      height: 0,
      transparent: false,
      filesize: 0,
      needsToBeResized: false,
    };

    try {
      const sharp = require('sharp');
      const fs = require('fs');

      // Get file stats for filesize
      const stats = fs.statSync(sourceFile);
      meta.filesize = stats.size;

      // Get image metadata using Sharp
      const metadata = await sharp(sourceFile).metadata();

      // Set basic metadata
      meta.width = metadata.width;
      meta.height = metadata.height;

      // Check if image needs to be resized
      if (
        meta.width > defaultMaxResolution ||
        meta.height > defaultMaxResolution
      ) {
        meta.needsToBeResized = true;
      }

      // Determine format/mime type
      meta.mimeType = metadata.format ? metadata.format.toUpperCase() : "";

      // Check for transparency (hasAlpha or channels > 3)
      meta.transparent = metadata.hasAlpha || (metadata.channels && metadata.channels > 3);

      console.log(`Image metadata: ${JSON.stringify(metadata)}`);
    } catch (err) {
      console.log("Error getting meta data. Removing File. " + sourceFile);
      this.removeFile(sourceFile);
      console.log("Error getting meta data. File removed. " + sourceFile);
      console.error(err);
      analyticsSegment.close();
      this.sendJSONErrorResponse("Failed to get meta data.", "Unknown");
      return false;
    }

    // Supported formats with Sharp:
    // - JPEG
    // - PNG
    // - WebP
    // - AVIF
    // - TIFF
    // - GIF
    // - SVG
    // - HEIC/HEIF (with libheif)

    let convertToPNGorJPG = function () {
      if (meta.transparent) {
        meta.convertedFileExtension = ".png";
        meta.convertedMimeType = "PNG";
      } else {
        meta.convertedFileExtension = ".jpg";
        meta.convertedMimeType = "JPEG";
      }
    };

    // Normalize format name
    const format = meta.mimeType.toLowerCase();

    // Set file extension based on format
    switch (format) {
      case "jpeg":
        meta.fileExtension = ".jpg";
        convertToPNGorJPG();
        break;
      case "jpg":
        meta.fileExtension = ".jpg";
        convertToPNGorJPG();
        break;
      case "webp":
        meta.fileExtension = ".webp";
        convertToPNGorJPG();
        break;
      case "tiff":
        meta.fileExtension = ".tiff";
        convertToPNGorJPG();
        break;
      case "svg":
        meta.fileExtension = ".svg";
        convertToPNGorJPG();
        break;
      case "bmp":
        meta.fileExtension = ".bmp";
        convertToPNGorJPG();
        break;
      case "heif":
      case "heic":
        meta.fileExtension = ".heic";
        convertToPNGorJPG();
        break;
      case "avif":
        meta.fileExtension = ".avif";
        convertToPNGorJPG();
        break;
      case "png":
        meta.fileExtension = ".png";
        convertToPNGorJPG();
        break;
      case "gif":
        meta.fileExtension = ".gif";
        meta.convertedFileExtension = ".gif";
        meta.convertedMimeType = "GIF";
        break;
      default:
        this.removeFile(sourceFile);
        this.sendJSONErrorResponse(
          "Unsupported file extension.",
          meta.mimeType,
        );
        return;
    }

    try {
      analyticsSegment.addMetadata("meta", JSON.stringify(meta));
    } catch (err) {
      console.log("Error stringifying `meta` object. " + sourceFile);
      console.error(err);
    }

    analyticsSegment.close();
    return meta;
  }

  /**
   * Converts an image
   * @param {boolean} needsToBeResized - Whether the image needs to be resized
   * @param {string} sourceFile - The path to the source file
   * @param {string} modifiedFile - The path to the modified file
   * @returns {Promise<boolean>} True if successful, false otherwise
   */
  async imConvert(needsToBeResized, sourceFile, modifiedFile) {
    const analyticsSegment = this.createAnalyticsSegment("convertFile");
    analyticsSegment.addMetadata("sourceFile", sourceFile);
    analyticsSegment.addMetadata("modifiedFile", modifiedFile);
    analyticsSegment.addMetadata("needsToBeResized", needsToBeResized);

    try {
      const sharp = require('sharp');

      // Get metadata to determine output format
      const metadata = await sharp(sourceFile).metadata();

      // Create a Sharp instance
      let sharpInstance = sharp(sourceFile);

      // Auto-orient based on EXIF data
      sharpInstance = sharpInstance.rotate();

      // Resize if needed
      if (needsToBeResized) {
        sharpInstance = sharpInstance.resize({
          width: defaultMaxResolution,
          height: defaultMaxResolution,
          fit: 'inside',
          withoutEnlargement: true
        });
      }

      // Determine output format based on transparency
      const hasAlpha = metadata.hasAlpha || (metadata.channels && metadata.channels > 3);
      const outputFormat = hasAlpha ? 'png' : 'jpeg';

      // Set format-specific options
      if (outputFormat === 'jpeg') {
        sharpInstance = sharpInstance.jpeg({ quality: this.getImageQuality() });
      } else if (outputFormat === 'png') {
        sharpInstance = sharpInstance.png({ compressionLevel: 9 });
      }

      // Write the output file
      await sharpInstance.toFile(modifiedFile);

      analyticsSegment.close();
      return true;
    } catch (err) {
      this.removeFile(sourceFile);
      this.removeFile(modifiedFile);
      analyticsSegment.close();
      console.error(err);

      if (err.message && err.message.includes('Input file is missing')) {
        this.sendJSONErrorResponse(
          "Failed to convert image.",
          "File is of an unknown type.",
        );
      } else if (err.message && err.message.includes('memory')) {
        console.log("Failed to convert image. Image is too big.");
        this.sendJSONErrorResponse(
          "Failed to convert image.",
          "Image is too big.",
        );
      } else {
        this.sendJSONErrorResponse("Failed to convert image.", "Unknown");
      }
      return false;
    }
  }

  /**
   * Prints disk space information
   * @returns {Promise<boolean>} True if successful, false otherwise
   */
  async printDiskSpace() {
    const analyticsSegment = this.createAnalyticsSegment("getDiskSpace");
    try {
      await execPromise("df -hkm /tmp", true);
      analyticsSegment.close();
      return true;
    } catch (err) {
      console.error(err);
      analyticsSegment.close();
      this.sendJSONErrorResponse("Could not read disk space.", "Unknown");
      return false;
    }
  }

  /**
   * Removes a file from disk
   * @param {string} filename - The path to the file to remove
   */
  removeFile(filename) {
    const analyticsSegment = this.createAnalyticsSegment("removeFile");
    analyticsSegment.addMetadata("filename", filename);
    try {
      fs.unlinkSync(filename);
      console.log(`Removed file from disk: ${filename}`);
    } catch (err) {
      // Ignore, this is thrown if the file doesn't exist or has already been deleted.
    }
    analyticsSegment.close();
  }

  /**
   * Uploads a file to S3
   * @param {string} filePath - The path to the file to upload
   * @param {string} mimeTypeExtension - The MIME type extension
   * @param {string} bucketKey - The bucket key
   * @returns {Promise<boolean>} True if successful, false otherwise
   */
  async uploadToS3(filePath, mimeTypeExtension, bucketKey) {
    const analyticsSegment = this.createAnalyticsSegment("uploadToS3");
    analyticsSegment.addMetadata("filePath", filePath);
    analyticsSegment.addMetadata("mimeTypeExtension", mimeTypeExtension);
    analyticsSegment.addMetadata("bucketKey", bucketKey);
    try {
      // Read file content
      const fileContent = fs.readFileSync(filePath);

      const params = {
        Bucket: bucketName,
        Key: bucketKey,
        Body: fileContent,
        ContentType: "image/" + mimeTypeExtension.toLowerCase(),
      };

      // Use PutObjectCommand with S3Client
      const command = new PutObjectCommand(params);
      await s3Client.send(command);

      console.log(`Uploaded file to S3 and removed from disk: ${filePath}`);

      analyticsSegment.close();
      return true;
    } catch (err) {
      this.removeFile(filePath);
      console.log(err);
      analyticsSegment.close();
      if (contains(err, "The specified bucket does not exist") === true) {
        this.sendJSONErrorResponse(
          "Failed to upload to s3.",
          "The destination bucket doesn't exist.",
        );
      } else {
        this.sendJSONErrorResponse("Failed to upload to s3.", "Unknown");
      }
      return false;
    }
  }

  /**
   * Downloads a file from S3
   * @param {string} destinationFilePath - The path to save the file to
   * @param {string} bucketKey - The bucket key
   * @returns {Promise<boolean>} True if successful, false otherwise
   */
  async downloadFromS3(destinationFilePath, bucketKey) {
    const analyticsSegment = this.createAnalyticsSegment("downloadFromS3");
    analyticsSegment.addMetadata("bucketKey", bucketKey);
    analyticsSegment.addMetadata("destinationFilePath", destinationFilePath);
    try {
      const params = {
        Bucket: bucketName,
        Key: bucketKey,
      };

      // Use GetObjectCommand with S3Client
      const command = new GetObjectCommand(params);
      const response = await s3Client.send(command);

      // Create a write stream to save the file
      const fileStream = fs.createWriteStream(destinationFilePath);

      // Convert the readable stream to a Node.js stream and pipe to file
      await new Promise((resolve, reject) => {
        const responseStream = response.Body;

        // Handle stream completion
        fileStream.on("finish", () => {
          console.log(`File downloaded successfully: ${destinationFilePath}`);
          resolve();
        });

        // Handle errors
        fileStream.on("error", (err) => {
          console.log(`File stream error: ${destinationFilePath}`);
          reject(err);
        });

        responseStream.on("error", (err) => {
          console.log(`Response stream error: ${destinationFilePath}`);
          reject(err);
        });

        // Pipe the response body to the file
        responseStream.pipe(fileStream);
      });

      analyticsSegment.close();
      return true;
    } catch (err) {
      this.removeFile(destinationFilePath);
      console.log(err);
      analyticsSegment.close();
      this.sendJSONErrorResponse(
        "Failed to download from source bucket.",
        "Unknown",
      );
      return false;
    }
  }

  /**
   * Downloads a file from a URL
   * @param {string} sourceUrl - The URL to download from
   * @param {string} destinationFilePath - The path to save the file to
   * @returns {Promise<boolean>} True if successful, false otherwise
   */
  async downloadFromURL(sourceUrl, destinationFilePath) {
    const analyticsSegment = this.createAnalyticsSegment("downloadFromURL");
    analyticsSegment.addMetadata("sourceUrl", sourceUrl);
    analyticsSegment.addMetadata("destinationFilePath", destinationFilePath);
    try {
      await new Promise(async function (resolve, reject) {
        const response = await fetch(sourceUrl);
        if (!response.ok) {
          reject(new Error(`HTTP error! status: ${response.status}`));
          return;
        }

        const fileStream = fs.createWriteStream(destinationFilePath);
        fileStream.on("close", () => {
          resolve();
        });
        Readable.fromWeb(response.body)
            .on("error", (err) => {
              reject(err);
            })
            .pipe(fileStream);

      });
      analyticsSegment.close();
      return true;
    } catch (err) {
      this.removeFile(destinationFilePath);
      console.log(err);
      analyticsSegment.close();
      this.sendJSONErrorResponse(
        "Failed to download from the sourceURL.",
        "Unknown",
      );
      return false;
    }
  }
}

module.exports = BaseRequest;
