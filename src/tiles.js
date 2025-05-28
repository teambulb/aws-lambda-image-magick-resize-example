/**
 * @fileoverview Tile creation operations for image processing
 * @author Bulb Inc.
 * @copyright 2021, Bulb Inc.
 */

"use strict";

const path = require("path");
const { exists } = require("./utils");
const BaseRequest = require("./baseRequest");

const tempFolder = "/tmp/";

/**
 * Class for creating tiles from an image
 * @extends BaseRequest
 */
class CreateTiles extends BaseRequest {
  /**
   * Creates a new CreateTiles instance
   * @param {Object} body - The request body
   * @param {Function} lambdaCallback - The Lambda callback function
   */
  constructor(body, lambdaCallback) {
    super();
    this.sourceBucketKey = body.sourceBucketKey;
    this.sourceUrl = body.sourceUrl;
    this.horizontalAssetId = body.horizontalAssetId;
    this.verticalAssetId = body.verticalAssetId;
    this.assetId = body.horizontalAssetId;
    this.lambdaCallback = lambdaCallback;
  }

  /**
   * Gets the horizontal tile properties
   * @returns {Object} The horizontal tile properties
   */
  horizontalTile() {
    return { width: 460, height: 260, imageQuality: 90 };
  }

  /**
   * Gets the vertical tile properties
   * @returns {Object} The vertical tile properties
   */
  verticalTile() {
    return { width: 210, height: 221, imageQuality: 90 };
  }

  /**
   * Checks if the request is valid
   * @returns {boolean} True if the request is valid
   */
  isValid() {
    return (
      (exists(this.sourceBucketKey) || exists(this.sourceUrl)) &&
      exists(this.horizontalAssetId) &&
      exists(this.verticalAssetId)
    );
  }

  /**
   * Starts the tile creation process
   * @returns {Promise<void>}
   */
  async start() {
    const analyticsSegment = this.createAnalyticsSegment("CreateTilesRequest");
    analyticsSegment.addAnnotation("RequestType", "CreateTiles");
    analyticsSegment.addMetadata(
      "sourceBucketKey",
      this.sourceBucketKey || "none",
    );
    analyticsSegment.addMetadata("sourceUrl", this.sourceUrl || "none");
    analyticsSegment.addMetadata("horizontalAssetId", this.horizontalAssetId);
    analyticsSegment.addMetadata("verticalAssetId", this.verticalAssetId);

    await this.clearTempFolder();
    this.makeTempFolder();

    const uniqueNumber = String(Date.now());

    // The sharedAssetId needs to be set to either the horizontal or vertical assetId.
    // This is used to help generate the unique folder needed to save the downloaded and
    // generated images.
    // We set this.assetId to horizontalAssetId in the constructor.
    const sharedAssetId = this.assetId;
    const horizontalFile = path.join(
      tempFolder,
      sharedAssetId,
      uniqueNumber + "-horizontal.jpg",
    );
    const verticalFile = path.join(
      tempFolder,
      sharedAssetId,
      uniqueNumber + "-vertical.jpg",
    );
    const horizontalNewBucketKey = this.horizontalAssetId + ".jpg";
    const verticalNewBucketKey = this.verticalAssetId + ".jpg";

    const saveFile = path.join(tempFolder, sharedAssetId, uniqueNumber); // /tmp/12345/11010101

    // Download source image
    let downloaded = false;

    if (exists(this.sourceUrl)) {
      downloaded = await this.downloadFromURL(this.sourceUrl, saveFile);
    } else if (exists(this.sourceBucketKey)) {
      downloaded = await this.downloadFromS3(saveFile, this.sourceBucketKey);
    }

    if (downloaded === false) {
      // Failed to download, exit
      return;
    }

    // Create both tiles
    await this.imMakeTile(this.horizontalTile(), saveFile, horizontalFile);
    await this.imMakeTile(this.verticalTile(), saveFile, verticalFile);

    // Delete source image
    this.removeFile(saveFile);

    // Upload tiles and delete from local disk
    await this.uploadMultipleImagesWithoutConversion([
      {
        fileOnDisk: horizontalFile,
        newBucketKey: horizontalNewBucketKey,
        assetId: this.horizontalAssetId,
      },
      {
        fileOnDisk: verticalFile,
        newBucketKey: verticalNewBucketKey,
        assetId: this.verticalAssetId,
      },
    ]);

    analyticsSegment.close();
  }

  /**
   * Creates a tile from an image
   * @param {Object} tileProperties - The tile properties
   * @param {string} sourceFile - The path to the source file
   * @param {string} modifiedFile - The path to the modified file
   * @returns {Promise<void>}
   */
  async imMakeTile(tileProperties, sourceFile, modifiedFile) {
    let meta = await this.imGetMeta(sourceFile);
    if (meta === false) {
      // MetaData is invalid, exit
      return;
    }

    const analyticsSegment = this.createAnalyticsSegment("performMakeTile");

    const width = tileProperties.width;
    const height = tileProperties.height;
    const imageQuality = tileProperties.imageQuality;

    try {
      const sharp = require('sharp');

      // Create a Sharp instance
      let sharpInstance = sharp(sourceFile);

      // Auto-orient based on EXIF data
      sharpInstance = sharpInstance.rotate();

      // Resize to cover the target dimensions (like CSS background-size: cover)
      sharpInstance = sharpInstance.resize({
        width: width,
        height: height,
        fit: 'cover',
        position: 'center'
      });

      // Set output format and quality
      sharpInstance = sharpInstance.jpeg({ quality: imageQuality });

      // Write the output file
      await sharpInstance.toFile(modifiedFile);

      analyticsSegment.close();
    } catch (err) {
      // Because we wait until upload for vertical and horizontal to be removed from disk,
      // it is possible that if this catch statement is called that one of the modified images
      // might not get deleted and stay on disk.
      // The workaround is upon the next launch of the lambda all temp files will be deleted.
      this.removeFile(sourceFile);
      this.removeFile(modifiedFile);
      console.log(err);
      analyticsSegment.close();
      this.sendJSONErrorResponse("Failed to create a tile.", "Unknown");
    }
  }
}

module.exports = CreateTiles;
