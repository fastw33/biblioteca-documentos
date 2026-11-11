'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const { S3Storage } = require('../src/storage');
const config = { S3_BUCKET: 'genika-repositorio-documentos', S3_PREFIX: 'documentos', AWS_REGION: 'us-east-1', S3_ENDPOINT: 'http://127.0.0.1:9000' };
it('todas las operaciones de S3 quedan dentro del bucket y prefijo de esta API', async () => {
  const commands = [];
  const storage = new S3Storage(config, { async send(command) { commands.push(command); return {}; } });
  await storage.put('documentos/abc/file.pdf', Buffer.from('test'), 'application/pdf', { documento_id: 'abc', version: '2' });
  await storage.get('documentos/abc/file.pdf'); await storage.remove('documentos/abc/file.pdf'); await storage.ready();
  for (const command of commands) assert.equal(command.input.Bucket, config.S3_BUCKET);
  assert.equal(commands[0].input.Metadata.origen, 'Genika');
  assert.equal(commands[0].input.Metadata.documento_id, 'abc');
  assert.equal(commands[0].input.Metadata.version, '2');
  await assert.rejects(storage.put('leads/file.pdf', Buffer.from('test'), 'application/pdf'));
  await assert.rejects(storage.remove('documentos/../otro/file.pdf'));
  assert.equal(commands.length, 4);
});
it('provisiona un bucket nuevo de MinIO solo después de verificar que no existe', async () => {
  const commands = [];
  const storage = new S3Storage(config, { async send(command) {
    commands.push(command);
    if (commands.length === 1) throw Object.assign(new Error('Not found'), { $metadata: { httpStatusCode: 404 } });
    return {};
  } });
  assert.deepEqual(await storage.provision(), { created: true });
  assert.deepEqual(commands.map(c => c.constructor.name), ['HeadBucketCommand', 'CreateBucketCommand', 'HeadBucketCommand']);
  for (const command of commands) assert.equal(command.input.Bucket, config.S3_BUCKET);
});
it('no intenta crear ni modificar un bucket ante acceso denegado o un bucket existente', async () => {
  let calls = 0;
  const storage = new S3Storage(config, { async send() { calls++; throw Object.assign(new Error('Denied'), { $metadata: { httpStatusCode: 403 } }); } });
  await assert.rejects(storage.provision()); assert.equal(calls, 1);
  const existing = new S3Storage(config, { async send() { return {}; } });
  assert.deepEqual(await existing.provision(), { created: false });
});
