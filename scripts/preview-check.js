'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { randomUUID } = require('node:crypto');
const { loadConfig } = require('../src/config');
const { connectDatabase } = require('../src/database');
const { S3Storage } = require('../src/storage');
const { createApp } = require('../src/app');
const { PDFDocument } = require('pdf-lib');
const { readZip } = require('../src/identification');
async function main() {
  const config = loadConfig();
  assert.equal(config.MONGO_DB_NAME, 'repositorio_documentos');
  assert.equal(config.S3_BUCKET, 'genika-repositorio-documentos');
  const db = await connectDatabase(config);
  const storage = new S3Storage(config);
  const app = createApp({ config, ...db, storage });
  const actor = `qa-preview-${randomUUID()}`;
  const token = jwt.sign({ id_usuario: actor, username: 'QA vista previa', permisos: {} }, config.JWT_SECRET, { expiresIn: '10m' });
  const auth = { Authorization: `Bearer ${token}` };
  const fixture = name => fs.readFile(path.resolve(__dirname, '../.runtime/preview-fixtures', name));
  const check = async (id, version) => {
    const preview = await request(app).get(`/api/documentos/${id}/vista-previa?version=${version}`).set(auth).expect(200);
    assert.equal(preview.body.subarray(0, 5).toString(), '%PDF-');
    assert.equal((await PDFDocument.load(preview.body, { updateMetadata: false })).getCreator(), 'Genika');
    const thumb = await request(app).get(`/api/documentos/${id}/miniatura?version=${version}`).set(auth).expect(200);
    assert.equal(thumb.body[0], 255); assert.equal(thumb.body[1], 216);
    assert.equal(await db.Audit.countDocuments({ documentoId: id }), 0);
  };
  try {
    const original = await fixture('brochure.docx');
    const created = await request(app).post('/api/documentos').set(auth).field('nombre', actor)
      .field('empresa', 'General').field('tipo', 'brochure').attach('archivo', original, 'brochure.docx').expect(201);
    const id = created.body._id;
    assert.equal(created.body.identificacion.modo, 'interna');
    const branded = await request(app).get(`/api/documentos/${id}/descarga`).set(auth).buffer(true).parse((response, callback) => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => callback(null, Buffer.concat(chunks)));
    }).expect(200);
    assert.match((await readZip(branded.body, config.maxBytes)).get('docProps/core.xml').toString(), /<dc:creator>Genika/);
    // El check siguiente solo comprueba que las vistas previas no agreguen auditorías.
    await db.Audit.deleteMany({ documentoId: id, 'usuario.id': actor });
    await check(id, 1);
    await request(app).post(`/api/documentos/${id}/versiones`).set(auth).field('baseVersion', '1')
      .field('notaCambio', 'Actualización a presentación').attach('archivo', await fixture('presentacion.pptx'), 'presentacion.pptx').expect(201);
    await check(id, 2);
    const old = await request(app).get(`/api/documentos/${id}/descarga?version=1&original=true`).set(auth).buffer(true).parse((response, callback) => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => callback(null, Buffer.concat(chunks)));
    }).expect(200);
    assert.deepEqual(old.body, original);
    const list = await request(app).get('/api/documentos').set(auth).query({ q: actor }).expect(200);
    assert.equal(list.body.total, 1); assert.equal(list.body.items[0].versionActual, 2);
    const spreadsheet = await request(app).post('/api/documentos').set(auth).field('nombre', `${actor}-xlsx`)
      .field('empresa', 'General').field('tipo', 'formato').attach('archivo', await fixture('oferta.xlsx'), 'oferta.xlsx').expect(201);
    await check(spreadsheet.body._id, 1);
    console.log('Office real OK: Word, PowerPoint y Excel convertidos a PDF y miniatura; versiones preservadas y descarga auditada.');
  } finally {
    const records = await db.Document.find({ 'creadoPor.id': actor }).select('+storageKey +versiones');
    for (const record of records) {
      const keys = new Set([record.storageKey, ...record.versiones.map(v => v.storageKey)].filter(Boolean));
      for (const key of keys) for (const suffix of ['', '.preview.pdf', '.thumb.jpg']) await storage.remove(key + suffix);
      for (const version of record.versiones) {
        if (version.identificacion?.storageKey) await storage.remove(version.identificacion.storageKey);
        if (version.identificacion?.codigo && version.storageKey) {
          const base = `${version.storageKey}.g-${version.identificacion.codigo}`;
          for (const suffix of ['.preview.pdf', '.thumb.jpg']) await storage.remove(base + suffix);
        }
      }
      await db.Audit.deleteMany({ documentoId: record._id, 'usuario.id': actor });
      await db.Document.deleteOne({ _id: record._id, 'creadoPor.id': actor });
    }
    await db.connection.close(); storage.client.destroy();
    console.log('Prueba Office: registros, auditorías y archivos temporales eliminados del destino exclusivo de esta API.');
  }
}
main().catch(error => { console.error('Falló la comprobación Office:', error.message); process.exitCode = 1; });
