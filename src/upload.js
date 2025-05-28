/**
 * @fileoverview Upload operations for image processing
 * @author Bulb Inc.
 * @copyright 2021, Bulb Inc.
 */

"use strict";

const path = require("path");
const { exists } = require("./utils");
const BaseRequest = require("./baseRequest");

const tempFolder = "/tmp/";

/**
 * Class for handling uploads from a URL
 * @extends BaseRequest
 */
class UploadFromUrl extends BaseRequest {
  /**
   * Creates a new UploadFromUrl instance
   * @param {Object} body - The request body
   * @param {Function} lambdaCallback - The Lambda callback function
   */
  constructor(body, lambdaCallback) {
    super();
    this.sourceUrl = body.sourceUrl;
    this.assetId = body.assetId;
    this.imageQuality = body.imageQuality;
    this.lambdaCallback = lambdaCallback;
  }

  /**
   * Checks if the request is valid
   * @returns {boolean} True if the request is valid
   */
  isValid() {
    return exists(this.sourceUrl) && exists(this.assetId);
  }

  /**
   * Starts the upload process
   * @returns {Promise<void>}
   */
  async start() {
    const analyticsSegment = this.createAnalyticsSegment(
      "UploadFromUrlRequest",
    );
    analyticsSegment.addAnnotation("RequestType", "UploadFromUrl");
    analyticsSegment.addMetadata("sourceUrl", this.sourceUrl);
    analyticsSegment.addMetadata("assetId", this.assetId);
    analyticsSegment.addMetadata("imageQuality", this.imageQuality);

    await this.clearTempFolder();
    this.makeTempFolder();

    const uniqueNumber = String(Date.now());

    let saveFile = path.join(tempFolder, this.getAssetId(), uniqueNumber); // /tmp/12345/11010101

    await this.downloadFromURL(this.sourceUrl, saveFile);
    await this.uploadImage(saveFile, uniqueNumber);
    analyticsSegment.close();
  }
}

/**
 * Class for handling uploads from an S3 bucket
 * @extends BaseRequest
 */
class UploadFromBucket extends BaseRequest {
  /**
   * Creates a new UploadFromBucket instance
   * @param {Object} body - The request body
   * @param {Function} lambdaCallback - The Lambda callback function
   */
  constructor(body, lambdaCallback) {
    super();
    this.sourceBucketKey = body.sourceBucketKey;
    this.assetId = body.assetId;
    this.imageQuality = body.imageQuality;
    this.lambdaCallback = lambdaCallback;
  }

  /**
   * Checks if the request is valid
   * @returns {boolean} True if the request is valid
   */
  isValid() {
    return exists(this.sourceBucketKey) && exists(this.assetId);
  }

  /**
   * Starts the upload process
   * @returns {Promise<void>}
   */
  async start() {
    const analyticsSegment = this.createAnalyticsSegment(
      "UploadFromBucketRequest",
    );
    analyticsSegment.addAnnotation("RequestType", "UploadFromBucket");
    analyticsSegment.addMetadata("sourceBucketKey", this.sourceBucketKey);
    analyticsSegment.addMetadata("assetId", this.assetId);
    analyticsSegment.addMetadata("imageQuality", this.imageQuality);

    await this.clearTempFolder();
    this.makeTempFolder();

    const uniqueNumber = String(Date.now());

    let saveFile = path.join(tempFolder, this.getAssetId(), uniqueNumber); // /tmp/12345/11010101
    let downloaded = await this.downloadFromS3(saveFile, this.sourceBucketKey);

    if (downloaded === false) {
      // Failed to download, exit
      return;
    }

    console.log("Uploading to destination S3");
    await this.uploadImage(saveFile, uniqueNumber);
    analyticsSegment.close();
  }
}

module.exports = {
  UploadFromUrl,
  UploadFromBucket
};
