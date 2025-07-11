/**
 * @fileoverview Lambda handler for image processing operations
 * @author Bulb Inc.
 * @copyright 2021, Bulb Inc.
 */

"use strict";

// Third Party Dependencies
const AWSXRay = require("aws-xray-sdk-core");

// Local Dependencies
const { UploadFromUrl, UploadFromBucket } = require("./upload");
const CreateTiles = require("./tiles");
const { Crop, Resize, Rotate } = require("./imageManipulation");

// Global variables
let currentRuntimeCounter; // Clear this interval when a response is sent.
console.log("Lambda deployed successfully and starting...");
/**
 * Lambda handler function
 * @param {Object} event - The Lambda event
 * @param {Object} context - The Lambda context
 * @param {Function} callback - The Lambda callback
 */
exports.handler = function (event, context, callback) {
  let startTime = Date.now();

  /**
   * Creates an error response
   * @param {string} reason - The error reason
   * @param {string} detail - The error details
   * @returns {Object} The error response
   */
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

  /**
   * Checks if the Lambda has been running too long
   */
  function checkOverLimit() {
    if (Date.now() - startTime > 25000) {
      clearInterval(currentRuntimeCounter);

      const errorDescription =
        "Terminating Lambda after 25 seconds to prevent an api gateway timeout.";
      const response = errorResponse("TIMEOUT", errorDescription);

      callback(null, response);
      if (global.currentlyRunningProcess) {
        global.currentlyRunningProcess.kill();
      }
      console.log(errorDescription);
    }
  }

  currentRuntimeCounter = setInterval(checkOverLimit, 1000);
  global.currentRuntimeCounter = currentRuntimeCounter;

  /**
   * Handles missing parameters
   */
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
