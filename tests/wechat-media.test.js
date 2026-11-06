'use strict';

const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
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
} = require('../src/wechat-media');

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('detects supported image headers and rejects unknown or short content', () => {
  const cases = [
    [Buffer.from('ffd8ff', 'hex'), '.jpg', 'image/jpeg'],
    [Buffer.from('89504e470d0a1a0a', 'hex'), '.png', 'image/png'],
    [Buffer.from('GIF87a'), '.gif', 'image/gif'],
    [Buffer.from('GIF89a'), '.gif', 'image/gif'],
    [Buffer.from('RIFF0000WEBP'), '.webp', 'image/webp'],
  ];
  for (const [header, extension, mimeType] of cases) {
    assert.deepEqual(detectImageType(header), { extension, mimeType });
  }
  assert.equal(detectImageType(Buffer.from('unknown content')), null);
  for (const header of [Buffer.alloc(0), Buffer.from([0xff]), Buffer.from([0xff, 0xd8])]) {
    assert.equal(detectImageType(header), null);
  }
});

test('rejects missing CDN references and empty images, filters image items, and removes files', async (t) => {
  const directory = temporaryDirectory(t);
  let fetchCalls = 0;
  await assert.rejects(
    downloadInboundImage({
      imageItem: { media: {} },
      destinationDirectory: directory,
      cdnBaseUrl: 'https://cdn.example',
      fetchImpl: async () => { fetchCalls += 1; },
    }),
    { message: 'WeChat image has no CDN reference' },
  );
  assert.equal(fetchCalls, 0);

  const emptyFilePath = path.join(directory, 'empty.png');
  fs.writeFileSync(emptyFilePath, Buffer.alloc(0));
  await assert.rejects(
    uploadOutboundImage({ filePath: emptyFilePath }),
    { message: 'image must be between 1 and 26214400 bytes' },
  );

  const image = { type: 2, image_item: { media: {} } };
  assert.deepEqual(extractImageItems({
    item_list: [null, { type: 1, image_item: {} }, { type: '2', image_item: {} },
      { type: 2 }, { type: 2, image_item: null }, image],
  }), [image]);

  const missingFilePath = path.join(directory, 'missing.png');
  assert.doesNotThrow(() => removeFiles([emptyFilePath, missingFilePath]));
  assert.equal(fs.existsSync(emptyFilePath), false);
  assert.equal(fs.existsSync(missingFilePath), false);
});

test('does not retry HTTP 400 uploads and retries HTTP 500 uploads three times', async (t) => {
  const directory = temporaryDirectory(t);
  const filePath = path.join(directory, 'pixel.png');
  fs.writeFileSync(filePath, ONE_PIXEL_PNG);

  for (const [status, expectedCalls] of [[400, 1], [500, 3]]) {
    let fetchCalls = 0;
    await assert.rejects(
      uploadOutboundImage({
        account: { token: 'unused' },
        toUserId: 'owner',
        filePath,
        apiPost: async () => ({ upload_full_url: 'https://cdn.example/upload' }),
        cdnBaseUrl: 'https://cdn.example',
        channelVersion: '0.1.0',
        fetchImpl: async () => {
          fetchCalls += 1;
          return new Response('', { status });
        },
      }),
      { message: `WeChat CDN upload failed: HTTP ${status}` },
    );
    assert.equal(fetchCalls, expectedCalls);
  }
});

test('rejects a base64 AES key containing five bytes', () => {
  assert.throws(
    () => parseAesKey(Buffer.from([1, 2, 3, 4, 5]).toString('base64')),
    /invalid WeChat media AES key length: 5/,
  );
});

test('downloads an inbound JPEG using an encoded CDN query parameter', async (t) => {
  const directory = temporaryDirectory(t);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0xff, 0xd9]);
  let capturedUrl;
  const result = await downloadInboundImage({
    imageItem: { media: { encrypt_query_param: 'abc/def?x=1' } },
    destinationDirectory: directory,
    cdnBaseUrl: 'https://cdn.example.com/',
    fetchImpl: async (url) => {
      capturedUrl = url;
      return new Response(jpeg, { status: 200 });
    },
  });
  assert.equal(capturedUrl, 'https://cdn.example.com/download?encrypted_query_param=abc%2Fdef%3Fx%3D1');
  assert.equal(result.extension, '.jpg');
  assert.equal(result.mimeType, 'image/jpeg');
  assert.equal(result.size, 7);
  assert.deepEqual(fs.readFileSync(result.filePath), jpeg);
});

test('AES-128-ECB round trip and padded size match', () => {
  const key = crypto.randomBytes(16);
  const encrypted = encryptAesEcb(ONE_PIXEL_PNG, key);
  assert.equal(encrypted.length, aesEcbPaddedSize(ONE_PIXEL_PNG.length));
  assert.deepEqual(decryptAesEcb(encrypted, key), ONE_PIXEL_PNG);
});

test('accepts both raw and hex-string base64 AES keys', () => {
  const key = crypto.randomBytes(16);
  assert.deepEqual(parseAesKey(key.toString('base64')), key);
  assert.deepEqual(parseAesKey(Buffer.from(key.toString('hex')).toString('base64')), key);
});

test('downloads, decrypts, validates, and stores an inbound image', async (t) => {
  const directory = temporaryDirectory(t);
  const key = crypto.randomBytes(16);
  const encrypted = encryptAesEcb(ONE_PIXEL_PNG, key);
  const result = await downloadInboundImage({
    imageItem: {
      media: {
        full_url: 'https://cdn.example/image',
        aes_key: key.toString('base64'),
      },
    },
    destinationDirectory: directory,
    cdnBaseUrl: 'https://cdn.example',
    fetchImpl: async () => new Response(encrypted, { status: 200 }),
  });
  assert.equal(result.mimeType, 'image/png');
  assert.deepEqual(fs.readFileSync(result.filePath), ONE_PIXEL_PNG);
});

test('builds an encoded CDN upload URL when upload_full_url is empty', async (t) => {
  const directory = temporaryDirectory(t);
  const filePath = path.join(directory, 'pixel.png');
  fs.writeFileSync(filePath, Buffer.from('89504e470d0a1a0a', 'hex'));
  let capturedUrl;
  const uploaded = await uploadOutboundImage({
    account: { token: 'unused' },
    toUserId: 'owner',
    filePath,
    apiPost: async () => ({ upload_param: 'a b&c', upload_full_url: '' }),
    cdnBaseUrl: 'https://cdn.example.com/',
    channelVersion: '0.1.0',
    fetchImpl: async (url) => {
      capturedUrl = url;
      return new Response('', {
        status: 200,
        headers: { 'x-encrypted-param': 'dl123' },
      });
    },
  });
  assert.equal(
    capturedUrl,
    'https://cdn.example.com/upload?encrypted_query_param=a%20b%26c&filekey=' + uploaded.filekey,
  );
});

test('uploads an encrypted image and builds a native image item', async (t) => {
  const directory = temporaryDirectory(t);
  const filePath = path.join(directory, 'pixel.png');
  fs.writeFileSync(filePath, ONE_PIXEL_PNG);
  let uploadRequest;
  const uploaded = await uploadOutboundImage({
    account: { token: 'unused' },
    toUserId: 'owner',
    filePath,
    apiPost: async (_account, endpoint, body) => {
      assert.equal(endpoint, 'ilink/bot/getuploadurl');
      uploadRequest = body;
      return { upload_full_url: 'https://cdn.example/upload' };
    },
    cdnBaseUrl: 'https://cdn.example',
    channelVersion: '0.1.0',
    fetchImpl: async (_url, options) => {
      assert.equal(options.method, 'POST');
      assert.equal(options.body.byteLength, uploadRequest.filesize);
      return new Response('', {
        status: 200,
        headers: { 'x-encrypted-param': 'download-token' },
      });
    },
  });
  const item = buildImageMessageItem(uploaded);
  assert.equal(item.type, 2);
  assert.equal(item.image_item.media.encrypt_query_param, 'download-token');
  assert.equal(item.image_item.mid_size, uploadRequest.filesize);
});
