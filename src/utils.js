/**
 * @fileoverview Utility functions for image processing operations
 * @author Bulb Inc.
 * @copyright 2021, Bulb Inc.
 */

"use strict";

const { exec } = require("child_process");

/**
 * Global variable to track the currently running process
 * Used to terminate the process if it runs too long
 * @type {Object}
 */
var currentlyRunningProcess;

/**
 * Checks if a string is not null, empty, or undefined
 * @param {*} str - The string to check
 * @returns {boolean} True if the string exists
 */
function exists(str) {
  return !!str;
}

/**
 * Checks if a string exists or is zero
 * @param {*} str - The string to check
 * @returns {boolean} True if the string exists or is zero
 */
function existsOrZero(str) {
  return str || parseInt(str) === 0;
}

/**
 * Checks if a source string contains a substring
 * @param {string} source - The source string
 * @param {string} stringToFind - The substring to find
 * @returns {boolean} True if the source contains the substring
 */
function contains(source, stringToFind) {
  return String(source).indexOf(stringToFind) > -1;
}

/**
 * Executes a command as a Promise
 * @param {string} command - The command to execute
 * @param {boolean} [logResult=false] - Whether to log the result
 * @returns {Promise<string>} A promise that resolves with the command output
 */
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

module.exports = {
  exists,
  existsOrZero,
  contains,
  execPromise,
  currentlyRunningProcess
};
