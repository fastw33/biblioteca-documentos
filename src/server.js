'use strict';
const { loadConfig } = require('./config');
const { connectDatabase } = require('./database');
const { S3Storage } = require('./storage');
const { createApp } = require('./app');

async function main() {
  const config = loadConfig();
  const database = await connectDatabase(config);
  const storage = new S3Storage(config);
  const server = createApp({ config, ...database, storage }).listen(config.PORT, config.HOST, () => {
    console.log(`API de documentos: http://${config.HOST}:${config.PORT}/api/documentos`);
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 15000;
  const shutdown = () => {
    const timer = setTimeout(() => process.exit(1), 15000).unref();
    server.close(async () => {
      await database.connection.close();
      storage.client.destroy();
      clearTimeout(timer);
      process.exit(0);
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
main().catch(error => {
  // No imprimir URI, credenciales ni valores de configuración.
  console.error('No se pudo iniciar la API:', error.name || 'Error');
  if (error.issues) console.error('Revisar variables:', error.issues.map(i => i.path.join('.')).join(', '));
  process.exitCode = 1;
});
