'use strict';
const mongoose = require('mongoose');

const TYPES = ['brochure', 'formato', 'oferta', 'presentacion', 'manual', 'otro'];
const COMPANIES = ['Fastway', 'Harvest', 'Green Way', 'General', 'Otra'];
function createModels(connection) {
  const actor = { id: { type: String, required: true }, nombre: { type: String, required: true } };
  const identification = new mongoose.Schema({
    codigo: String, origen: String, aplicacion: String, documentoId: String, version: Number,
    empresa: String, nombre: String, categoria: String, subidoPor: actor, fecha: Date,
    sha256Original: String, sha256: String, bytes: Number, storageKey: String,
    modo: { type: String, enum: ['interna', 'registro', 'enlace'] }, motivo: String,
  }, { _id: false });
  const version = new mongoose.Schema({
    numero: { type: Number, required: true }, fecha: { type: Date, required: true },
    subidoPor: actor, notaCambio: { type: String, default: '' },
    nombre: String, empresa: String, tipo: String, descripcion: String, canvaUrl: String,
    archivoDisponible: Boolean, nombreOriginal: String, extension: String, mime: String,
    bytes: Number, sha256: String, storageKey: String, identificacion: identification,
  }, { _id: false });
  const schema = new mongoose.Schema({
    nombre: { type: String, required: true, maxlength: 160 },
    empresa: { type: String, required: true, maxlength: 120, index: true },
    tipo: { type: String, required: true, enum: TYPES, index: true },
    descripcion: { type: String, default: '', maxlength: 1500 },
    canvaUrl: { type: String, default: '', maxlength: 2048 },
    archivoDisponible: { type: Boolean, required: true, default: false },
    nombreOriginal: { type: String },
    extension: { type: String, required: true, index: true },
    mime: { type: String, required: true },
    bytes: { type: Number, required: true },
    sha256: { type: String },
    storageKey: { type: String, unique: true, sparse: true, select: false },
    creadoPor: { id: { type: String, required: true }, nombre: { type: String, required: true } },
    actualizadoPor: { type: String },
    ultimaVersionPor: actor,
    versionActual: { type: Number, default: 1 },
    versiones: { type: [version], default: [], select: false },
    identificacion: identification,
  }, { timestamps: true, versionKey: false, bufferCommands: false });
  schema.index({ createdAt: -1, _id: -1 });
  schema.index({ sha256: 1 });
  schema.index({ 'identificacion.sha256': 1 });
  schema.index({ 'versiones.sha256': 1 });
  schema.index({ 'versiones.identificacion.sha256': 1 });
  const auditSchema = new mongoose.Schema({
    documentoId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    version: { type: Number, required: true },
    accion: { type: String, enum: ['descarga', 'canva'], required: true },
    variante: { type: String, enum: ['genika', 'original', 'identificacion'] },
    usuario: actor,
    fecha: { type: Date, default: Date.now, index: true },
    resultado: { type: String, enum: ['iniciada', 'completada', 'interrumpida'], default: 'iniciada' },
    nombreArchivo: String, bytes: Number, ip: String, userAgent: String, requestId: String,
  }, { versionKey: false, bufferCommands: false });
  auditSchema.index({ documentoId: 1, fecha: -1, _id: -1 });
  return { Document: connection.model('Document', schema, 'documentos'),
    Audit: connection.model('DocumentAudit', auditSchema, 'documentos_auditoria') };
}
async function connectDatabase(config) {
  const connection = mongoose.createConnection(config.MONGO_URI, {
    dbName: config.MONGO_DB_NAME, serverSelectionTimeoutMS: 8000, autoIndex: false,
  });
  try {
    await connection.asPromise();
    const models = createModels(connection);
    await Promise.all(Object.values(models).map(model => model.createIndexes()));
    return { connection, ...models };
  } catch (error) { await connection.close().catch(() => {}); throw error; }
}
module.exports = { TYPES, COMPANIES, createModels, connectDatabase };
