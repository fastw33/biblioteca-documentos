'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const yazl = require('yazl');
const { XMLParser } = require('fast-xml-parser');
const { validateOffice } = require('../src/previews');
const { readZip, digest } = require('../src/identification');

const templateType = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate';
const relation = (type = templateType, target = 'file:///C:/Users/autor/Templates/membrete.dotx', mode = 'External') =>
  `<Relationship Id="rId1" Type="${type}" Target="${target}" TargetMode="${mode}"/>`;
const rels = nodes => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${nodes}</Relationships>`;
const settings = '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:zoom w:percent="100"/><w:attachedTemplate r:id="rId1"/><w:compat><w:compatSetting w:name="compatibilityMode" w:val="15"/></w:compat></w:settings>';
const parts = {
  '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/></w:body></w:document>',
  'word/media/logo.png': Buffer.from([137, 80, 78, 71, 1, 2, 3]),
  'word/settings.xml': settings,
  'word/_rels/settings.xml.rels': rels(relation()),
};
async function zipParts(entries) {
  const zip = new yazl.ZipFile();
  const result = new Promise((resolve, reject) => {
    const chunks = [];
    zip.outputStream.on('data', chunk => chunks.push(chunk));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
  });
  for (const [name, bytes] of entries) zip.addBuffer(Buffer.from(bytes), name);
  zip.end(); return result;
}
const fixture = overrides => zipParts(Object.entries({ ...parts, ...overrides }));
const unsafe = error => error.status === 422;

it('el membrete con plantilla local genera una copia de conversión sin alterar el original ni su diseño', async () => {
  const original = await fixture();
  const hash = digest(original);
  const safe = await validateOffice(original, 'docx');
  const before = await readZip(original, 30 * 1024 * 1024);
  const after = await readZip(safe, 30 * 1024 * 1024);
  assert.equal(digest(original), hash);
  assert.match(before.get('word/_rels/settings.xml.rels').toString(), /file:\/\/\/C:/);
  assert.notDeepEqual(safe, original);
  assert.doesNotMatch(after.get('word/_rels/settings.xml.rels').toString(), /attachedTemplate|file:/);
  assert.doesNotMatch(after.get('word/settings.xml').toString(), /attachedTemplate/);
  const parsed = new XMLParser({ ignoreAttributes: false }).parse(after.get('word/settings.xml').toString());
  assert.equal(parsed['w:settings']['w:zoom']['@_w:percent'], '100');
  assert.equal(parsed['w:settings']['w:compat']['w:compatSetting']['@_w:val'], '15');
  for (const name of ['word/document.xml', 'word/media/logo.png', '[Content_Types].xml'])
    assert.deepEqual(after.get(name), before.get(name));
  assert.deepEqual(await validateOffice(safe, 'docx'), safe);
});
it('desvincula también plantillas HTTPS y relaciones OOXML estrictas sin intentar abrir su destino', async () => {
  for (const type of [templateType, 'http://purl.oclc.org/ooxml/officeDocument/relationships/attachedTemplate']) {
    const bytes = await fixture({ 'word/_rels/settings.xml.rels': rels(relation(type, 'https://example.invalid/membrete.dotx')) });
    const result = await validateOffice(bytes, 'docx');
    const entries = await readZip(result, 30 * 1024 * 1024);
    assert.doesNotMatch(entries.get('word/_rels/settings.xml.rels').toString(), /example\.invalid/);
  }
});
it('un documento sin recursos externos conserva exactamente sus bytes para conversión', async () => {
  const original = await fixture({ 'word/_rels/settings.xml.rels': rels(''), 'word/settings.xml': settings.replace('<w:attachedTemplate r:id="rId1"/>', '') });
  assert.strictEqual(await validateOffice(original, 'docx'), original);
});
it('mantiene el bloqueo de imágenes, enlaces y otros recursos externos junto a una plantilla desvinculable', async () => {
  for (const type of ['image', 'hyperlink', 'oleObject']) {
    const original = await fixture({ 'word/_rels/document.xml.rels': rels(relation(`http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}`, 'https://example.invalid/recurso')) });
    await assert.rejects(validateOffice(original, 'docx'), unsafe);
  }
  const encoded = await fixture({ 'word/_rels/document.xml.rels': rels(relation('image', 'https://example.invalid/image.png', '&#69;xternal')) });
  await assert.rejects(validateOffice(encoded, 'docx'), unsafe);
});
it('no admite la excepción de plantilla en otras partes, formatos ni relaciones de destino ambiguo', async () => {
  await assert.rejects(validateOffice(await fixture({ 'word/_rels/document.xml.rels': rels(relation()) }), 'docx'), unsafe);
  await assert.rejects(validateOffice(await fixture(), 'xlsx'), unsafe);
  await assert.rejects(validateOffice(await fixture({ 'word/_rels/settings.xml.rels': rels(relation('image', 'file:///etc/passwd', 'Internal')) }), 'docx'), unsafe);
  await assert.rejects(validateOffice(await fixture({ 'word/settings.xml': '<settings>' }), 'docx'), unsafe);
});
it('sigue rechazando macros, objetos incrustados, XML con entidades y entradas ZIP duplicadas', async () => {
  for (const name of ['word/vbaProject.bin', 'word/embeddings/object.bin'])
    await assert.rejects(validateOffice(await fixture({ [name]: 'active' }), 'docx'), unsafe);
  await assert.rejects(validateOffice(await fixture({ 'word/_rels/settings.xml.rels': '<!DOCTYPE Relationships [<!ENTITY external "External">]>' + rels(relation()) }), 'docx'), unsafe);
  const duplicate = await zipParts([...Object.entries(parts), ['word/_rels/settings.xml.rels', rels('')]]);
  await assert.rejects(validateOffice(duplicate, 'docx'), unsafe);
});
