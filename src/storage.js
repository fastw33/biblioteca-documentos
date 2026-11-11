'use strict';
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand,
  CreateBucketCommand, PutPublicAccessBlockCommand } = require('@aws-sdk/client-s3');

class S3Storage {
  constructor(config, client) {
    this.config = config;
    this.client = client || new S3Client({ region: config.AWS_REGION, maxAttempts: 2,
      ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT, forcePathStyle: config.S3_FORCE_PATH_STYLE === 'true' } : {}),
      requestHandler: { connectionTimeout: 5000, requestTimeout: 30000 },
    });
  }
  key(key) {
    if (!key.startsWith(`${this.config.S3_PREFIX}/`) || key.includes('..')) throw new Error('Clave de almacenamiento inválida');
    return { Bucket: this.config.S3_BUCKET, Key: key };
  }
  async put(key, body, mime, metadata = {}) {
    await this.client.send(new PutObjectCommand({ ...this.key(key), Body: body, ContentType: mime,
      CacheControl: 'private, no-store', Metadata: { application: 'genika-repositorio', origen: 'Genika', ...metadata } }));
  }
  async get(key) { return this.client.send(new GetObjectCommand(this.key(key))); }
  async remove(key) { await this.client.send(new DeleteObjectCommand(this.key(key))); }
  async ready() { await this.client.send(new HeadBucketCommand({ Bucket: this.config.S3_BUCKET })); }
  async provision() {
    try { await this.ready(); return { created: false }; }
    catch (error) {
      if (error.$metadata?.httpStatusCode !== 404 && error.name !== 'NoSuchBucket' && error.name !== 'NotFound') throw error;
    }
    const { S3_BUCKET: Bucket, AWS_REGION: region, S3_ENDPOINT } = this.config;
    await this.client.send(new CreateBucketCommand({ Bucket,
      ...(!S3_ENDPOINT && region !== 'us-east-1' ? { CreateBucketConfiguration: { LocationConstraint: region } } : {}) }));
    if (!S3_ENDPOINT) await this.client.send(new PutPublicAccessBlockCommand({ Bucket, PublicAccessBlockConfiguration: {
      BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true,
    } }));
    await this.ready();
    return { created: true };
  }
}
module.exports = { S3Storage };
