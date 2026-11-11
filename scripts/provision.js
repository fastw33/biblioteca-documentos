'use strict';
require('dotenv').config({ quiet: true });
const { loadConfig } = require('../src/config');
const { connectDatabase } = require('../src/database');
const { S3Storage } = require('../src/storage');
async function main() {
  const config = loadConfig();
  const database = await connectDatabase(config);
  const storage = new S3Storage(config);
  try {
    console.log(`Mongo conectado. Base independiente: ${config.MONGO_DB_NAME}. Índices creados.`);
    const result = await storage.provision();
    console.log(`Bucket ${config.S3_BUCKET}: ${result.created ? 'creado, privado por defecto' : 'accesible, ya existía'}.`);
  } finally { await database.connection.close(); storage.client.destroy(); }
}
main().catch(error => {
  console.error('No se pudo completar la preparación:', error.code || error.name || 'Error');
  process.exitCode = 1;
});
