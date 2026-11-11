'use strict';
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { loadConfig } = require('../src/config');
const { connectDatabase } = require('../src/database');
const { createApp } = require('../src/app');
const { PDFDocument } = require('pdf-lib');
const { digest } = require('../src/identification');

describe('API de documentos (Mongo real aislado, almacenamiento simulado)', () => {
  let mongo, db, app, token, otherToken, adminToken, storage, config;
  const content = Buffer.from('%PDF-1.7\nDocumento de prueba');
  const design = 'https://www.canva.com/design/DAGabc123/abcDEF/edit?utm_source=share';
  const input = { nombre: 'Brochure comercial', empresa: 'General', tipo: 'brochure', descripcion: 'Oferta institucional' };
  const auth = token => ({ Authorization: `Bearer ${token}` });
  const upload = (identity = token, fields = input, bytes = content, filename = 'brochure.pdf') => {
    let req = request(app).post('/api/documentos').set(auth(identity));
    for (const [key, value] of Object.entries(fields)) req = req.field(key, value);
    return req.attach('archivo', bytes, filename);
  };
  before(async () => {
    mongo = await MongoMemoryServer.create();
    config = loadConfig({ MONGO_URI: mongo.getUri(), MONGO_DB_NAME: 'repositorio_documentos',
      JWT_SECRET: 'test-only-secret', AWS_REGION: 'us-east-1', S3_BUCKET: 'genika-repositorio-documentos',
      MAX_FILE_MB: '1', NODE_ENV: 'test' });
    db = await connectDatabase(config);
    const sign = (id, permisos = {}) => jwt.sign({ id_usuario: id, username: `user${id}`,
      personal: { nombre: 'Ana', apellido: 'Gómez' }, permisos }, config.JWT_SECRET, { expiresIn: '1h' });
    token = sign(1); otherToken = sign(2); adminToken = sign(3, { esAdmin: true });
    storage = { files: new Map(), puts: 0, gets: 0, failPut: false, failGet: false,
      async put(key, bytes) { this.puts++; if (this.failPut) throw new Error('S3 unavailable'); this.files.set(key, bytes); },
      async get(key) { this.gets++; if (this.failGet) throw new Error('S3 unavailable'); return { Body: Readable.from([this.files.get(key)]) }; },
      async remove(key) { this.files.delete(key); }, async ready() {} };
  });
  after(async () => { await db?.connection.close(); await mongo?.stop(); });
  beforeEach(async () => {
    await db.Document.deleteMany({}); await db.Audit.deleteMany({}); storage.files.clear(); storage.puts = 0; storage.gets = 0;
    storage.failPut = false; storage.failGet = false;
    app = createApp({ config, ...db, storage, logger: { error() {} } });
  });
  it('protege todas las rutas de negocio antes de leer archivos o metadatos', async () => {
    const id = '0123456789abcdef01234567';
    for (const url of ['', '/catalogos', '/resumen', '/ready', `/${id}`, `/${id}/descarga`])
      await request(app).get(`/api/documentos${url}`).expect(401);
    await request(app).post('/api/documentos').attach('archivo', content, 'test.pdf').expect(401);
    await request(app).patch(`/api/documentos/${id}`).send({ nombre: 'Nuevo' }).expect(401);
    assert.equal(storage.puts, 0);
  });
  it('rechaza JWT expirado, firma incorrecta, token sin identidad o sin expiración', async () => {
    const tokens = [jwt.sign({ id_usuario: 1 }, 'bad-key', { expiresIn: '1h' }),
      jwt.sign({ id_usuario: 1 }, 'test-only-secret', { expiresIn: -1 }),
      jwt.sign({ internal_service: true }, 'test-only-secret', { expiresIn: '1h' }),
      jwt.sign({ id_usuario: 1 }, 'test-only-secret')];
    for (const invalid of tokens) await request(app).get('/api/documentos').set(auth(invalid)).expect(401);
  });
  it('sube, consulta y descarga exactamente los bytes originales sin publicar la clave de S3', async () => {
    const created = await upload(token, { ...input, canvaUrl: design }).expect(201);
    assert.equal(created.body.creadoPor.id, '1'); assert.equal(created.body.creadoPor.nombre, 'Ana Gómez');
    assert.equal(created.body.storageKey, undefined); assert.equal(created.body.archivoDisponible, true);
    assert.equal(created.body.canvaUrl, design); assert.equal(created.body.sha256.length, 64);
    const id = created.body._id;
    const get = await request(app).get(`/api/documentos/${id}`).set(auth(otherToken)).expect(200);
    assert.equal(get.body.puedeEditar, false); assert.equal(get.body.storageKey, undefined);
    const downloaded = await request(app).get(`/api/documentos/${id}/descarga`).set(auth(otherToken)).expect(200);
    assert.deepEqual(downloaded.body, content);
    assert.match(downloaded.headers['content-disposition'], /attachment/);
    assert.equal(downloaded.headers['cache-control'], 'no-store');
    assert.equal([...storage.files.keys()][0].startsWith(`documentos/${id}/`), true);
    assert.equal(db.connection.name, 'repositorio_documentos');
  });
  it('registra diseños solo de Canva sin escribir en S3; exige archivo para descargar', async () => {
    for (let i = 0; i < 2; i++) {
      const created = await request(app).post('/api/documentos').set(auth(token)).send({ ...input, canvaUrl: design }).expect(201);
      assert.equal(created.body.archivoDisponible, false); assert.equal(created.body.extension, 'canva');
      await request(app).get(`/api/documentos/${created.body._id}/descarga`).set(auth(token)).expect(409);
      await request(app).patch(`/api/documentos/${created.body._id}`).set(auth(token)).send({ canvaUrl: '' }).expect(400);
    }
    assert.equal(storage.puts, 0); assert.equal(storage.gets, 0);
  });
  it('valida enlaces de Canva y evita aceptar dominios similares o direcciones arbitrarias', async () => {
    const invalid = ['https://canva.com.evil.test/design/abc/edit', 'http://www.canva.com/design/abc/edit',
      'https://evil.test/?next=https://www.canva.com/design/abc/edit', 'https://user:pass@www.canva.com/design/abc/edit',
      'javascript:alert(1)', 'https://www.canva.com/otro'];
    for (const canvaUrl of invalid) await request(app).post('/api/documentos').set(auth(token)).send({ ...input, canvaUrl }).expect(400);
    await request(app).post('/api/documentos').set(auth(token)).send(input).expect(400);
    assert.equal(await db.Document.countDocuments(), 0);
  });
  it('edita solo autor o administrador, conserva descripción y enlace al omitirlos en PATCH', async () => {
    const created = await upload(token, { ...input, canvaUrl: design }).expect(201);
    const url = `/api/documentos/${created.body._id}`;
    await request(app).patch(url).set(auth(otherToken)).send({ nombre: 'No autorizado' }).expect(403);
    const updated = await request(app).patch(url).set(auth(token)).send({ nombre: 'Brochure 2026' }).expect(200);
    assert.equal(updated.body.descripcion, input.descripcion); assert.equal(updated.body.canvaUrl, design);
    await request(app).patch(url).set(auth(adminToken)).send({ empresa: 'Fastway' }).expect(200);
    await request(app).patch(url).set(auth(token)).send({ creadoPor: { id: '2' } }).expect(400);
    await request(app).patch(url).set(auth(token)).send({ storageKey: 'otro-bucket/file' }).expect(400);
    await request(app).patch(url).set(auth(token)).send({}).expect(400);
  });
  it('filtra, pagina, ordena y obtiene catálogos y estadísticas sin perder filtros', async () => {
    await upload().expect(201);
    await upload(token, { ...input, nombre: 'Formato de oferta', empresa: 'Fastway', tipo: 'formato' }).expect(201);
    const filtered = await request(app).get('/api/documentos?q=oferta&empresa=Fastway&tipo=formato&extension=pdf').set(auth(token)).expect(200);
    assert.equal(filtered.body.total, 1); assert.equal(filtered.body.items[0].empresa, 'Fastway');
    const paged = await request(app).get('/api/documentos?limit=1&page=2&orden=nombre').set(auth(token)).expect(200);
    assert.equal(paged.body.total, 2); assert.equal(paged.body.pages, 2); assert.equal(paged.body.items.length, 1);
    const catalog = await request(app).get('/api/documentos/catalogos').set(auth(token)).expect(200);
    assert.deepEqual(catalog.body.empresas, ['Fastway', 'Harvest', 'Green Way', 'General', 'Otra']);
    assert.deepEqual(catalog.body.empresasRegistradas, ['Fastway', 'General']);
    const summary = await request(app).get('/api/documentos/resumen').set(auth(token)).expect(200);
    assert.equal(summary.body.documentos, 2); assert.equal(summary.body.bytes, content.length * 2);
    await request(app).get('/api/documentos?limit=0').set(auth(token)).expect(400);
    await request(app).get('/api/documentos?empresa[$ne]=x').set(auth(token)).expect(400);
    const literal = await request(app).get('/api/documentos?q=.*').set(auth(token)).expect(200);
    assert.equal(literal.body.total, 0);
  });
  it('ordena globalmente por empresa y nombre antes de paginar, conservando filtros y totales', async () => {
    for (const [empresa, nombre] of [['Harvest', 'Membrete'], ['Fastway', 'Oferta 10'], ['Green Way', 'Membrete'], ['Fastway', 'Oferta 2']])
      await request(app).post('/api/documentos').set(auth(token)).send({ ...input, empresa, nombre, canvaUrl: design }).expect(201);
    const first = await request(app).get('/api/documentos').set(auth(token)).query({ orden: 'empresa', limit: 2 }).expect(200);
    const second = await request(app).get('/api/documentos').set(auth(token)).query({ orden: 'empresa', limit: 2, page: 2 }).expect(200);
    assert.equal(first.body.total, 4); assert.equal(first.body.pages, 2);
    assert.deepEqual(first.body.items.map(item => `${item.empresa}/${item.nombre}`), ['Fastway/Oferta 2', 'Fastway/Oferta 10']);
    assert.deepEqual(second.body.items.map(item => item.empresa), ['Green Way', 'Harvest']);
    const filtered = await request(app).get('/api/documentos').set(auth(token)).query({ orden: 'empresa', empresa: 'Fastway' }).expect(200);
    assert.equal(filtered.body.total, 2); assert.equal(filtered.body.items.length, 2);
    for (const orden of ['empresa', 'nombre', 'recientes']) {
      const missing = await request(app).get('/api/documentos').set(auth(token)).query({ orden, empresa: 'fastway' }).expect(200);
      assert.equal(missing.body.total, 0); assert.equal(missing.body.items.length, 0);
    }
    const byName = await request(app).get('/api/documentos').set(auth(token)).query({ orden: 'nombre' }).expect(200);
    assert.equal(byName.body.total, 4);
  });
  it('rechaza extensión, contenido falso, archivos vacíos, tamaño y campos inválidos antes de S3', async () => {
    await upload(token, input, content, 'archivo.exe').expect(415);
    await upload(token, input, Buffer.from('archivo falso'), 'archivo.pdf').expect(415);
    await upload(token, input, Buffer.alloc(0), 'archivo.pdf').expect(400);
    await upload(token, input, Buffer.alloc(1024 * 1024 + 1), 'archivo.pdf').expect(413);
    await upload(token, { ...input, empresa: '' }).expect(400);
    assert.equal(storage.puts, 0); assert.equal(await db.Document.countDocuments(), 0);
  });
  it('ofrece las cinco empresas aunque no haya documentos y rechaza escritura libre antes de guardar archivos', async () => {
    const catalog = await request(app).get('/api/documentos/catalogos').set(auth(token)).expect(200);
    assert.deepEqual(catalog.body.empresas, ['Fastway', 'Harvest', 'Green Way', 'General', 'Otra']);
    assert.deepEqual(catalog.body.empresasRegistradas, []);
    for (const empresa of ['fastway', 'Greenway', 'Otra empresa', 'General ', ''])
      await upload(token, { ...input, empresa }).expect(400);
    assert.equal(storage.puts, 0); assert.equal(await db.Document.countDocuments(), 0);
    for (const empresa of catalog.body.empresas)
      await request(app).post('/api/documentos').set(auth(token)).send({ ...input, empresa, canvaUrl: design }).expect(201);
  });
  it('valida la empresa también al editar o publicar versiones, conservando el historial existente', async () => {
    const created = await upload(token, { ...input, empresa: 'Green Way' }).expect(201);
    const url = `/api/documentos/${created.body._id}`;
    const puts = storage.puts;
    await request(app).patch(url).set(auth(token)).send({ empresa: 'Greenway', baseVersion: 1 }).expect(400);
    await request(app).post(`${url}/versiones`).set(auth(token)).field('empresa', 'Greenway')
      .field('baseVersion', '1').attach('archivo', content, 'nuevo.pdf').expect(400);
    assert.equal(storage.puts, puts);
    const updated = await request(app).patch(url).set(auth(token)).send({ empresa: 'Otra', baseVersion: 1 }).expect(200);
    assert.equal(updated.body.empresa, 'Otra'); assert.equal(updated.body.versionActual, 2);
    const versions = await request(app).get(`${url}/versiones`).set(auth(token)).expect(200);
    assert.equal(versions.body.items.find(v => v.numero === 1).empresa, 'Green Way');
    // Un valor histórico libre sigue visible y filtrable, sin añadirlo al catálogo para nuevas cargas.
    await db.Document.updateOne({ _id: created.body._id }, { $set: { empresa: 'Greenway' } });
    const catalog = await request(app).get('/api/documentos/catalogos').set(auth(token)).expect(200);
    assert.ok(catalog.body.empresasRegistradas.includes('Greenway'));
    assert.ok(!catalog.body.empresas.includes('Greenway'));
    const old = await request(app).get('/api/documentos').set(auth(token)).query({ empresa: 'Greenway' }).expect(200);
    assert.equal(old.body.total, 1);
  });
  it('limpia S3 si Mongo falla al registrar el archivo', async () => {
    const original = db.Document.create;
    db.Document.create = async () => { throw new Error('Mongo write failure'); };
    try { await upload().expect(503); } finally { db.Document.create = original; }
    assert.equal(storage.files.size, 0); assert.equal(await db.Document.countDocuments(), 0);
  });
  it('informa fallos de S3 sin crear registros ni filtrar detalles', async () => {
    storage.failPut = true;
    const failed = await upload().expect(503);
    assert.equal(failed.body.message.includes('S3 unavailable'), false);
    assert.equal(await db.Document.countDocuments(), 0);
  });
  it('devuelve 400 para ID inválido y 404 para documento inexistente', async () => {
    await request(app).get('/api/documentos/no-es-id').set(auth(token)).expect(400);
    await request(app).get('/api/documentos/0123456789abcdef01234567').set(auth(token)).expect(404);
  });
  it('conserva originales y muestra solo la versión actual en el listado principal', async () => {
    const first = await upload().expect(201);
    const id = first.body._id;
    const secondBytes = Buffer.from('%PDF-1.7\nVersion segunda del brochure');
    const second = await request(app).post(`/api/documentos/${id}/versiones`).set(auth(token))
      .field('baseVersion', '1').field('notaCambio', 'Servicios actualizados').attach('archivo', secondBytes, 'nuevo.pdf').expect(201);
    assert.equal(second.body.versionActual, 2); assert.equal(second.body.nombreOriginal, 'nuevo.pdf');
    const list = await request(app).get('/api/documentos').set(auth(token)).expect(200);
    assert.equal(list.body.total, 1); assert.equal(list.body.items[0].versionActual, 2);
    assert.equal(list.body.items[0].versiones, undefined);
    const versions = await request(app).get(`/api/documentos/${id}/versiones`).set(auth(token)).expect(200);
    assert.deepEqual(versions.body.items.map(v => v.numero), [2, 1]);
    assert.equal(versions.body.items[0].subidoPor.id, '1');
    assert.equal(versions.body.items[0].notaCambio, 'Servicios actualizados');
    assert.ok(versions.body.items.every(v => v.fecha && !v.storageKey));
    const old = await request(app).get(`/api/documentos/${id}/descarga?version=1`).set(auth(token)).expect(200);
    const current = await request(app).get(`/api/documentos/${id}/descarga`).set(auth(token)).expect(200);
    assert.deepEqual(old.body, content); assert.deepEqual(current.body, secondBytes);
    assert.equal(storage.files.size, 2);
    await request(app).get(`/api/documentos/${id}/descarga?version=99`).set(auth(token)).expect(404);
  });
  it('detecta cargas concurrentes y limpia solo la carga rechazada, nunca una versión anterior', async () => {
    const first = await upload().expect(201);
    const id = first.body._id;
    let arrivals = 0, release;
    const gate = new Promise(resolve => { release = resolve; });
    const originalPut = storage.put;
    storage.put = async function(key, bytes) {
      await originalPut.call(this, key, bytes);
      arrivals++; if (arrivals === 2) release();
      await gate;
    };
    try {
      const results = await Promise.all(['A', 'B'].map(name => request(app).post(`/api/documentos/${id}/versiones`).set(auth(token))
        .field('baseVersion', '1').attach('archivo', Buffer.from(`%PDF-1.7\n${name}`), `${name}.pdf`)));
      assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
      assert.equal(storage.files.size, 2);
      const document = await db.Document.findById(id).select('+versiones');
      assert.equal(document.versionActual, 2); assert.equal(document.versiones.length, 2);
    } finally { storage.put = originalPut; }
  });
  it('crea versiones de metadatos sin cambiar el archivo histórico', async () => {
    const first = await upload().expect(201);
    await request(app).patch(`/api/documentos/${first.body._id}`).set(auth(token)).send({ nombre: 'Nuevo nombre', notaCambio: 'Corrección de nombre' }).expect(200);
    const versions = await request(app).get(`/api/documentos/${first.body._id}/versiones`).set(auth(token)).expect(200);
    assert.equal(versions.body.items[0].nombre, 'Nuevo nombre'); assert.equal(versions.body.items[1].nombre, input.nombre);
    assert.equal(storage.files.size, 1);
  });
  it('una nueva versión solo Canva conserva el archivo anterior exclusivamente en el historial', async () => {
    const first = await upload().expect(201);
    const url = `/api/documentos/${first.body._id}`;
    const current = await request(app).post(`${url}/versiones`).set(auth(token)).send({ baseVersion: 1, canvaUrl: design }).expect(201);
    assert.equal(current.body.archivoDisponible, false); assert.equal(current.body.nombreOriginal, undefined);
    await request(app).get(`${url}/descarga`).set(auth(token)).expect(409);
    await request(app).get(`${url}/descarga?version=1`).set(auth(token)).expect(200);
    assert.equal(storage.files.size, 1);
  });
  it('audita la persona, fecha y versión descargada; las vistas previas no crean descargas', async () => {
    const first = await upload(token, input, Buffer.from('Texto compartido'), 'prueba.txt').expect(201);
    const url = `/api/documentos/${first.body._id}`;
    await request(app).get(`${url}/vista-previa?version=1`).set(auth(otherToken)).expect(200);
    assert.equal(await db.Audit.countDocuments(), 0);
    await request(app).get(`${url}/descarga?version=1`).set(auth(otherToken)).expect(200);
    const result = await request(app).get(`${url}/auditoria`).set(auth(token)).expect(200);
    assert.equal(result.body.total, 1);
    const log = result.body.items[0];
    assert.equal(log.usuario.id, '2'); assert.equal(log.version, 1); assert.equal(log.accion, 'descarga');
    assert.ok(log.fecha); assert.ok(log.requestId); assert.equal(log.nombreArchivo, 'prueba.txt');
    assert.equal(log.resultado, 'completada');
  });
  it('no entrega el archivo si no puede persistir su auditoría', async () => {
    const first = await upload().expect(201);
    const create = db.Audit.create;
    db.Audit.create = async () => { throw new Error('Audit unavailable'); };
    try { await request(app).get(`/api/documentos/${first.body._id}/descarga`).set(auth(otherToken)).expect(503); }
    finally { db.Audit.create = create; }
    assert.equal(storage.gets, 0);
  });
  it('impide nuevas versiones ajenas antes de escribir objetos S3', async () => {
    const first = await upload().expect(201);
    await request(app).post(`/api/documentos/${first.body._id}/versiones`).set(auth(otherToken)).field('baseVersion', '1').attach('archivo', content, 'otro.pdf').expect(403);
    assert.equal(storage.files.size, 1);
    await request(app).get(`/api/documentos/${first.body._id}/versiones`).expect(401);
    await request(app).get(`/api/documentos/${first.body._id}/auditoria`).expect(401);
    await request(app).get(`/api/documentos/${first.body._id}/vista-previa`).expect(401);
    await request(app).get(`/api/documentos/${first.body._id}/miniatura`).expect(401);
  });
  it('evita simular versiones congeladas de Canva reutilizando el mismo diseño mutable', async () => {
    const first = await request(app).post('/api/documentos').set(auth(token)).send({ ...input, canvaUrl: design }).expect(201);
    await request(app).post(`/api/documentos/${first.body._id}/versiones`).set(auth(token))
      .send({ baseVersion: 1, canvaUrl: design + '&utm_campaign=nuevo' }).expect(409);
    const second = await request(app).post(`/api/documentos/${first.body._id}/versiones`).set(auth(token))
      .send({ baseVersion: 1, canvaUrl: 'https://www.canva.com/design/DAGnuevo123/edit' }).expect(201);
    assert.equal(second.body.versionActual, 2);
  });
  it('descarga la copia Genika y conserva el original; no expone claves internas ni mezcla versiones', async () => {
    const pdf = await PDFDocument.create(); pdf.addPage(); pdf.setAuthor('Autor de origen');
    const original = Buffer.from(await pdf.save());
    const first = await upload(token, input, original).expect(201);
    const id = first.body._id;
    assert.equal(first.body.identificacion.modo, 'interna'); assert.equal(first.body.identificacion.origen, 'Genika');
    assert.equal(first.body.identificacion.storageKey, undefined); assert.equal(storage.files.size, 2);
    const branded = await request(app).get(`/api/documentos/${id}/descarga`).set(auth(otherToken)).expect(200);
    assert.equal((await PDFDocument.load(branded.body, { updateMetadata: false })).getAuthor(), 'Genika | General');
    assert.equal(branded.headers['x-genika-metadata'], 'interna');
    const source = await request(app).get(`/api/documentos/${id}/descarga?original=true`).set(auth(token)).expect(200);
    assert.deepEqual(source.body, original);
    await request(app).get(`/api/documentos/${id}/descarga?original=true`).set(auth(otherToken)).expect(403);
    await request(app).get(`/api/documentos/${id}/descarga?original=quizas`).set(auth(token)).expect(400);
    const updated = await request(app).patch(`/api/documentos/${id}`).set(auth(token)).send({ nombre: 'Brochure nuevo', baseVersion: 1 }).expect(200);
    assert.equal(updated.body.versionActual, 2); assert.equal(updated.body.identificacion.version, 2);
    assert.notEqual(updated.body.identificacion.codigo, first.body.identificacion.codigo);
    assert.equal(storage.files.size, 3); // Un original y dos copias identificadas, sin borrar ninguna.
    const old = await request(app).get(`/api/documentos/${id}/descarga?version=1`).set(auth(token)).expect(200);
    const current = await request(app).get(`/api/documentos/${id}/descarga?version=2`).set(auth(token)).expect(200);
    assert.deepEqual(old.body, branded.body);
    assert.equal((await PDFDocument.load(current.body, { updateMetadata: false })).getTitle(), 'Brochure nuevo');
    const versions = await request(app).get(`/api/documentos/${id}/versiones`).set(auth(token)).expect(200);
    assert.ok(versions.body.items.every(v => !v.identificacion.storageKey && !v.storageKey));
    const audit = await db.Audit.find({ documentoId: id }).lean();
    assert.ok(audit.some(v => v.variante === 'genika')); assert.ok(audit.some(v => v.variante === 'original'));
  });
  it('verifica el archivo exacto de una versión Genika o su original y rechaza una copia alterada', async () => {
    const pdf = await PDFDocument.create(); pdf.addPage();
    const original = Buffer.from(await pdf.save());
    const created = await upload(token, input, original).expect(201);
    const branded = await request(app).get(`/api/documentos/${created.body._id}/descarga`).set(auth(token)).expect(200);
    const verify = (bytes, identity = token) => request(app).post('/api/documentos/verificar').set(auth(identity)).attach('archivo', bytes, 'consulta.pdf');
    const verified = await verify(branded.body).expect(200);
    assert.equal(verified.body.registrado, true); assert.equal(verified.body.sha256, digest(branded.body));
    assert.equal(verified.body.coincidencias[0].variante, 'genika'); assert.equal(verified.body.coincidencias[0].version, 1);
    assert.equal(verified.body.coincidencias[0].identificacion.storageKey, undefined);
    const source = await verify(original).expect(200);
    assert.equal(source.body.coincidencias[0].variante, 'original');
    const altered = await verify(Buffer.concat([branded.body, Buffer.from('alterado')])).expect(200);
    assert.equal(altered.body.registrado, false); assert.deepEqual(altered.body.coincidencias, []);
    await request(app).post('/api/documentos/verificar').attach('archivo', original, 'consulta.pdf').expect(401);
    assert.equal(await db.Document.countDocuments(), 1); // La verificación no escribe documentos ni archivos.
    assert.equal(storage.files.size, 2);
  });
  it('limpia original y copia identificada si falla el registro de un PDF real', async () => {
    const pdf = await PDFDocument.create(); pdf.addPage();
    const original = db.Document.create;
    db.Document.create = async () => { throw new Error('Mongo failure'); };
    try { await upload(token, input, Buffer.from(await pdf.save())).expect(503); }
    finally { db.Document.create = original; }
    assert.equal(storage.files.size, 0);
  });
});
