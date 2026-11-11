'use strict';
const { actor, canEdit } = require('./auth');
const FIELDS = ['nombre', 'empresa', 'tipo', 'descripcion', 'canvaUrl', 'archivoDisponible',
  'nombreOriginal', 'extension', 'mime', 'bytes', 'sha256', 'storageKey', 'identificacion'];
const fail = (status, message) => Object.assign(new Error(message), { status });
function snapshot(document, user, numero, notaCambio = '') {
  const plain = document.toObject ? document.toObject() : document;
  return { ...Object.fromEntries(FIELDS.filter(key => plain[key] !== undefined).map(key => [key, plain[key]])),
    numero, fecha: plain.identificacion?.version === numero ? plain.identificacion.fecha : new Date(), subidoPor: actor(user), notaCambio };
}
function history(document) {
  if (document.versiones?.length) return document.versiones.map(v => v.toObject ? v.toObject() : v);
  const baseline = snapshot(document, { id_usuario: document.creadoPor.id, username: document.creadoPor.nombre }, 1, 'Versión inicial');
  baseline.fecha = document.createdAt;
  baseline.subidoPor = document.creadoPor.toObject ? document.creadoPor.toObject() : document.creadoPor;
  return [baseline];
}
function versionOf(document, requested) {
  const number = requested === undefined ? document.versionActual : Number(requested);
  if (!Number.isInteger(number) || number < 1) throw fail(400, 'Número de versión inválido.');
  const version = history(document).find(item => item.numero === number);
  if (!version) throw fail(404, 'La versión solicitada no existe.');
  return version;
}
async function appendVersion(Document, document, input, file, user, baseVersion) {
  if (!canEdit(user, document)) throw fail(403, 'Solo el autor o un administrador puede cargar versiones.');
  const current = document.versionActual || 1;
  if (baseVersion !== undefined && Number(baseVersion) !== current)
    throw fail(409, 'Ya existe una versión más reciente. Actualiza el documento antes de continuar.');
  const { notaCambio = '', baseVersion: ignored, ...metadata } = input;
  const next = snapshot({ ...document.toObject(), ...metadata, ...(file || {}) }, user, current + 1, notaCambio);
  if (!next.archivoDisponible && !next.canvaUrl) throw fail(400, 'Un registro sin archivo debe conservar su enlace de Canva.');
  const update = Object.fromEntries(FIELDS.filter(key => next[key] !== undefined).map(key => [key, next[key]]));
  const updated = await Document.findOneAndUpdate({ _id: document._id,
    ...(current === 1 ? { $or: [{ versionActual: 1 }, { versionActual: { $exists: false } }] } : { versionActual: current }),
  }, { $set: { ...update, versionActual: next.numero, ultimaVersionPor: next.subidoPor, actualizadoPor: next.subidoPor.id },
    ...(!next.archivoDisponible ? { $unset: { storageKey: 1, sha256: 1, nombreOriginal: 1 } } : {}),
    $push: { versiones: { $each: [...(document.versiones?.length ? [] : history(document)), next] } },
  }, { new: true, runValidators: true });
  if (!updated) throw fail(409, 'Otra persona publicó una versión mientras cargabas. Actualiza e intenta de nuevo.');
  return updated;
}
module.exports = { FIELDS, snapshot, history, versionOf, appendVersion };
