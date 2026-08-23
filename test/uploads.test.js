'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  inspectVideoBuffer,
  parseFrameRate,
  validateVideoProbe
} = require('../lib/uploads');

const LIMITS = {
  maxVideoDimension: 4096,
  maxVideoPixels: 16 * 1024 * 1024,
  maxVideoDurationMs: 300000,
  maxVideoFrameRate: 120
};

function probe(format, videoCodec, audioCodec = '') {
  return {
    format: { format_name: format, duration: '1.25' },
    streams: [
      {
        codec_type: 'video',
        codec_name: videoCodec,
        width: 640,
        height: 360,
        avg_frame_rate: '30000/1001'
      },
      ...(audioCodec ? [{ codec_type: 'audio', codec_name: audioCodec }] : [])
    ]
  };
}

test('recognizes MP4 and WebM signatures without trusting extensions', () => {
  const mp4 = Buffer.alloc(32);
  mp4.writeUInt32BE(24, 0);
  mp4.write('ftyp', 4, 'ascii');
  assert.deepEqual(inspectVideoBuffer(mp4), {
    mime: 'video/mp4',
    extensions: ['.mp4'],
    kind: 'video'
  });

  const webm = Buffer.concat([
    Buffer.from('1a45dfa3', 'hex'),
    Buffer.from([0x9f, 0x42, 0x82, 0x84]),
    Buffer.from('webm', 'ascii'),
    Buffer.alloc(20)
  ]);
  assert.deepEqual(inspectVideoBuffer(webm), {
    mime: 'video/webm',
    extensions: ['.webm'],
    kind: 'video'
  });
  assert.equal(inspectVideoBuffer(Buffer.from('not media')), null);
});

test('accepts only browser-compatible constrained video probe results', () => {
  assert.deepEqual(validateVideoProbe(probe('matroska,webm', 'vp9', 'opus'), '.webm', LIMITS), {
    width: 640,
    height: 360,
    durationMs: 1250,
    frameRate: 29.97,
    videoCodec: 'vp9',
    audioCodec: 'opus'
  });
  assert.equal(validateVideoProbe(probe('mov,mp4,m4a,3gp,3g2,mj2', 'h264', 'aac'), '.mp4', LIMITS).videoCodec, 'h264');

  assert.throws(
    () => validateVideoProbe(probe('mov,mp4', 'vp9'), '.mp4', LIMITS),
    /not browser-compatible/
  );
  const tooLong = probe('matroska,webm', 'vp8');
  tooLong.format.duration = '301';
  assert.throws(() => validateVideoProbe(tooLong, '.webm', LIMITS), /duration/);
  const attachment = probe('matroska,webm', 'vp8');
  attachment.streams.push({ codec_type: 'attachment', codec_name: 'unknown' });
  assert.throws(() => validateVideoProbe(attachment, '.webm', LIMITS), /one video stream/);
  assert.ok(Math.abs(parseFrameRate('120000/1001') - (120000 / 1001)) < 1e-9);
  assert.equal(parseFrameRate('1/0'), 0);
});
