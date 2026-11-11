'use strict';
const { z } = require('zod');

function loadConfig(env = process.env) {
  const value = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3016),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
    MONGO_URI: z.string().min(1),
    MONGO_DB_NAME: z.string().regex(/^[\w-]+$/).default('repositorio_documentos'),
    JWT_SECRET: z.string().min(1),
    CORS_ORIGINS: z.string().default('http://localhost:5173'),
    AWS_REGION: z.string().min(1),
    S3_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
    S3_ENDPOINT: z.union([z.url(), z.literal('')]).default(''),
    S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('false'),
    S3_PREFIX: z.string().regex(/^[a-zA-Z0-9_-]+$/).default('documentos'),
    MAX_FILE_MB: z.coerce.number().int().min(1).max(100).default(30),
    LIBREOFFICE_PATH: z.string().default('soffice'),
    PDFTOPPM_PATH: z.string().default('pdftoppm'),
    PREVIEW_TIMEOUT_MS: z.coerce.number().int().min(1000).max(180000).default(60000),
  }).parse(env);
  return { ...value, maxBytes: value.MAX_FILE_MB * 1024 * 1024,
    corsOrigins: value.CORS_ORIGINS.split(',').map(v => v.trim()).filter(Boolean) };
}
module.exports = { loadConfig };
