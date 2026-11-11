'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');
const base = { NODE_ENV: 'production', MONGO_URI: 'mongodb://mongo:27017/repositorio_documentos',
  JWT_SECRET: 'test-production-config', AWS_REGION: 'us-east-1', S3_BUCKET: 'genika-repositorio-documentos' };
it('producción acepta únicamente la base y el bucket exclusivos de Biblioteca', () => {
  const config = loadConfig({ ...base, INITIALIZE_STORAGE_ON_START: 'true' });
  assert.equal(config.MONGO_DB_NAME, 'repositorio_documentos');
  assert.equal(config.INITIALIZE_STORAGE_ON_START, 'true');
  assert.throws(() => loadConfig({ ...base, MONGO_DB_NAME: 'radicados' }));
  assert.throws(() => loadConfig({ ...base, S3_BUCKET: 'leads' }));
});
it('los orígenes de producción se aplican a CORS sin permitir otros por defecto', () => {
  const origins = ['https://portalclientes.fastwaysas.com', 'https://www.appfastway.com', 'https://qa.appfastway.com'];
  assert.deepEqual(loadConfig({ ...base, CORS_ORIGINS: origins.join(',') }).corsOrigins, origins);
});
