'use strict';
// Prueba explícita de integración. Escribe y elimina únicamente su propio registro temporal.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { loadConfig } = require('../src/config');
const { connectDatabase } = require('../src/database');
const { S3Storage } = require('../src/storage');
const { createApp } = require('../src/app');

async function main() {
  const config = loadConfig();
  assert.equal(config.MONGO_DB_NAME, 'repositorio_documentos', 'La prueba solo permite la base de esta API');
  assert.equal(config.S3_BUCKET, 'genika-repositorio-documentos', 'La prueba solo permite el bucket de esta API');
  const database = await connectDatabase(config);
  const storage = new S3Storage(config);
  const app = createApp({ config, ...database, storage });
  const testId = `qa-api-${randomUUID()}`;
  const token = jwt.sign({ id_usuario: testId, username: 'Verificación temporal API', permisos: {} }, config.JWT_SECRET, { expiresIn: '2m' });
  const authorization = `Bearer ${token}`;
  const bytes = Buffer.from(`Verificación temporal del repositorio Genika: ${testId}\n`, 'utf8');
  let document;
  try {
    await storage.ready();
    await request(app).get('/api/documentos').expect(401);
    await request(app).get('/api/documentos/ready').set('Authorization', authorization).expect(200);
    const created = await request(app).post('/api/documentos').set('Authorization', authorization)
      .field('nombre', testId).field('empresa', 'Verificación API').field('tipo', 'otro')
      .field('canvaUrl', 'https://www.canva.com/design/DAGtest123/edit')
      .attach('archivo', bytes, 'verificacion.txt').expect(201);
    document = await database.Document.findById(created.body._id).select('+storageKey');
    assert.equal(document.creadoPor.id, testId);
    const result = await request(app).get(`/api/documentos/${document._id}/descarga`).set('Authorization', authorization).expect(200);
    assert.equal(result.text, bytes.toString('utf8'));
    if (config.S3_ENDPOINT && config.S3_FORCE_PATH_STYLE === 'true') {
      const url = `${config.S3_ENDPOINT.replace(/\/$/, '')}/${config.S3_BUCKET}/${document.storageKey.split('/').map(encodeURIComponent).join('/')}`;
      const anonymous = await fetch(url, { signal: AbortSignal.timeout(5000) });
      await anonymous.body?.cancel();
      assert.equal(anonymous.status, 403, 'La descarga anónima en MinIO debe estar bloqueada');
    }
    const list = await request(app).get('/api/documentos').query({ q: testId }).set('Authorization', authorization).expect(200);
    assert.equal(list.body.total, 1); assert.equal(list.body.items[0].storageKey, undefined);
    console.log('Integración real OK: JWT WMS, Mongo exclusivo, carga/descarga S3, enlace Canva y acceso anónimo bloqueado.');
  } finally {
    // Filtro exacto del actor aleatorio: nunca toca registros ajenos a esta ejecución.
    const ownRecords = await database.Document.find({ 'creadoPor.id': testId }).select('+storageKey');
    try {
      for (const own of ownRecords) {
        if (own.storageKey) await storage.remove(own.storageKey);
        await database.Audit.deleteMany({ documentoId: own._id, 'usuario.id': testId });
        await database.Document.deleteOne({ _id: own._id, 'creadoPor.id': testId });
      }
      console.log(`Limpieza OK: ${ownRecords.length} registro(s) temporal(es) y sus archivos eliminados.`);
    } finally { await database.connection.close(); storage.client.destroy(); }
  }
}
main().catch(error => {
  console.error('Falló la integración real:', error.name || 'Error');
  process.exitCode = 1;
});
