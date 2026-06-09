export interface ZipEntryInput {
  filename: string;
  data: Uint8Array;
  modifiedAt?: string | Date | null;
}

interface PreparedZipEntry {
  nameBytes: Buffer;
  data: Buffer;
  crc32: number;
  dosTime: number;
  dosDate: number;
  localHeaderOffset: number;
}

const UTF8_FLAG = 0x0800;
const STORE_METHOD = 0;
const VERSION_NEEDED = 20;

const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i += 1) {
  let value = i;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC32_TABLE[i] = value >>> 0;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(input: string | Date | null | undefined): {
  dosDate: number;
  dosTime: number;
} {
  const date = input ? new Date(input) : new Date();
  const safeDate = Number.isFinite(date.getTime()) ? date : new Date();
  const year = Math.max(1980, Math.min(2107, safeDate.getFullYear()));
  const month = safeDate.getMonth() + 1;
  const day = safeDate.getDate();
  const hours = safeDate.getHours();
  const minutes = safeDate.getMinutes();
  const seconds = Math.floor(safeDate.getSeconds() / 2);

  return {
    dosDate: ((year - 1980) << 9) | (month << 5) | day,
    dosTime: (hours << 11) | (minutes << 5) | seconds,
  };
}

function writeLocalHeader(entry: PreparedZipEntry): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(VERSION_NEEDED, 4);
  header.writeUInt16LE(UTF8_FLAG, 6);
  header.writeUInt16LE(STORE_METHOD, 8);
  header.writeUInt16LE(entry.dosTime, 10);
  header.writeUInt16LE(entry.dosDate, 12);
  header.writeUInt32LE(entry.crc32, 14);
  header.writeUInt32LE(entry.data.length, 18);
  header.writeUInt32LE(entry.data.length, 22);
  header.writeUInt16LE(entry.nameBytes.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, entry.nameBytes]);
}

function writeCentralDirectoryHeader(entry: PreparedZipEntry): Buffer {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(VERSION_NEEDED, 4);
  header.writeUInt16LE(VERSION_NEEDED, 6);
  header.writeUInt16LE(UTF8_FLAG, 8);
  header.writeUInt16LE(STORE_METHOD, 10);
  header.writeUInt16LE(entry.dosTime, 12);
  header.writeUInt16LE(entry.dosDate, 14);
  header.writeUInt32LE(entry.crc32, 16);
  header.writeUInt32LE(entry.data.length, 20);
  header.writeUInt32LE(entry.data.length, 24);
  header.writeUInt16LE(entry.nameBytes.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(entry.localHeaderOffset, 42);
  return Buffer.concat([header, entry.nameBytes]);
}

function writeEndOfCentralDirectory(
  entryCount: number,
  centralSize: number,
  centralOffset: number
): Buffer {
  const footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50, 0);
  footer.writeUInt16LE(0, 4);
  footer.writeUInt16LE(0, 6);
  footer.writeUInt16LE(entryCount, 8);
  footer.writeUInt16LE(entryCount, 10);
  footer.writeUInt32LE(centralSize, 12);
  footer.writeUInt32LE(centralOffset, 16);
  footer.writeUInt16LE(0, 20);
  return footer;
}

function assertZip32Limit(value: number, label: string): void {
  if (value > 0xffffffff) {
    throw new Error(`ZIP archive ${label} exceeds ZIP32 size limits`);
  }
}

export function createStoredZip(entries: ZipEntryInput[]): Buffer {
  if (entries.length > 0xffff) {
    throw new Error('ZIP archive has too many entries for ZIP32');
  }

  const localParts: Buffer[] = [];
  const preparedEntries: PreparedZipEntry[] = [];
  let offset = 0;

  for (const input of entries) {
    const data = Buffer.from(input.data);
    assertZip32Limit(data.length, `entry ${input.filename}`);
    const { dosDate, dosTime } = dosDateTime(input.modifiedAt);
    const entry: PreparedZipEntry = {
      nameBytes: Buffer.from(input.filename, 'utf8'),
      data,
      crc32: crc32(data),
      dosTime,
      dosDate,
      localHeaderOffset: offset,
    };
    const localHeader = writeLocalHeader(entry);
    const nextOffset = offset + localHeader.length + data.length;
    assertZip32Limit(nextOffset, 'local data');
    localParts.push(localHeader, data);
    preparedEntries.push(entry);
    offset = nextOffset;
  }

  const centralParts = preparedEntries.map(writeCentralDirectoryHeader);
  const centralDirectory = Buffer.concat(centralParts);
  assertZip32Limit(centralDirectory.length, 'central directory');
  const footer = writeEndOfCentralDirectory(
    preparedEntries.length,
    centralDirectory.length,
    offset
  );
  const totalSize = offset + centralDirectory.length + footer.length;
  assertZip32Limit(totalSize, 'total size');

  return Buffer.concat([...localParts, centralDirectory, footer], totalSize);
}
