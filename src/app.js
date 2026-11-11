'use strict';
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const mongoose = require('mongoose');
const disposition = require('content-disposition');
const { pipeline } = require('node:stream/promises');
const { randomUUID } = require('node:crypto');
const { ZodError } = require('zod');
const { authenticate, canEdit, actor } = require('./auth');
const { TYPES, COMPANIES } = require('./database');
const { metadata, patchMetadata, newVersion, listing, fileInfo, MIMES } = require('./validation');
const { snapshot, history, versionOf, appendVersion } = require('./versions');
const { PreviewService, previewKind, readBody } = require('./previews');
const { persistIdentifiedFile, createIdentity, publicIdentity, digest } = require('./identification');

const fail = (status, message) => Object.assign(new Error(message), { status });
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const publicDocument = (document, user) => {
  const value = document.toObject ? document.toObject() : { ...document };
  delete value.storageKey;
  delete value.versiones;
  if (value.identificacion) value.identificacion = publicIdentity(value.identificacion);
  return { ...value, versionActual: value.versionActual || 1, fechaCambio: value.updatedAt,
    subidoPor: value.ultimaVersionPor || value.creadoPor, vistaPrevia: previewKind(value), puedeEditar: canEdit(user, value) };
};
const publicVersion = version => {
  const value = { ...version };
  delete value.storageKey;
  if (value.identificacion) value.identificacion = publicIdentity(value.identificacion);
  return { ...value, vistaPrevia: previewKind(value) };
};

function createApp({ config, Document, Audit, storage, connection, logger = console, previews = new PreviewService(config, storage) }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY_HOPS);
  app.use(helmet());
  app.use(cors({ origin(origin, cb) {
    cb(origin && !config.corsOrigins.includes(origin) ? fail(403, 'Origen no permitido.') : null, true);
  }, exposedHeaders: ['Content-Disposition', 'X-Request-Id', 'X-Genika-Identificacion', 'X-Genika-Metadata'] }));
  app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.set('X-Request-Id', req.requestId);
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  const router = express.Router();
  router.use(authenticate(config));
  router.use(rateLimit({ windowMs: 60000, limit: 180, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { message: 'Demasiadas solicitudes. Espera un minuto.' } }));
  router.use((req, res, next) => {
    if (connection.readyState !== 1) return next(fail(503, 'La base de datos no está disponible.'));
    next();
  });
  router.get('/ready', async (req, res) => {
    await connection.db.admin().ping();
    await storage.ready();
    res.json({ status: 'ok' });
  });
  router.get('/catalogos', async (req, res) => {
    const [empresas, extensiones] = await Promise.all([Document.distinct('empresa'), Document.distinct('extension')]);
    res.json({ tipos: TYPES, empresas: COMPANIES, empresasRegistradas: empresas.sort((a, b) => a.localeCompare(b, 'es')),
      extensiones: extensiones.sort(), extensionesPermitidas: Object.keys(MIMES), maxFileMB: config.MAX_FILE_MB });
  });
  router.get('/resumen', async (req, res) => {
    const [result] = await Document.aggregate([{ $facet: {
      total: [{ $group: { _id: null, documentos: { $sum: 1 }, bytes: { $sum: '$bytes' } } }],
      empresas: [{ $group: { _id: '$empresa' } }, { $count: 'total' }],
      tipos: [{ $group: { _id: '$tipo', cantidad: { $sum: 1 } } }, { $sort: { _id: 1 } }],
    } }]);
    res.json({ documentos: result.total[0]?.documentos || 0, bytes: result.total[0]?.bytes || 0,
      empresas: result.empresas[0]?.total || 0, tipos: result.tipos.map(t => ({ tipo: t._id, cantidad: t.cantidad })) });
  });
  router.get('/', async (req, res) => {
    const query = listing.parse(req.query);
    const filter = {};
    for (const key of ['empresa', 'tipo', 'extension']) if (query[key]) filter[key] = query[key];
    // La collation usada para ordenar no cambia la coincidencia exacta del filtro de empresa.
    if (query.empresa) filter.empresa = new RegExp(`^${escapeRegex(query.empresa)}$`);
    if (query.q) {
      const regex = new RegExp(escapeRegex(query.q), 'i');
      filter.$or = ['nombre', 'empresa', 'descripcion', 'nombreOriginal'].map(key => ({ [key]: regex }));
    }
    const sort = query.orden === 'empresa' ? { empresa: 1, nombre: 1, _id: 1 } :
      query.orden === 'nombre' ? { nombre: 1, _id: 1 } : { updatedAt: -1, _id: -1 };
    const itemsQuery = Document.find(filter).sort(sort).skip((query.page - 1) * query.limit).limit(query.limit).lean();
    const totalQuery = Document.countDocuments(filter);
    if (query.orden === 'empresa') {
      const collation = { locale: 'es', strength: 2, numericOrdering: true };
      itemsQuery.collation(collation); totalQuery.collation(collation);
    }
    const [items, total] = await Promise.all([
      itemsQuery, totalQuery,
    ]);
    res.json({ items: items.map(item => publicDocument(item, req.user)), total,
      page: query.page, limit: query.limit, pages: Math.ceil(total / query.limit) });
  });
  let activeUploads = 0;
  const capacity = (req, res, next) => {
    if (activeUploads >= 3) return next(fail(503, 'Hay varias cargas en curso. Intenta de nuevo en unos segundos.'));
    activeUploads++;
    let released = false;
    const release = () => { if (!released) { released = true; activeUploads--; } };
    // El slot se libera al terminar realmente la operación, incluso si el cliente se desconecta.
    res.locals.releaseUpload = release;
    next();
  };
  const upload = multer({ storage: multer.memoryStorage(), limits: {
    fileSize: config.maxBytes, files: 1, fields: 7, fieldSize: 8192, parts: 8,
  } }).single('archivo');
  const uploadLimit = rateLimit({ windowMs: 60000, limit: 15, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { message: 'Has realizado muchas cargas. Espera un minuto.' } });
  const multipart = (req, res, next) => upload(req, res, error => {
    if (error) { res.locals.releaseUpload(); return next(error); }
    next();
  });
  const cleanup = async (keys, req) => {
    for (const key of keys) try { await storage.remove(key); }
    catch { logger.error({ requestId: req.requestId, code: 'S3_CLEANUP_FAILED', storageKey: key }); }
  };
  router.post('/verificar', uploadLimit, capacity, multipart, async (req, res) => {
    try {
      if (!req.file?.size) throw fail(400, 'Selecciona el archivo que deseas verificar.');
      const hash = digest(req.file.buffer);
      const documents = await Document.find({ $or: [{ sha256: hash }, { 'identificacion.sha256': hash },
        { 'versiones.sha256': hash }, { 'versiones.identificacion.sha256': hash }] }).select('+versiones').limit(25);
      const coincidencias = [];
      for (const document of documents) for (const version of history(document)) {
        const genika = version.identificacion?.modo === 'interna' && version.identificacion.sha256 === hash;
        if (!genika && version.sha256 !== hash) continue;
        coincidencias.push({ documentoId: String(document._id), nombre: version.nombre, empresa: version.empresa,
          version: version.numero, esVersionActual: version.numero === document.versionActual,
          variante: genika ? 'genika' : 'original', identificacion: publicIdentity(version.identificacion) || null });
      }
      res.json({ registrado: coincidencias.length > 0, sha256: hash, coincidencias, limiteDocumentos: 25 });
    } finally { res.locals.releaseUpload(); }
  });
  router.post('/', uploadLimit, express.json({ limit: '16kb' }), capacity, multipart, async (req, res) => {
    let createdKeys = [];
    try {
      const { notaCambio, ...input } = metadata.parse(req.body);
      const _id = new mongoose.Types.ObjectId();
      if (!req.file) {
        if (!input.canvaUrl) throw fail(400, 'Envía un archivo o un enlace de Canva.');
        const identity = { ...createIdentity({ _id, ...input }, req.user, 1, ''), modo: 'enlace', motivo: 'referencia_canva' };
        const data = { _id, ...input, archivoDisponible: false, identificacion: identity, versionActual: 1, ultimaVersionPor: actor(req.user),
          extension: 'canva', mime: 'text/uri-list', bytes: 0, creadoPor: actor(req.user) };
        const document = await Document.create({ ...data, versiones: [snapshot(data, req.user, 1, notaCambio || 'Versión inicial')] });
        return res.status(201).json(publicDocument(document, req.user));
      }
      const info = fileInfo(req.file);
      const storageKey = `${config.S3_PREFIX}/${_id}/${randomUUID()}.${info.extension}`;
      const prepared = await persistIdentifiedFile({ config, storage, bytes: req.file.buffer,
        document: { _id, ...input }, info, user: req.user, numero: 1, storageKey });
      createdKeys = prepared.keys;
        const data = { _id, ...input, ...prepared.file, creadoPor: actor(req.user),
          versionActual: 1, ultimaVersionPor: actor(req.user) };
      const document = await Document.create({ ...data, versiones: [snapshot(data, req.user, 1, notaCambio || 'Versión inicial')] });
      createdKeys = [];
      res.status(201).json(publicDocument(document, req.user));
    } catch (error) { await cleanup(createdKeys, req); throw error; }
    finally { res.locals.releaseUpload(); }
  });
  router.param('id', (req, res, next, id) => {
    if (!/^[a-f\d]{24}$/i.test(id)) return next(fail(400, 'Identificador de documento inválido.'));
    next();
  });
  const findDocument = async id => {
    const document = await Document.findById(id).select('+storageKey +versiones');
    if (!document) throw fail(404, 'El documento no existe.');
    return document;
  };
  router.get('/:id', async (req, res) => {
    res.json(publicDocument(await findDocument(req.params.id), req.user));
  });
  router.get('/:id/versiones', async (req, res) => {
    const document = await findDocument(req.params.id);
    res.json({ versionActual: document.versionActual, items: history(document).sort((a, b) => b.numero - a.numero).map(publicVersion) });
  });
  router.post('/:id/versiones', uploadLimit, express.json({ limit: '16kb' }), capacity, multipart, async (req, res) => {
    let createdKeys = [];
    try {
      const input = newVersion.parse(req.body);
      const document = await findDocument(req.params.id);
      if (!canEdit(req.user, document)) throw fail(403, 'Solo el autor o un administrador puede cargar versiones.');
      if (input.baseVersion !== document.versionActual) throw fail(409, 'Hay una versión más reciente. Actualiza antes de cargar.');
      if (!req.file && !input.canvaUrl) throw fail(400, 'Carga un archivo o un enlace de Canva para la nueva versión.');
      if (!req.file && document.canvaUrl && input.canvaUrl &&
          new URL(document.canvaUrl).pathname.split('/')[2] === new URL(input.canvaUrl).pathname.split('/')[2])
        throw fail(409, 'Para conservar el diseño anterior, duplica el diseño en Canva y usa su nuevo enlace, o carga una exportación como archivo.');
      let file;
      if (req.file) {
        const info = fileInfo(req.file);
        const storageKey = `${config.S3_PREFIX}/${document._id}/${randomUUID()}.${info.extension}`;
        const prepared = await persistIdentifiedFile({ config, storage, bytes: req.file.buffer,
          document: { ...document.toObject(), ...input }, info, user: req.user, numero: document.versionActual + 1, storageKey });
        createdKeys = prepared.keys; file = prepared.file;
      } else file = { archivoDisponible: false, extension: 'canva', mime: 'text/uri-list', bytes: 0,
        storageKey: undefined, sha256: undefined, nombreOriginal: undefined,
        identificacion: { ...createIdentity({ ...document.toObject(), ...input }, req.user, document.versionActual + 1, ''), modo: 'enlace', motivo: 'referencia_canva' } };
      const updated = await appendVersion(Document, document, input, file, req.user, input.baseVersion);
      createdKeys = []; // Un archivo publicado nunca se elimina al crear otra versión.
      res.status(201).json(publicDocument(updated, req.user));
    } catch (error) {
      await cleanup(createdKeys, req);
      throw error;
    } finally { res.locals.releaseUpload(); }
  });
  router.get('/:id/auditoria', async (req, res) => {
    await findDocument(req.params.id);
    const query = listing.pick({ page: true, limit: true }).parse(req.query);
    const filter = { documentoId: req.params.id };
    const [items, total] = await Promise.all([Audit.find(filter).sort({ fecha: -1, _id: -1 })
      .skip((query.page - 1) * query.limit).limit(query.limit).lean(), Audit.countDocuments(filter)]);
    res.json({ items, total, page: query.page, pages: Math.ceil(total / query.limit) });
  });
  router.get('/:id/identificacion', async (req, res) => {
    const version = versionOf(await findDocument(req.params.id), req.query.version);
    res.json({ documentoId: req.params.id, version: version.numero, identificacion: publicIdentity(version.identificacion) || null });
  });
  router.get('/:id/miniatura', async (req, res) => {
    const version = versionOf(await findDocument(req.params.id), req.query.version);
    res.type('image/jpeg').send(await previews.thumbnail(version));
  });
  router.get('/:id/vista-previa', async (req, res) => {
    const version = versionOf(await findDocument(req.params.id), req.query.version);
    const preview = await previews.content(version);
    res.set('Content-Type', preview.mime);
    res.set('Content-Disposition', 'inline');
    res.send(preview.bytes);
  });
  router.post('/:id/canva', express.json({ limit: '2kb' }), async (req, res) => {
    const version = versionOf(await findDocument(req.params.id), req.body?.version);
    if (!version.canvaUrl) throw fail(404, 'Esta versión no tiene enlace de Canva.');
    await Audit.create({ documentoId: req.params.id, version: version.numero, accion: 'canva',
      usuario: actor(req.user), resultado: 'completada', ip: req.ip, requestId: req.requestId,
      userAgent: String(req.get('user-agent') || '').slice(0, 500) });
    res.json({ url: version.canvaUrl });
  });
  router.get('/:id/descarga', async (req, res) => {
    const document = await findDocument(req.params.id);
    const version = versionOf(document, req.query.version);
    if (!version.archivoDisponible) throw fail(409, 'Este registro contiene solo un diseño de Canva. Ábrelo en Canva para editarlo o exportarlo.');
    if (req.query.original !== undefined && !['true', 'false'].includes(req.query.original)) throw fail(400, 'original debe ser true o false.');
    const original = req.query.original === 'true';
    if (original && !canEdit(req.user, document)) throw fail(403, 'Solo el autor o un administrador puede descargar el original de conservación.');
    const identified = !original && version.identificacion?.modo === 'interna' && version.identificacion.storageKey;
    const bytes = identified ? version.identificacion.bytes : version.bytes;
    const audit = await Audit.create({ documentoId: document._id, version: version.numero,
      accion: 'descarga', usuario: actor(req.user), resultado: 'iniciada', nombreArchivo: version.nombreOriginal,
      variante: identified ? 'genika' : 'original', bytes, ip: req.ip, userAgent: String(req.get('user-agent') || '').slice(0, 500), requestId: req.requestId });
    let object;
    try {
    object = await storage.get(identified || version.storageKey);
    if (!object.Body) throw fail(503, 'No se pudo recuperar el archivo.');
    res.set({ 'Content-Type': version.mime,
      'Content-Disposition': disposition(version.nombreOriginal, { type: 'attachment' }),
      'Content-Length': String(bytes), 'X-Content-Type-Options': 'nosniff' });
    if (version.identificacion) res.set({ 'X-Genika-Identificacion': version.identificacion.codigo,
      'X-Genika-Metadata': identified ? 'interna' : 'registro' });
    // La descarga pasa por la API autenticada; nunca expone una URL pública o un token en la URL.
    await pipeline(object.Body, res);
    await Audit.updateOne({ _id: audit._id }, { $set: { resultado: 'completada' } });
    } catch (error) {
      object?.Body?.destroy?.();
      await Audit.updateOne({ _id: audit._id }, { $set: { resultado: 'interrumpida' } }).catch(() => {});
      throw error;
    }
  });
  router.patch('/:id', express.json({ limit: '16kb' }), async (req, res) => {
    const document = await findDocument(req.params.id);
    if (!canEdit(req.user, document)) throw fail(403, 'Solo el autor o un administrador puede editar el documento.');
    const input = patchMetadata.parse(req.body);
    if (!Object.keys(input).length) throw fail(400, 'Envía al menos un campo para actualizar.');
    if (!document.archivoDisponible && !(input.canvaUrl ?? document.canvaUrl))
      throw fail(400, 'Un registro sin archivo debe conservar su enlace de Canva.');
    let keys = [];
    try {
      let file;
      if (document.archivoDisponible) {
        const bytes = await readBody(await storage.get(document.storageKey), config.maxBytes);
        const prepared = await persistIdentifiedFile({ config, storage, bytes, document: { ...document.toObject(), ...input },
          info: { nombreOriginal: document.nombreOriginal, extension: document.extension, mime: document.mime },
          user: req.user, numero: document.versionActual + 1, storageKey: document.storageKey, originalExists: true });
        keys = prepared.keys; file = prepared.file;
      } else file = { identificacion: { ...createIdentity({ ...document.toObject(), ...input }, req.user, document.versionActual + 1, ''), modo: 'enlace', motivo: 'referencia_canva' } };
      const updated = await appendVersion(Document, document, input, file, req.user, input.baseVersion);
      keys = [];
      res.json(publicDocument(updated, req.user));
    } catch (error) { await cleanup(keys, req); throw error; }
  });
  app.use('/api/documentos', router);
  app.use((req, res) => res.status(404).json({ message: 'Ruta no encontrada.' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) { res.destroy(); return; }
    if (error instanceof ZodError) return res.status(400).json({ message: 'Revisa los campos enviados.',
      errors: error.issues.map(issue => ({ campo: issue.path.join('.'), message: issue.message })) });
    if (error instanceof multer.MulterError) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400)
      .json({ message: error.code === 'LIMIT_FILE_SIZE' ? `El archivo supera ${config.MAX_FILE_MB} MB.` : 'Envía un único archivo en el campo archivo y los datos requeridos.' });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ message: 'JSON inválido.' });
    if (error.type === 'entity.too.large') return res.status(413).json({ message: 'El cuerpo de la solicitud es demasiado grande.' });
    const status = error.status || 503;
    if (!error.status) logger.error({ requestId: req.requestId, code: error.code || error.name || 'SERVICE_ERROR' });
    res.status(status).json({ message: error.status ? error.message : 'El servicio no está disponible. Intenta de nuevo.', requestId: req.requestId });
  });
  return app;
}
module.exports = { createApp };
