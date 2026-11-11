'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument, PDFName, PDFRawStream, PDFHexString } = require('pdf-lib');
const yazl = require('yazl');
const sharp = require('sharp');
const { XMLParser } = require('fast-xml-parser');
const { createIdentity, identifyBytes, readZip, digest } = require('../src/identification');
const identity = bytes => createIdentity({ _id: '0123456789abcdef01234567', nombre: 'Oferta & servicios <2026>', empresa: 'Fastway & Genika', tipo: 'oferta' },
  { id_usuario: 9, personal: { nombre: 'María', apellido: 'Pérez' } }, 2, digest(bytes));
const limit = 30 * 1024 * 1024;
async function makeZip(entries) {
  const zip = new yazl.ZipFile(); const chunks = [];
  const result = new Promise((resolve, reject) => {
    zip.outputStream.on('data', c => chunks.push(c)); zip.outputStream.on('end', () => resolve(Buffer.concat(chunks))); zip.outputStream.on('error', reject);
  });
  for (const [name, content] of Object.entries(entries)) zip.addBuffer(Buffer.from(content), name);
  zip.end(); return result;
}
const baseParts = {
  '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
  '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  'docProps/app.xml': '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Proveedor</Application><Slides>4</Slides></Properties>',
  'docProps/custom.xml': '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="CampoFormato"><vt:lpwstr>Dato usado por el formato</vt:lpwstr></property></Properties>',
};
it('PDF reemplaza Info y XMP por Genika, sin cambiar páginas ni campos del formato', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage([612, 792]);
  pdf.setAuthor('Proveedor anterior'); pdf.setCreator('Otra aplicación'); pdf.setProducer('Otro productor');
  pdf.getForm().createTextField('empresa').setText('Cliente de prueba');
  const old = pdf.context.stream(Buffer.from('<vendor>Proveedor anterior</vendor>'), { Type: PDFName.of('Metadata'), Subtype: PDFName.of('XML') });
  pdf.catalog.set(PDFName.of('Metadata'), pdf.context.register(old));
  const bytes = Buffer.from(await pdf.save()); const id = identity(bytes);
  const result = await identifyBytes(bytes, id, 'pdf', limit);
  assert.equal(result.identity.modo, 'interna'); assert.notDeepEqual(result.bytes, bytes);
  const branded = await PDFDocument.load(result.bytes, { updateMetadata: false });
  assert.equal(branded.getAuthor(), 'Genika | Fastway & Genika'); assert.equal(branded.getCreator(), 'Genika'); assert.equal(branded.getProducer(), 'Genika');
  assert.equal(branded.getTitle(), id.nombre); assert.equal(branded.getPageCount(), 1);
  assert.equal(branded.getPage(0).getWidth(), 612); assert.equal(branded.getPage(0).getHeight(), 792);
  assert.equal(branded.getForm().getTextField('empresa').getText(), 'Cliente de prueba');
  const xmp = branded.catalog.lookup(PDFName.of('Metadata'), PDFRawStream).contents.toString('utf8');
  assert.match(xmp, /Genika/); assert.match(xmp, new RegExp(id.codigo)); assert.match(xmp, /<genika:Version>2<\/genika:Version>/);
  assert.match(xmp, /Fastway &amp; Genika/); assert.doesNotMatch(xmp, /Proveedor anterior/);
  assert.equal((await PDFDocument.load(bytes, { updateMetadata: false })).getAuthor(), 'Proveedor anterior');
});
it('no modifica PDF firmado: conserva bytes y registra el motivo', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage();
  pdf.context.register(pdf.context.obj({ Type: 'Sig', Contents: PDFHexString.of('010203') }));
  const bytes = Buffer.from(await pdf.save());
  const result = await identifyBytes(bytes, identity(bytes), 'pdf', limit);
  assert.equal(result.identity.modo, 'registro'); assert.equal(result.identity.motivo, 'firma_digital_conservada');
  assert.deepEqual(result.bytes, bytes);
});
it('Office incorpora propiedades Genika y conserva contenido, macros y campos personalizados del formato', async () => {
  const parser = new XMLParser({ ignoreAttributes: false });
  for (const [extension, name] of [['docx', 'word/document.xml'], ['xlsx', 'xl/worksheets/sheet1.xml'], ['pptx', 'ppt/slides/slide1.xml'], ['docm', 'word/document.xml']]) {
    const originalContent = '<document>Contenido empresarial que debe conservarse</document>';
    const bytes = await makeZip({ ...baseParts, [name]: originalContent, 'word/vbaProject.bin': 'MACROS_BINARIAS_CONSERVADAS' });
    const id = identity(bytes); const result = await identifyBytes(bytes, id, extension, limit);
    assert.equal(result.identity.modo, 'interna', extension);
    const parts = await readZip(result.bytes, limit);
    assert.equal(parts.get(name).toString(), originalContent);
    assert.equal(parts.get('word/vbaProject.bin').toString(), 'MACROS_BINARIAS_CONSERVADAS');
    const core = parser.parse(parts.get('docProps/core.xml').toString())['cp:coreProperties'];
    assert.equal(core['dc:creator'], 'Genika | Fastway & Genika'); assert.equal(core['dc:title'], id.nombre); assert.equal(core['cp:revision'], 2);
    const app = parser.parse(parts.get('docProps/app.xml').toString()).Properties;
    assert.equal(app.Application, 'Genika'); assert.equal(app.Slides, 4);
    const custom = parser.parse(parts.get('docProps/custom.xml').toString()).Properties.property;
    assert.ok(custom.some(p => p['@_name'] === 'CampoFormato' && p['vt:lpwstr'] === 'Dato usado por el formato'));
    assert.ok(custom.some(p => p['@_name'] === 'GenikaVersion' && p['vt:lpwstr'] === 2));
  }
});
it('Office firmado permanece intacto y un contenedor inválido no aparenta identificación interna', async () => {
  const bytes = await makeZip({ ...baseParts, '_xmlsignatures/sig1.xml': '<Signature/>' });
  const result = await identifyBytes(bytes, identity(bytes), 'docx', limit);
  assert.equal(result.identity.motivo, 'firma_digital_conservada'); assert.deepEqual(result.bytes, bytes);
  const invalid = Buffer.from('PK\x03\x04archivo inválido');
  assert.equal((await identifyBytes(invalid, identity(invalid), 'docx', limit)).identity.modo, 'registro');
});
it('PNG y JPEG reciben XMP Genika sin recodificar píxeles, dimensiones ni orientación', async () => {
  for (const extension of ['png', 'jpeg']) {
    let image = sharp({ create: { width: 64, height: 40, channels: 4, background: '#f74c1b80' } });
    image = extension === 'png' ? image.png() : image.withMetadata({ orientation: 6 }).jpeg();
    const bytes = await image.toBuffer(); const id = identity(bytes);
    const result = await identifyBytes(bytes, id, extension, limit);
    assert.equal(result.identity.modo, 'interna');
    const before = await sharp(bytes).raw().toBuffer(); const after = await sharp(result.bytes).raw().toBuffer();
    assert.deepEqual(after, before);
    const source = await sharp(bytes).metadata(); const branded = await sharp(result.bytes).metadata();
    assert.equal(branded.width, source.width); assert.equal(branded.height, source.height); assert.equal(branded.orientation, source.orientation);
    assert.match(branded.xmp.toString(), /Genika/); assert.match(branded.xmp.toString(), new RegExp(id.codigo));
  }
});
it('TXT, CSV y formatos sin metadata interna conservan todos sus bytes y procedencia registrada', async () => {
  const bytes = Buffer.from('Empresa,valor\nCliente,100\n');
  const result = await identifyBytes(bytes, identity(bytes), 'csv', limit);
  assert.equal(result.identity.modo, 'registro'); assert.equal(result.identity.origen, 'Genika');
  assert.equal(result.identity.sha256Original, digest(bytes)); assert.deepEqual(result.bytes, bytes);
});
it('un archivo ya en el límite conserva el original si la metadata excede el tamaño verificable', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage();
  const bytes = Buffer.from(await pdf.save());
  const result = await identifyBytes(bytes, identity(bytes), 'pdf', bytes.length);
  assert.equal(result.identity.modo, 'registro'); assert.equal(result.identity.motivo, 'metadata_supera_limite_archivo');
  assert.deepEqual(result.bytes, bytes);
});
