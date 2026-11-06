'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_知识库GE_BYTES = 25 * 1024 * 1024;

function encryptAesEcb(plaintext, key) {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function decryptAesEcb(ciphertext, key) {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function aesEcbPaddedSize(plaintextSize) {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

function parseAesKey(value) {
  if (!value) return null;
  const decoded = Buffer.from(String(value), 'base64');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-f]{32}$/i.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex');
  }
  throw new Error(`invalid WeChat media AES key length: ${decoded.length}`);
}

function detectImageType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: '.jpg', mimeType: 'image/jpeg' };
  }
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    return { extension: '.png', mimeType: 'image/png' };
  }
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) {
    return { extension: '.gif', mimeType: 'image/gif' };
  }
  if (
    buffer.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { extension: '.webp', mimeType: 'image/webp' };
  }
  return null;
}

function buildCdnDownloadUrl(cdnBaseUrl, encryptedQueryParam) {
  return `${cdnBaseUrl.replace(/\/$/, '')}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

function buildCdnUploadUrl(cdnBaseUrl, uploadParam, filekey) {
  return `${cdnBaseUrl.replace(/\/$/, '')}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

async function responseBuffer(response, maxBytes) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error(`WeChat image exceeds ${maxBytes} bytes`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw new Error(`WeChat image exceeds ${maxBytes} bytes`);
  return buffer;
}

async function downloadInboundImage(params) {
  const {
    imageItem,
    destinationDirectory,
    cdnBaseUrl,
    fetchImpl = fetch,
    maxBytes = DEFAULT_MAX_知识库GE_BYTES,
  } = params;
  const media = imageItem?.media;
  if (!media || (!media.full_url && !media.encrypt_query_param)) {
    throw new Error('WeChat image has no CDN reference');
  }
  const url = media.full_url || buildCdnDownloadUrl(cdnBaseUrl, media.encrypt_query_param);
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`WeChat CDN download failed: HTTP ${response.status}`);
  const downloaded = await responseBuffer(response, maxBytes + 16);

  let plaintext = downloaded;
  const key = imageItem.aeskey
    ? Buffer.from(String(imageItem.aeskey), 'hex')
    : parseAesKey(media.aes_key);
  if (key) plaintext = decryptAesEcb(downloaded, key);
  if (plaintext.length > maxBytes) throw new Error(`WeChat image exceeds ${maxBytes} bytes`);

  const imageType = detectImageType(plaintext);
  if (!imageType) throw new Error('WeChat media is not a supported JPEG, PNG, GIF, or WebP image');
  fs.mkdirSync(destinationDirectory, { recursive: true, mode: 0o700 });
  const filePath = path.join(
    destinationDirectory,
    `wechat-in-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${imageType.extension}`,
  );
  fs.writeFileSync(filePath, plaintext, { mode: 0o600 });
  return { filePath, ...imageType, size: plaintext.length };
}

async function uploadEncryptedBuffer(params) {
  const {
    plaintext,
    aesKey,
    uploadFullUrl,
    uploadParam,
    filekey,
    cdnBaseUrl,
    fetchImpl = fetch,
  } = params;
  if (!uploadFullUrl && !uploadParam) throw new Error('WeChat upload URL is missing');
  const url = uploadFullUrl || buildCdnUploadUrl(cdnBaseUrl, uploadParam, filekey);
  const ciphertext = encryptAesEcb(plaintext, aesKey);
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(ciphertext),
      });
      if (!response.ok) throw new Error(`WeChat CDN upload failed: HTTP ${response.status}`);
      const downloadParam = response.headers.get('x-encrypted-param');
      if (!downloadParam) throw new Error('WeChat CDN response is missing x-encrypted-param');
      return { downloadParam, ciphertextSize: ciphertext.length };
    } catch (error) {
      lastError = error;
      if (/HTTP 4\d\d/.test(String(error))) break;
    }
  }
  throw lastError || new Error('WeChat CDN upload failed');
}

async function uploadOutboundImage(params) {
  const {
    account,
    toUserId,
    filePath,
    apiPost,
    cdnBaseUrl,
    fetchImpl = fetch,
    maxBytes = DEFAULT_MAX_知识库GE_BYTES,
    channelVersion,
  } = params;
  const plaintext = fs.readFileSync(filePath);
  if (!plaintext.length || plaintext.length > maxBytes) {
    throw new Error(`image must be between 1 and ${maxBytes} bytes`);
  }
  const imageType = detectImageType(plaintext);
  if (!imageType) throw new Error('only JPEG, PNG, GIF, and WebP images can be sent');

  const aesKey = crypto.randomBytes(16);
  const aesKeyHex = aesKey.toString('hex');
  const filekey = crypto.randomBytes(16).toString('hex');
  const uploadInfo = await apiPost(account, 'ilink/bot/getuploadurl', {
    filekey,
    media_type: 1,
    to_user_id: toUserId,
    rawsize: plaintext.length,
    rawfilemd5: crypto.createHash('md5').update(plaintext).digest('hex'),
    filesize: aesEcbPaddedSize(plaintext.length),
    no_need_thumb: true,
    aeskey: aesKeyHex,
    base_info: { channel_version: channelVersion },
  }, 15000);
  const uploaded = await uploadEncryptedBuffer({
    plaintext,
    aesKey,
    uploadFullUrl: uploadInfo.upload_full_url?.trim(),
    uploadParam: uploadInfo.upload_param,
    filekey,
    cdnBaseUrl,
    fetchImpl,
  });
  return {
    aesKeyHex,
    downloadParam: uploaded.downloadParam,
    ciphertextSize: uploaded.ciphertextSize,
    filekey,
    imageType,
  };
}

function buildImageMessageItem(uploaded) {
  return {
    type: 2,
    image_item: {
      media: {
        encrypt_query_param: uploaded.downloadParam,
        aes_key: Buffer.from(uploaded.aesKeyHex, 'ascii').toString('base64'),
        encrypt_type: 1,
      },
      mid_size: uploaded.ciphertextSize,
    },
  };
}

function extractImageItems(message) {
  return (message?.item_list || []).filter((item) => item?.type === 2 && item.image_item);
}

function removeFiles(filePaths) {
  for (const filePath of filePaths || []) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {}
  }
}

module.exports = {
  DEFAULT_MAX_知识库GE_BYTES,
  aesEcbPaddedSize,
  buildImageMessageItem,
  decryptAesEcb,
  detectImageType,
  downloadInboundImage,
  encryptAesEcb,
  extractImageItems,
  parseAesKey,
  removeFiles,
  uploadOutboundImage,
};
