/*
 * This code is the intellectual property of Bulb Inc. and other software publishers;
 * it may not be altered, copied or disclosed without prior written approval.
 * Copyright 2021, Bulb Inc.  For more information, please email contact@hellobulb.com.
 */

"use strict";
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const process = require("process");

// Third Party Dependencies
let AWS = require("aws-sdk");
let AWSXRay = require("aws-xray-sdk");
let s3 = new AWS.S3();
const request = require("request");

const tempFolder = "/tmp/";
const defaultJpegQuality = 90;
const defaultMaxResolution = 5000;
const bucketName = process.env.image_bucket;

var currentlyRunningProcess; // This is any running process, used to terminate the process if it runs too long.
var currentRuntimeCounter; // Clear this interval when a response is sent.

class BaseRequest {
  constructor() {
    this.xRayBaseSegment = AWSXRay.getSegment();
  }

  // To begin tracking a new segment, call `this.createAnalyticsSegment('label')`.
  // Remember to call `.close()` on the tracker when you are finished.
  // To add metadata call `addMetaData()`
  // To add an annotation call `addAnnotation()`
  createAnalyticsSegment(name) {
    return this.xRayBaseSegment.addNewSubsegment(name);
  }

  getAssetId() {
    if (!this.assetId) {
      this.sendJSONErrorResponse("Missing assetID variable", "Unknown");
      return "ERROR";
    }
    return String(this.assetId);
  }

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

  sendJSONResponse(statusCode, body) {
    let response = {
      statusCode: statusCode, //200,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    };
    clearInterval(currentRuntimeCounter);
    this.getLambdaCallback()(null, response);
  }

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

  makeTempFolder() {
    fs.mkdirSync(tempFolder + this.getAssetId(), { recursive: true });
  }

  async clearTempFolder() {
    await execPromise("rm -rf /tmp/*");
  }

  async uploadImage(saveFile, uniqueNumber) {
    let meta = await this.imGetMeta(saveFile);
    if (meta == false) {
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
    if (converted == false) {
      // Failed to convert, exit
      return;
    }

    console.log(`UploadImage: File converted: ${saveFileModified}`);

    let convertedMeta = await this.imGetMeta(saveFileModified);
    if (convertedMeta == false) {
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
    if (uploaded == false) {
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

  async uploadImageWith(fileOnDisk, newBucketKey, assetId) {
    let meta = await this.imGetMeta(fileOnDisk);
    if (meta == false) {
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

    if (uploaded == false) {
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

  /*
    multipleImages =
        [
            {
                fileOnDisk: "",
                newBucketKey: "",
                assetId: ""
            }
        ]
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

  async uploadImageWithoutConversion(fileOnDisk, newBucketKey) {
    let uploadResult = await this.uploadImageWith(
      fileOnDisk,
      newBucketKey,
      this.getAssetId(),
    );
    this.sendJSONResponse(200, uploadResult);
  }

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
      transparent: false, // Possible values include: 'Undefined', 'Blend', etc
      filesize: 0, // Sometimes this comes back with `GIF` in it.  Imagemagick issue.
      needsToBeResized: false,
    };

    try {
      let metaResults = await execPromise(
        '/opt/bin/magick identify -format "%m,%w,%h,%B" ' + sourceFile,
      );
      let metaArray = String(metaResults).split(",");
      meta.mimeType = metaArray[0];
      meta.width = parseInt(metaArray[1]);
      meta.height = parseInt(metaArray[2]);
      if (
        meta.width > defaultMaxResolution ||
        meta.height > defaultMaxResolution
      ) {
        meta.needsToBeResized = true;
      }

      meta.filesize = parseInt(metaArray[3].replace("GIF", ""));
      console.log(metaResults);
    } catch (err) {
      console.log("Error getting meta data. Removing File. " + sourceFile);
      let foo1 = await execPromise("/opt/bin/magick -version");
      console.log(foo1);
      let foo2 = await execPromise("ls /opt/");
      console.log(foo2);
      this.removeFile(sourceFile);
      console.log("Error getting meta data. File removed. " + sourceFile);
      console.error(err);
      analyticsSegment.close();
      this.sendJSONErrorResponse("Failed to get meta data.", "Unknown");
      return false;
    }

    // ImageMagick could crash when detecting, so lets default to false
    // if we are unable to probe and find the actual value.
    try {
      let metaResults = await execPromise(
        '/opt/bin/magick identify -define jpeg:size=128x128 -format "%A" ' +
          sourceFile,
      );
      meta.transparent = metaResults !== "Undefined"; // Possible values include: 'Undefined', 'Blend', etc
      console.log(
        `Is image transparent: ${meta.transparent} from MetaResults: ${metaResults}`,
      );
    } catch (err) {
      console.log(
        "Error getting meta data (Transparency), marking as false and continuing. " +
          sourceFile,
      );
      console.error(err);
    }

    // Failed
    //  PSD  - (Website fails as well)
    //  ICO  - (Website fails as well)
    //  PICT  - (Website fails as well)
    //  TGA  - (Website fails as well)
    //  IFF  - (Website doesn't allow upload)
    //  SVG  - (Website doesn't allow upload)
    // Success
    //  WEBP  - (supports transparency)
    //  HEIC
    //  JPEG
    //  JPG
    //  BMP  - (supports transparency)
    //  GIF  - (supports transparency)
    //  PNG  - (supports transparency)
    //  TIF
    //  TIFF
    //  PNM(PBM,PPM)
    //  PCX
    //  SGI
    let convertToPNGorJPG = function () {
      if (meta.transparent) {
        meta.convertedFileExtension = ".png";
        meta.convertedMimeType = "PNG";
      } else {
        meta.convertedFileExtension = ".jpg";
        meta.convertedMimeType = "JPEG";
      }
    };

    switch (meta.mimeType) {
      case "JPEG":
        meta.fileExtension = ".jpg";
        convertToPNGorJPG();
        break;
      case "WEBP":
        meta.fileExtension = ".webp";
        convertToPNGorJPG();
        break;
      case "TIFF":
        meta.fileExtension = ".tiff";
        convertToPNGorJPG();
        break;
      case "SGI":
        meta.fileExtension = ".sgi";
        convertToPNGorJPG();
        break;
      case "PSD":
        meta.fileExtension = ".psd";
        convertToPNGorJPG();
        break;
      case "PPM":
        meta.fileExtension = ".ppm";
        convertToPNGorJPG();
        break;
      case "PCX":
        meta.fileExtension = ".pcx";
        convertToPNGorJPG();
        break;
      case "PBM":
        meta.fileExtension = ".pbm";
        convertToPNGorJPG();
        break;
      case "BMP":
      case "BMP2":
      case "BMP3":
        meta.fileExtension = ".bmp";
        convertToPNGorJPG();
        break;
      case "HEIC":
        meta.fileExtension = ".heic";
        convertToPNGorJPG();
        break;
      case "PNG":
        meta.fileExtension = ".png";
        convertToPNGorJPG();
        break;
      case "GIF":
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

  async imConvert(needsToBeResized, sourceFile, modifiedFile) {
    const analyticsSegment = this.createAnalyticsSegment("convertFile");
    analyticsSegment.addMetadata("sourceFile", sourceFile);
    analyticsSegment.addMetadata("modifiedFile", modifiedFile);
    analyticsSegment.addMetadata("needsToBeResized", needsToBeResized);

    // If the `needsToBeResized` flag is enabled, go ahead and force the size to 5000, this will prevent the
    // lambda from running out of memory and crashing.
    let defineSize = "";
    let resize = "";
    if (needsToBeResized) {
      defineSize = `-define jpeg:size=${defaultMaxResolution}x${defaultMaxResolution} `;
      resize = ` -scale ${defaultMaxResolution}x${defaultMaxResolution}`;
    }

    try {
      await execPromise(
        `/opt/bin/magick convert ${defineSize}${sourceFile}${resize} ` +
          ` -auto-orient -strip -limit map 64MiB -limit memory 3500MiB -quality ${this.getImageQuality()} ` +
          modifiedFile,
      );
      analyticsSegment.close();
      return true;
    } catch (err) {
      this.removeFile(sourceFile);
      this.removeFile(modifiedFile);
      analyticsSegment.close();
      console.error(err);
      if (contains(err, "no decode delegate for this image format") === true) {
        this.sendJSONErrorResponse(
          "Failed to convert image.",
          "File is of an unknown type.",
        );
      } else if (contains(err, "unable to write pixel cache") === true) {
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

  async uploadToS3(filePath, mimeTypeExtension, bucketKey) {
    const analyticsSegment = this.createAnalyticsSegment("uploadToS3");
    analyticsSegment.addMetadata("filePath", filePath);
    analyticsSegment.addMetadata("mimeTypeExtension", mimeTypeExtension);
    analyticsSegment.addMetadata("bucketKey", bucketKey);
    try {
      await new Promise(function (resolve, reject) {
        let fileStream = fs.createReadStream(filePath);
        fileStream.once("error", reject);

        let params = {
          Bucket: bucketName,
          Key: bucketKey,
          Body: fileStream,
          ContentType: "image/" + mimeTypeExtension.toLowerCase(),
        };

        s3.upload(params, null, (err, data) => {
          console.log(`Removed file from disk: ${filePath}`);
          resolve();
        });
      });
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

  async downloadFromS3(destinationFilePath, bucketKey) {
    const analyticsSegment = this.createAnalyticsSegment("downloadFromS3");
    analyticsSegment.addMetadata("bucketKey", bucketKey);
    analyticsSegment.addMetadata("destinationFilePath", destinationFilePath);
    try {
      await new Promise(function (resolve, reject) {
        const fileStream = fs.createWriteStream(destinationFilePath);
        fileStream.on("close", () => {
          console.log(`Closing file stream: ${destinationFilePath}`);
          resolve();
        });

        let params = {
          Bucket: bucketName,
          Key: bucketKey,
        };

        s3.getObject(params)
          .createReadStream()
          .on("error", (err) => {
            console.log(`Create read stream error: ${destinationFilePath}`);
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
        "Failed to download from source bucket.",
        "Unknown",
      );
      return false;
    }
  }

  async downloadFromURL(sourceUrl, destinationFilePath) {
    const analyticsSegment = this.createAnalyticsSegment("downloadFromURL");
    analyticsSegment.addMetadata("sourceUrl", sourceUrl);
    analyticsSegment.addMetadata("destinationFilePath", destinationFilePath);
    try {
      await new Promise(function (resolve, reject) {
        const fileStream = fs.createWriteStream(destinationFilePath);
        fileStream.on("close", () => {
          resolve();
        });

        request
          .get(sourceUrl)
          .on("error", (err) => {
            reject(err);
          })
          // While we are downloading the file, stream it a file on the local filesystem.
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

// Uploading
//-------------------------------------------------
/* From URL
{
	"sourceUrl": "https://www.cowherd.com/test.jpg",
	"assetId": "fromurl",
	"imageQuality": 90
}
*/

/* From Bucket
{
	"sourceBucketKey": "test.jpg",
	"assetId": "frombucket",
	"imageQuality": 90
}
*/

/* Upload Output
{
  "assetId": "heic",
  "bucketKey": "heic.jpg",
  "sourceMimeType": "JPEG",
  "sourceWidth": 4032,
  "sourceHeight": 3024,
  "sourceFilesize": 1933159,
  "convertedMimeType": "JPEG",
  "convertedWidth": 4032,
  "convertedHeight": 3024,
  "convertedFilesize": 1794035,
  "transparent": false
}
*/

// Manipulation
//-------------------------------------------------
/* Crop
{
	"sourceBucketKey": "heic.jpg",
	"newAssetId": "cropped",
	"crop": {
		"x": 800,
		"y": 100,
		"width": 300,
		"height": 300
	}
}
*/

/* Resize
{
	"sourceBucketKey": "heic.jpg",
	"newAssetId": "resized",
	"resize": {
		"width": 300,
		"height": 300
	}
}
*/

/* Rotate
{
	"sourceBucketKey": "heic.jpg",
	"newAssetId": "rotate",
	"rotate": 45
}
*/

/* Tile by BucketKey
{
    "sourceBucketKey": "test.jpg",
    "horizontalAssetId": "test_horizontal",
    "verticalAssetId": "test_vertical"
}
*/

/* Tile by URL
{
    "sourceUrl": "https://www.cowherd.com/test.jpg",
    "horizontalAssetId": "test_horizontal",
    "verticalAssetId": "test_vertical"
}
*/

/* Manipulation Output
{
  "assetId": "cropped",
  "bucketKey": "cropped.jpg",
  "mimeType": "JPEG",
  "width": 300,
  "height": 300,
  "transparent": false,
  "convertedFilesize": 22652
}
*/

class UploadFromUrl extends BaseRequest {
  constructor(body, lambdaCallback) {
    super();
    this.sourceUrl = body.sourceUrl;
    this.assetId = body.assetId;
    this.imageQuality = body.imageQuality;
    this.lambdaCallback = lambdaCallback;
  }
  isValid() {
    return exists(this.sourceUrl) && exists(this.assetId);
  }
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

class UploadFromBucket extends BaseRequest {
  constructor(body, lambdaCallback) {
    super();
    this.sourceBucketKey = body.sourceBucketKey;
    this.assetId = body.assetId;
    this.imageQuality = body.imageQuality;
    this.lambdaCallback = lambdaCallback;
  }
  isValid() {
    return exists(this.sourceBucketKey) && exists(this.assetId);
  }
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

    if (downloaded == false) {
      // Failed to download, exit
      return;
    }

    console.log("Uploading to destination S3");
    await this.uploadImage(saveFile, uniqueNumber);
    analyticsSegment.close();
  }
}

class Crop extends BaseRequest {
  constructor(body, lambdaCallback) {
    super();
    this.sourceBucketKey = body.sourceBucketKey;
    this.assetId = body.newAssetId;
    this.crop = body.crop;
    this.lambdaCallback = lambdaCallback;
  }

  x() {
    return parseInt(this.crop.x) || 0;
  }
  y() {
    return parseInt(this.crop.y) || 0;
  }
  width() {
    return parseInt(this.crop.width);
  }
  height() {
    return parseInt(this.crop.height);
  }

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

    if (downloaded == false) {
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
  async imCrop(sourceFile, modifiedFile, meta) {
    const analyticsSegment = this.createAnalyticsSegment("performCrop");

    let needsToBeResized = meta["needsToBeResized"];

    let defineSize = "";
    let resize = "";
    if (needsToBeResized) {
      defineSize =
        "-define jpeg:size=" +
        defaultMaxResolution +
        "x" +
        defaultMaxResolution;
      resize = "-scale " + defaultMaxResolution + "x" + defaultMaxResolution;
    }

    try {
      await execPromise(
        "/opt/bin/magick convert " +
          defineSize +
          " " +
          sourceFile +
          " " +
          resize +
          " -strip -crop " +
          this.width() +
          "x" +
          this.height() +
          "+" +
          this.x() +
          "+" +
          this.y() +
          " " +
          modifiedFile,
      );
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

class Resize extends BaseRequest {
  constructor(body, lambdaCallback) {
    super();
    this.sourceBucketKey = body.sourceBucketKey;
    this.assetId = body.newAssetId;
    this.resize = body.resize;
    this.lambdaCallback = lambdaCallback;
  }

  width() {
    return parseInt(this.resize.width);
  }
  height() {
    return parseInt(this.resize.height);
  }

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
    if (downloaded == false) {
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

  async imResize(sourceFile, modifiedFile, meta) {
    const analyticsSegment = this.createAnalyticsSegment("performResize");

    let needsToBeResized = meta["needsToBeResized"];

    let defineSize = "";
    if (needsToBeResized) {
      defineSize =
        "-define jpeg:size=" +
        defaultMaxResolution +
        "x" +
        defaultMaxResolution;
    }

    try {
      await execPromise(
        "/opt/bin/magick convert " +
          defineSize +
          " " +
          sourceFile +
          " -strip -scale " +
          this.width() +
          "x" +
          this.height() +
          " " +
          modifiedFile,
      );
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

class Rotate extends BaseRequest {
  constructor(body, lambdaCallback) {
    super();
    this.sourceBucketKey = body.sourceBucketKey;
    this.assetId = body.newAssetId;
    this.rotate = body.rotate;
    this.lambdaCallback = lambdaCallback;
  }

  angle() {
    return parseInt(this.rotate) || 0;
  }

  isValid() {
    return (
      exists(this.assetId) &&
      exists(this.sourceBucketKey) &&
      existsOrZero(this.rotate) &&
      !isNaN(parseInt(this.rotate))
    ); // Verify rotate is a number
  }
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

    if (downloaded == false) {
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

  async imRotate(sourceFile, modifiedFile, meta) {
    const analyticsSegment = this.createAnalyticsSegment("performRotate");

    let needsToBeResized = meta["needsToBeResized"];

    let defineSize = "";
    let resize = "";
    if (needsToBeResized) {
      defineSize =
        "-define jpeg:size=" +
        defaultMaxResolution +
        "x" +
        defaultMaxResolution;
      resize = "-scale " + defaultMaxResolution + "x" + defaultMaxResolution;
    }

    try {
      await execPromise(
        "/opt/bin/magick convert " +
          defineSize +
          " " +
          sourceFile +
          " " +
          resize +
          " -strip -rotate " +
          this.angle() +
          " " +
          modifiedFile,
      );
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
class CreateTiles extends BaseRequest {
  constructor(body, lambdaCallback) {
    super();
    this.sourceBucketKey = body.sourceBucketKey;
    this.sourceUrl = body.sourceUrl;
    this.horizontalAssetId = body.horizontalAssetId;
    this.verticalAssetId = body.verticalAssetId;
    this.assetId = body.horizontalAssetId;
    this.lambdaCallback = lambdaCallback;
  }

  // These values are hardcoded in the webapp and were requested to be hardcoded in this API.
  horizontalTile() {
    return { width: 460, height: 260, imageQuality: 90 };
  }
  verticalTile() {
    return { width: 210, height: 221, imageQuality: 90 };
  }

  isValid() {
    return (
      (exists(this.sourceBucketKey) || exists(this.sourceUrl)) &&
      exists(this.horizontalAssetId) &&
      exists(this.verticalAssetId)
    );
  }
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

    if (downloaded == false) {
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

  async imMakeTile(tileProperties, sourceFile, modifiedFile) {
    let meta = await this.imGetMeta(sourceFile);
    if (meta == false) {
      // MetaData is invalid, exit
      return;
    }

    const analyticsSegment = this.createAnalyticsSegment("performMakeTile");

    const width = tileProperties.width;
    const height = tileProperties.height;
    const imageQuality = tileProperties.imageQuality;

    try {
      // Get cropped image from center
      await execPromise(
        "/opt/bin/magick convert " +
          `${sourceFile}[0] ` +
          `-resize ${width}x${height}^ ` +
          "-gravity center " +
          `-extent ${width}x${height} ` +
          "-auto-orient -strip -limit map 64MiB -limit memory 3500MiB " +
          `-quality ${imageQuality} ` +
          modifiedFile,
      );
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

exports.handler = function (event, context, callback) {
  let startTime = Date.now();

  function errorResponse(reason, detail) {
    let error = {
      reason: reason,
      detail: detail,
    };

    let response = {
      statusCode: 400,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(error),
    };

    const analyticsSegment = AWSXRay.getSegment().addNewSubsegment("Error");
    const errorString = `${String(error.reason)} ${String(error.detail)}`;
    analyticsSegment.addAnnotation("Error", errorString);
    analyticsSegment.addError(errorString);
    analyticsSegment.addErrorFlag();
    analyticsSegment.close();

    return response;
  }

  function checkOverLimit() {
    if (Date.now() - startTime > 25000) {
      clearInterval(currentRuntimeCounter);

      const errorDescription =
        "Terminating Lambda after 25 seconds to prevent an api gateway timeout.";
      const response = errorResponse("TIMEOUT", errorDescription);

      callback(null, response);
      currentlyRunningProcess.kill();
      console.log(errorDescription);
    }
  }

  currentRuntimeCounter = setInterval(checkOverLimit, 1000);

  function missingParameters() {
    const response = errorResponse("Missing parameters", "");

    clearInterval(currentRuntimeCounter);
    callback(null, response);
  }

  let body = "";
  try {
    body = JSON.parse(event.body);
  } catch {
    missingParameters();
    return;
  }

  let hasAnAssetId = body.assetId || body.newAssetId;
  let isTile = body.horizontalAssetId && body.verticalAssetId;
  if (!hasAnAssetId && !isTile) {
    missingParameters();
  }

  // Create an object for every API we support.
  let uploadFromUrl = new UploadFromUrl(body, callback);
  let uploadFromBucket = new UploadFromBucket(body, callback);
  let createTiles = new CreateTiles(body, callback);
  let crop = new Crop(body, callback);
  let resize = new Resize(body, callback);
  let rotate = new Rotate(body, callback);

  // Check each object to see if we have the correct parameters,
  // the first API that contains all the correct parameters will run.
  // The order here is important, APIs that share parameters will need
  // to be checked in the correct order.

  // TODO: As we support more APIs, we will need to refactor this into
  // multiple lambdas or endpoints.

  // Make a X-Ray group for each API endpoint.
  //https://console.aws.amazon.com/xray/home?region=us-east-1#/groups

  if (uploadFromUrl.isValid()) {
    uploadFromUrl.start();
  } else if (uploadFromBucket.isValid()) {
    uploadFromBucket.start();
  } else if (createTiles.isValid()) {
    createTiles.start();
  } else if (crop.isValid()) {
    crop.start();
  } else if (resize.isValid()) {
    resize.start();
  } else if (rotate.isValid()) {
    rotate.start();
  } else {
    missingParameters();
  }
};

// Helpers

// True if string is null, empty, or undefined
function exists(str) {
  return !!str;
}

function existsOrZero(str) {
  return str || parseInt(str) === 0;
}

function contains(source, stringToFind) {
  return String(source).indexOf(stringToFind) > -1;
}

function execPromise(command, logResult) {
  return new Promise(function (resolve, reject) {
    currentlyRunningProcess = exec(
      command,
      { timeout: 30000 },
      (error, stdout, stderr) => {
        if (error) {
          if (error.killed === true) {
            console.log("ExecPromise either timed out, or was killed.");
          }
          reject(error);
          return;
        }

        if (logResult === true) {
          console.log(stdout);
        }

        resolve(stdout.trim());
      },
    );
  });
}
