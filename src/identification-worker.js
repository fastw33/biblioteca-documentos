'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { identifyBytes } = require('./identification');
identifyBytes(Buffer.from(workerData.bytes), workerData.identity, workerData.extension, workerData.maxBytes)
  .then(result => parentPort.postMessage(result))
  .catch(() => parentPort.postMessage(null));
