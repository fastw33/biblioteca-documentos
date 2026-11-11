'use strict';
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const root = path.resolve(__dirname, '..');
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  if (index >= 0 && !process.argv[index + 1]) throw new Error(`Falta valor para ${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
};
const genika = path.resolve(root, '../Sistemas Genika');
const sourcePath = path.resolve(option('--source', path.join(genika, 'Sistema de Leads/backend/.env')));
const identityPath = path.resolve(option('--identity', path.join(genika, 'wmsBack/.env')));
const target = path.join(root, '.env');
if (fs.existsSync(target)) throw new Error('Ya existe .env. Se conserva sin cambios.');
const source = dotenv.parse(fs.readFileSync(sourcePath));
const identity = dotenv.parse(fs.readFileSync(identityPath));
const values = {
  NODE_ENV: 'development', HOST: '127.0.0.1', PORT: '3016', TRUST_PROXY_HOPS: '0',
  MONGO_URI: source.MONGO_URI || source.MONGODB_URI || '', MONGO_DB_NAME: 'repositorio_documentos',
  JWT_SECRET: identity.JWT_SECRET || '', CORS_ORIGINS: 'http://localhost:5173,http://127.0.0.1:5173',
  AWS_REGION: source.AWS_REGION || source.S3_REGION || 'us-east-1',
  AWS_ACCESS_KEY_ID: source.AWS_ACCESS_KEY_ID || '', AWS_SECRET_ACCESS_KEY: source.AWS_SECRET_ACCESS_KEY || '',
  AWS_SESSION_TOKEN: source.AWS_SESSION_TOKEN || '',
  S3_BUCKET: option('--bucket', 'genika-repositorio-documentos'), S3_ENDPOINT: source.S3_ENDPOINT || '',
  S3_FORCE_PATH_STYLE: source.S3_FORCE_PATH_STYLE || 'false', S3_PREFIX: 'documentos', MAX_FILE_MB: '30',
};
if (!values.MONGO_URI || !values.JWT_SECRET) throw new Error('Falta la conexión Mongo o JWT_SECRET de WMS.');
if ([source.S3_BUCKET, source.AWS_S3_BUCKET].includes(values.S3_BUCKET)) throw new Error('El bucket debe ser nuevo e independiente.');
// dotenv preserva los caracteres de URI y contraseñas. Rechazar saltos evita inyección de variables.
const encode = value => {
  if (/[\r\n]/.test(value)) throw new Error('Configuración con saltos de línea no admitida.');
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('`')) return '`' + value + '`';
  throw new Error('Configura manualmente el valor que contiene ambos delimitadores.');
};
fs.writeFileSync(target, Object.entries(values).map(([key, value]) => `${key}=${encode(String(value))}`).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
console.log('.env creado con la conexión existente, base nueva y JWT de WMS. No se muestran secretos.');
