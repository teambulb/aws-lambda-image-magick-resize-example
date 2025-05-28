/**
 * @fileoverview Image manipulation operations (crop, resize, rotate)
 * @author Bulb Inc.
 * @copyright 2021, Bulb Inc.
 */

"use strict";

const path = require("path");
const { exists, existsOrZero } = require("./utils");
const BaseRequest = require("./baseRequest");

const tempFolder = "/tmp/";
const defaultMaxResolution = 5000;

/**
 * Class for cropping an image
 * @extends BaseRequest
 */
class Crop extends BaseRequest {
  /**
   * Creates a new Crop instance
   * @param {Object} body - The request body
   * @param {Function} lambdaCallback - The Lambda callback function
   */
  constructor(body, lambdaCallback) {
    super();
    this.sourceBucketKey = body.sourceBucketKey;
    this.assetId = body.newAssetId;
    this.crop = body.crop;
    this.lambdaCallback = lambdaCallback;
  }

  /**
   * Gets the x coordinate for cropping
   * @returns {number} The x coordinate
   */
  x() {
    return parseInt(this.crop.x) || 0;
  }

  /**
   * Gets the y coordinate for cropping
   * @returns {number} The y coordinate
   */
  y() {
    return parseInt(this.crop.y) || 0;
  }

  /**
   * Gets the width for cropping
   * @returns {number} The width
   */
  width() {
    return parseInt(this.crop.width);
  }

  /**
   * Gets the height for cropping
   * @returns {number} The height
   */
  height() {
    return parseInt(this.crop.height);
  }

  /**
   * Checks if the request is valid
   * @returns {boolean} True if the request is valid
   */
  isValid() {
    return (
      exists(this.assetId) &&
      exists(this.sourceBucketKey) &&
      exists(this.crop) &&
      existsOrZero(this.crop.x) &&
      existsOrZero(this.crop.y) &&
      exists(this.crop.width) &&
      exists(this.crop.height) &&
      !isNaN(parseInt(this.crop.x)) && // Verify x is a number
      !isNaN(parseInt(this.crop.y)) && // Verify y is a number
      !isNaN(parseInt(this.crop.width)) && // Verify width is a number
      !isNaN(parseInt(this.crop.height))
    ); // Verify height is a number
  }

  /**
   * Starts the crop process
   * @returns {Promise<void>}
   */
  async start() {
    const analyticsSegment = this.createAnalyticsSegment("CropRequest");
    analyticsSegment.addAnnotation("RequestType", "Crop");
    analyticsSegment.addMetadata("sourceBucketKey", this.sourceBucketKey);
    analyticsSegment.addMetadata("assetId", this.assetId);
    analyticsSegment.addMetadata("crop", JSON.stringify(this.crop));

    await this.clearTempFolder();
    this.makeTempFolder();

    const uniqueNumber = String(Date.now());
    const saveFile = path.join(tempFolder, this.getAssetId(), uniqueNumber); // /tmp/12345/11010101
    const newBucketKey = this.getAssetId() + path.extname(this.sourceBucketKey);
    let modifiedFile = path.join(
      tempFolder,
      this.getAssetId(),
      uniqueNumber + "-cropped",
    );

    let downloaded = await this.downloadFromS3(saveFile, this.sourceBucketKey);

    if (downloaded === false) {
      // Failed to download, exit
      return;
    }

    let meta = await this.imGetMeta(saveFile);
    if (meta !== false) {
      modifiedFile += meta["convertedFileExtension"];
      await this.imCrop(saveFile, modifiedFile, meta);
    }

    this.removeFile(saveFile);

    await this.uploadImageWithoutConversion(modifiedFile, newBucketKey);
    analyticsSegment.close();
  }

  /**
   * Crops an image
   * @param {string} sourceFile - The path to the source file
   * @param {string} modifiedFile - The path to the modified file
   * @param {Object} meta - The image metadata
   * @returns {Promise<void>}
   */
  async imCrop(sourceFile, modifiedFile, meta) {
    const analyticsSegment = this.createAnalyticsSegment("performCrop");

    try {
      const sharp = require('sharp');

      // Create a Sharp instance
      let sharpInstance = sharp(sourceFile);

      // Auto-orient based on EXIF data
      sharpInstance = sharpInstance.rotate();

      // If the image needs to be resized first (to prevent memory issues)
      if (meta.needsToBeResized) {
        sharpInstance = sharpInstance.resize({
          width: defaultMaxResolution,
          height: defaultMaxResolution,
          fit: 'inside',
          withoutEnlargement: true
        });
      }

      // Extract the region specified by crop parameters
      sharpInstance = sharpInstance.extract({
        left: this.x(),
        top: this.y(),
        width: this.width(),
        height: this.height()
      });

      // Determine output format based on transparency
      if (meta.transparent) {
        sharpInstance = sharpInstance.png({ compressionLevel: 9 });
      } else {
        sharpInstance = sharpInstance.jpeg({ quality: 90 });
      }

      // Write the output file
      await sharpInstance.toFile(modifiedFile);

      analyticsSegment.close();
    } catch (err) {
      this.removeFile(sourceFile);
      this.removeFile(modifiedFile);
      console.log(err);
      analyticsSegment.close();
      this.sendJSONErrorResponse("Failed to crop image.", "Unknown");
    }
  }
}

/**
 * Class for resizing an image
 * @extends BaseRequest
 */
class Resize extends BaseRequest {
  /**
   * Creates a new Resize instance
   * @param {Object} body - The request body
   * @param {Function} lambdaCallback - The Lambda callback function
   */
  constructor(body, lambdaCallback) {
    super();
    this.sourceBucketKey = body.sourceBucketKey;
    this.assetId = body.newAssetId;
    this.resize = body.resize;
    this.lambdaCallback = lambdaCallback;
  }

  /**
   * Gets the width for resizing
   * @returns {number} The width
   */
  width() {
    return parseInt(this.resize.width);
  }

  /**
   * Gets the height for resizing
   * @returns {number} The height
   */
  height() {
    return parseInt(this.resize.height);
  }

  /**
   * Checks if the request is valid
   * @returns {boolean} True if the request is valid
   */
  isValid() {
    return (
      exists(this.assetId) &&
      exists(this.sourceBucketKey) &&
      exists(this.resize) &&
      exists(this.resize.width) &&
      exists(this.resize.height) &&
      !isNaN(parseInt(this.resize.width)) && // Verify width is a number
      !isNaN(parseInt(this.resize.height))
    ); // Verify height is a number
  }

  /**
   * Starts the resize process
   * @returns {Promise<void>}
   */
  async start() {
    const analyticsSegment = this.createAnalyticsSegment("ResizeRequest");
    analyticsSegment.addAnnotation("RequestType", "Resize");
    analyticsSegment.addMetadata("sourceBucketKey", this.sourceBucketKey);
    analyticsSegment.addMetadata("assetId", this.assetId);
    analyticsSegment.addMetadata("resize", JSON.stringify(this.resize));

    await this.clearTempFolder();
    this.makeTempFolder();

    const uniqueNumber = String(Date.now());
    const saveFile = path.join(tempFolder, this.getAssetId(), uniqueNumber); // /tmp/12345/11010101
    const newBucketKey = this.getAssetId() + path.extname(this.sourceBucketKey);
    let modifiedFile = path.join(
      tempFolder,
      this.getAssetId(),
      uniqueNumber + "-resized",
    );

    let downloaded = await this.downloadFromS3(saveFile, this.sourceBucketKey);
    if (downloaded === false) {
      // Failed to download, exit
      return;
    }

    let meta = await this.imGetMeta(saveFile);
    if (meta !== false) {
      modifiedFile += meta["convertedFileExtension"];
      await this.imResize(saveFile, modifiedFile, meta);
    }

    this.removeFile(saveFile);

    await this.uploadImageWithoutConversion(modifiedFile, newBucketKey);
    analyticsSegment.close();
  }

  /**
   * Resizes an image
   * @param {string} sourceFile - The path to the source file
   * @param {string} modifiedFile - The path to the modified file
   * @param {Object} meta - The image metadata
   * @returns {Promise<void>}
   */
  async imResize(sourceFile, modifiedFile, meta) {
    const analyticsSegment = this.createAnalyticsSegment("performResize");

    try {
      const sharp = require('sharp');

      // Create a Sharp instance
      let sharpInstance = sharp(sourceFile);

      // Auto-orient based on EXIF data
      sharpInstance = sharpInstance.rotate();

      // Resize the image to the specified dimensions
      sharpInstance = sharpInstance.resize({
        width: this.width(),
        height: this.height(),
        fit: 'inside',
        withoutEnlargement: false
      });

      // Determine output format based on transparency
      if (meta.transparent) {
        sharpInstance = sharpInstance.png({ compressionLevel: 9 });
      } else {
        sharpInstance = sharpInstance.jpeg({ quality: 90 });
      }

      // Write the output file
      await sharpInstance.toFile(modifiedFile);

      analyticsSegment.close();
    } catch (err) {
      this.removeFile(sourceFile);
      this.removeFile(modifiedFile);
      console.log(err);
      analyticsSegment.close();
      this.sendJSONErrorResponse("Failed to resize image.", "Unknown");
    }
  }
}

/**
 * Class for rotating an image
 * @extends BaseRequest
 */
class Rotate extends BaseRequest {
  /**
   * Creates a new Rotate instance
   * @param {Object} body - The request body
   * @param {Function} lambdaCallback - The Lambda callback function
   */
  constructor(body, lambdaCallback) {
    super();
    this.sourceBucketKey = body.sourceBucketKey;
    this.assetId = body.newAssetId;
    this.rotate = body.rotate;
    this.lambdaCallback = lambdaCallback;
  }

  /**
   * Gets the angle for rotation
   * @returns {number} The angle
   */
  angle() {
    return parseInt(this.rotate) || 0;
  }

  /**
   * Checks if the request is valid
   * @returns {boolean} True if the request is valid
   */
  isValid() {
    return (
      exists(this.assetId) &&
      exists(this.sourceBucketKey) &&
      existsOrZero(this.rotate) &&
      !isNaN(parseInt(this.rotate))
    ); // Verify rotate is a number
  }

  /**
   * Starts the rotate process
   * @returns {Promise<void>}
   */
  async start() {
    const analyticsSegment = this.createAnalyticsSegment("RotateRequest");
    analyticsSegment.addAnnotation("RequestType", "Rotate");
    analyticsSegment.addMetadata("sourceBucketKey", this.sourceBucketKey);
    analyticsSegment.addMetadata("assetId", this.assetId);
    analyticsSegment.addMetadata("rotate", this.rotate);

    await this.clearTempFolder();
    this.makeTempFolder();

    const uniqueNumber = String(Date.now());
    const saveFile = path.join(tempFolder, this.getAssetId(), uniqueNumber); // /tmp/12345/11010101
    const newBucketKey = this.getAssetId() + path.extname(this.sourceBucketKey);
    let modifiedFile = path.join(
      tempFolder,
      this.getAssetId(),
      uniqueNumber + "-rotated",
    );

    let downloaded = await this.downloadFromS3(saveFile, this.sourceBucketKey);

    if (downloaded === false) {
      // Failed to download, exit
      return;
    }

    let meta = await this.imGetMeta(saveFile);
    if (meta !== false) {
      modifiedFile += meta["convertedFileExtension"];
      await this.imRotate(saveFile, modifiedFile, meta);
    }

    this.removeFile(saveFile);

    await this.uploadImageWithoutConversion(modifiedFile, newBucketKey);
    analyticsSegment.close();
  }

  /**
   * Rotates an image
   * @param {string} sourceFile - The path to the source file
   * @param {string} modifiedFile - The path to the modified file
   * @param {Object} meta - The image metadata
   * @returns {Promise<void>}
   */
  async imRotate(sourceFile, modifiedFile, meta) {
    const analyticsSegment = this.createAnalyticsSegment("performRotate");

    try {
      const sharp = require('sharp');

      // Create a Sharp instance
      let sharpInstance = sharp(sourceFile);

      // Auto-orient based on EXIF data and apply additional rotation
      sharpInstance = sharpInstance.rotate(this.angle());

      // If the image needs to be resized first (to prevent memory issues)
      if (meta.needsToBeResized) {
        sharpInstance = sharpInstance.resize({
          width: defaultMaxResolution,
          height: defaultMaxResolution,
          fit: 'inside',
          withoutEnlargement: true
        });
      }

      // Determine output format based on transparency
      if (meta.transparent) {
        sharpInstance = sharpInstance.png({ compressionLevel: 9 });
      } else {
        sharpInstance = sharpInstance.jpeg({ quality: 90 });
      }

      // Write the output file
      await sharpInstance.toFile(modifiedFile);

      analyticsSegment.close();
    } catch (err) {
      this.removeFile(sourceFile);
      this.removeFile(modifiedFile);
      console.log(err);
      analyticsSegment.close();
      this.sendJSONErrorResponse("Failed to rotate image.", "Unknown");
    }
  }
}

module.exports = {
  Crop,
  Resize,
  Rotate
};
