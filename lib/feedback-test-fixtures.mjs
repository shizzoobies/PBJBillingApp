import { crc32 } from 'node:zlib'

// Tiny stored ZIP fixtures, not an application parser. Allows exact hostile
// entry names and declared sizes without adding a production dependency.
export function fixtureZip(entries) {
  const locals = [], central = []
  let offset = 0
  for (const [name, value] of entries) {
    const filename = Buffer.from(name), bytes = Buffer.from(value)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4)
    header.writeUInt32LE(crc32(bytes), 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26)
    locals.push(header, filename, bytes)
    const index = Buffer.alloc(46)
    index.writeUInt32LE(0x02014b50); index.writeUInt16LE(20, 4); index.writeUInt16LE(20, 6)
    index.writeUInt32LE(crc32(bytes), 16); index.writeUInt32LE(bytes.length, 20); index.writeUInt32LE(bytes.length, 24)
    index.writeUInt16LE(filename.length, 28); index.writeUInt32LE(offset, 42)
    central.push(index, filename); offset += header.length + filename.length + bytes.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}
export function officeEntries(extension) {
  const [main, root, namespace, contentType] = {
    docx: ['word/document.xml', 'document', 'wordprocessingml', 'wordprocessingml.document'],
    xlsx: ['xl/workbook.xml', 'workbook', 'spreadsheetml', 'spreadsheetml.sheet'],
    pptx: ['ppt/presentation.xml', 'presentation', 'presentationml', 'presentationml.presentation'],
  }[extension]
  return [
    ['[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/${main}" ContentType="application/vnd.openxmlformats-officedocument.${contentType}.main+xml"/></Types>`],
    ['_rels/.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${main}"/></Relationships>`],
    [main, `<x:${root} xmlns:x="http://schemas.openxmlformats.org/${namespace}/2006/main"></x:${root}>`],
  ]
}
