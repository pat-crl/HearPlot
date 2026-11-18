// Bounded, separately testable readers for common embedded audio tags.
function readId3Metadata(data) {
  if (data.length < 10 || data.slice(0, 3).toString("latin1") !== "ID3") return {};
  const version = data[3];
  if (version !== 3 && version !== 4) return {};
  const tagSize = readSyncSafeInteger(data, 6);
  const end = Math.min(data.length, 10 + tagSize);
  const metadata = {};
  let offset = 10;
  if (data[5] & 0x40) {
    if (end < 14) return {};
    const extendedSize = version === 4 ? readSyncSafeInteger(data, 10) : data.readUInt32BE(10) + 4;
    if (extendedSize < 4 || 10 + extendedSize > end) return {};
    offset += extendedSize;
  }

  while (offset + 10 <= end) {
    const frameId = data.slice(offset, offset + 4).toString("latin1").replace(/\0/g, "");
    if (!frameId) break;
    const frameSize = version === 4 ? readSyncSafeInteger(data, offset + 4) : data.readUInt32BE(offset + 4);
    const frameStart = offset + 10;
    const frameEnd = Math.min(end, frameStart + frameSize);
    const frame = data.slice(frameStart, frameEnd);

    if (frameId === "TIT2") metadata.title = decodeId3TextFrame(frame);
    if (frameId === "TPE1") metadata.artist = decodeId3TextFrame(frame);
    if (frameId === "TPE2") metadata.albumArtist = decodeId3TextFrame(frame);
    if (frameId === "TALB") metadata.album = decodeId3TextFrame(frame);
    if (frameId === "APIC" && !metadata.artwork) metadata.artwork = decodeId3Artwork(frame);

    offset = frameEnd;
  }

  return cleanMetadata(metadata);
}

function readMp4Metadata(data) {
  const metadata = {};
  walkMp4Atoms(data, 0, data.length, (atom, payloadStart, payloadEnd) => {
    if (atom === "\u00a9nam") metadata.title = readMp4DataText(data, payloadStart, payloadEnd);
    if (atom === "\u00a9ART") metadata.artist = readMp4DataText(data, payloadStart, payloadEnd);
    if (atom === "aART") metadata.albumArtist = readMp4DataText(data, payloadStart, payloadEnd);
    if (atom === "\u00a9alb") metadata.album = readMp4DataText(data, payloadStart, payloadEnd);
    if (atom === "covr" && !metadata.artwork) metadata.artwork = readMp4Artwork(data, payloadStart, payloadEnd);
  });
  return cleanMetadata(metadata);
}

function walkMp4Atoms(data, start, end, visit, depth = 0) {
  if (depth > 32) return;
  const containerAtoms = new Set(["moov", "udta", "ilst", "trak", "mdia", "minf", "stbl"]);
  let offset = start;

  while (offset + 8 <= end) {
    let size = data.readUInt32BE(offset);
    const atom = data.slice(offset + 4, offset + 8).toString("latin1");
    let headerSize = 8;
    if (size === 1 && offset + 16 <= end) {
      size = Number(data.readBigUInt64BE(offset + 8));
      headerSize = 16;
    }
    if (size === 0) size = end - offset;
    if (!Number.isSafeInteger(size) || size < headerSize || offset + size > end) break;

    let payloadStart = offset + headerSize;
    const payloadEnd = offset + size;
    visit(atom, payloadStart, payloadEnd);

    if (atom === "meta") payloadStart += 4; // version and flags sit before child atoms.
    if (containerAtoms.has(atom) || atom === "meta") walkMp4Atoms(data, payloadStart, payloadEnd, visit, depth + 1);
    offset += size;
  }
}

function readMp4DataText(data, start, end) {
  const payload = findMp4DataPayload(data, start, end);
  return payload ? data.slice(payload.start, payload.end).toString("utf8").replace(/\0/g, "").trim() : "";
}

function readMp4Artwork(data, start, end) {
  const payload = findMp4DataPayload(data, start, end);
  if (!payload) return "";
  const mime = payload.type === 14 ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${data.slice(payload.start, payload.end).toString("base64")}`;
}

function findMp4DataPayload(data, start, end) {
  let offset = start;
  while (offset + 16 <= end) {
    const size = data.readUInt32BE(offset);
    const atom = data.slice(offset + 4, offset + 8).toString("latin1");
    if (size < 16 || offset + size > end) break;
    if (atom === "data") {
      return {
        type: data.readUInt32BE(offset + 8) & 0xff,
        start: offset + 16,
        end: offset + size,
      };
    }
    offset += size;
  }
  return null;
}

function readSyncSafeInteger(data, offset) {
  return ((data[offset] & 0x7f) << 21) | ((data[offset + 1] & 0x7f) << 14) | ((data[offset + 2] & 0x7f) << 7) | (data[offset + 3] & 0x7f);
}

function decodeId3TextFrame(frame) {
  if (!frame.length) return "";
  return decodeId3Text(frame.slice(1), frame[0]);
}

function decodeId3Text(bytes, encoding) {
  if (encoding === 1 || encoding === 2) {
    const littleEndian = encoding === 1 ? !(bytes[0] === 0xfe && bytes[1] === 0xff) : false;
    const start = encoding === 1 && (bytes[0] === 0xff || bytes[0] === 0xfe) ? 2 : 0;
    const swapped = Buffer.alloc(Math.max(0, bytes.length - start));
    for (let index = start; index + 1 < bytes.length; index += 2) {
      const target = index - start;
      swapped[target] = littleEndian ? bytes[index] : bytes[index + 1];
      swapped[target + 1] = littleEndian ? bytes[index + 1] : bytes[index];
    }
    return swapped.toString("utf16le").replace(/\0/g, "").trim();
  }
  return bytes.toString(encoding === 3 ? "utf8" : "latin1").replace(/\0/g, "").trim();
}

function decodeId3Artwork(frame) {
  if (!frame.length) return "";
  const encoding = frame[0];
  let offset = 1;
  const mimeEnd = frame.indexOf(0, offset);
  if (mimeEnd === -1) return "";
  const mime = frame.slice(offset, mimeEnd).toString("latin1").toLowerCase() || "image/jpeg";
  if (!["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mime)) return "";
  offset = mimeEnd + 2; // skip MIME terminator and picture type byte.
  const terminatorLength = encoding === 0 || encoding === 3 ? 1 : 2;
  while (offset + terminatorLength < frame.length) {
    const ended = terminatorLength === 1
      ? frame[offset] === 0
      : frame[offset] === 0 && frame[offset + 1] === 0;
    offset += terminatorLength;
    if (ended) break;
  }
  return `data:${mime};base64,${frame.slice(offset).toString("base64")}`;
}

function cleanMetadata(metadata) {
  return Object.fromEntries(Object.entries(metadata).filter(([, value]) => Boolean(value)));
}

module.exports = { readId3Metadata, readMp4Metadata };
