'use strict';
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const root = path.resolve(__dirname, '..');
const index = process.argv.indexOf('--source');
const sourcePath = index >= 0 ? process.argv[index + 1] : path.resolve(root, '../Sistemas Genika/GestorDocumental/.env.production');
if (!sourcePath) throw new Error('Indica el .env de producción de origen.');
const target = path.join(root, '.env.production');
if (fs.existsSync(target)) throw new Error('Ya existe .env.production. Se conserva sin cambios.');
const source = dotenv.parse(fs.readFileSync(sourcePath));
if (!source.MONGO_URI || !source.JWT_SECRET || !source.S3_ENDPOINT || !source.AWS_ACCESS_KEY_ID || !source.AWS_SECRET_ACCESS_KEY)
  throw new Error('Faltan credenciales Mongo, JWT de WMS o S3 en la configuración de producción.');
const mongo = new URL(source.MONGO_URI);
// Conservar la base de autenticación implícita antes de apuntar la URI a la base exclusiva.
if (mongo.username && !mongo.searchParams.has('authSource')) mongo.searchParams.set('authSource', mongo.pathname.slice(1) || 'admin');
mongo.pathname = '/repositorio_documentos';
if (['localhost', '127.0.0.1', '0.0.0.0'].includes(mongo.hostname) || ['localhost', '127.0.0.1', '0.0.0.0'].includes(new URL(source.S3_ENDPOINT).hostname))
  throw new Error('La configuración de producción debe apuntar a los servicios de Mongo y S3 accesibles desde Coolify.');
const values = {
  RAILPACK_NODE_VERSION: '24', NODE_ENV: 'production', HOST: '0.0.0.0', PORT: '3016', TRUST_PROXY_HOPS: '1',
  MONGO_URI: mongo.href, MONGO_DB_NAME: 'repositorio_documentos', JWT_SECRET: source.JWT_SECRET,
  CORS_ORIGINS: 'https://portalclientes.fastwaysas.com,https://www.appfastway.com,https://qa.appfastway.com',
  AWS_REGION: source.AWS_REGION || source.S3_REGION || 'us-east-1',
  AWS_ACCESS_KEY_ID: source.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: source.AWS_SECRET_ACCESS_KEY,
  AWS_SESSION_TOKEN: source.AWS_SESSION_TOKEN || '', S3_BUCKET: 'genika-repositorio-documentos',
  S3_ENDPOINT: source.S3_ENDPOINT, S3_FORCE_PATH_STYLE: 'true', S3_PREFIX: 'documentos',
  INITIALIZE_STORAGE_ON_START: 'true', MAX_FILE_MB: '30', LIBREOFFICE_PATH: 'soffice', PDFTOPPM_PATH: 'pdftoppm', PREVIEW_TIMEOUT_MS: '60000',
};
const encode = value => {
  if (/[\r\n]/.test(value)) throw new Error('Valor con salto de línea no admitido.');
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('`')) return '`' + value + '`';
  throw new Error('Configura manualmente el valor que contiene ambos delimitadores.');
};
const content = Object.entries(values).map(([key, value]) => `${key === 'RAILPACK_NODE_VERSION' ? '# coolify: runtime=false' : '# coolify: literal buildtime=false'}\n${key}=${encode(String(value))}`).join('\n') + '\n';
fs.writeFileSync(target, content, { flag: 'wx', mode: 0o600 });
console.log('.env.production creado con las credenciales existentes y los destinos exclusivos de Biblioteca. No se muestran secretos.');
