/* WALLEX password KDFs — local-only, no network or external dependencies. */
(() => {
  'use strict';

  const encoder = new TextEncoder();
  const VALID_DK_LENGTHS = new Set([16, 20, 24, 28, 32, 64]);
  const MAX_SCRYPT_MEMORY = 320 * 1024 * 1024;
  const SCRYPT_YIELD_INTERVAL = 1024;

  function assertPositiveInteger(value, name) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  }

  function assertDerivationLength(value) {
    if (!VALID_DK_LENGTHS.has(value)) throw new Error('Invalid BIP39 entropy length.');
  }

  function encodeText(value, name) {
    if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is required.`);
    return encoder.encode(value);
  }

  function bytesToLowerHex(bytes) {
    let hex = '';
    for (let index = 0; index < bytes.length; index += 1) hex += bytes[index].toString(16).padStart(2, '0');
    return hex;
  }

  function zero(bytes) {
    if (ArrayBuffer.isView(bytes) && typeof bytes.fill === 'function') bytes.fill(0);
  }

  async function pbkdf2Bytes(password, salt, iterations, hash, dkLen) {
    assertPositiveInteger(iterations, 'PBKDF2 iterations');
    assertPositiveInteger(dkLen, 'PBKDF2 output length');
    if (hash !== 'SHA-256' && hash !== 'SHA-512') throw new Error('Unsupported PBKDF2 hash.');
    if (!globalThis.crypto?.subtle) throw new Error('Web Crypto PBKDF2 is unavailable in this browser.');

    const key = await globalThis.crypto.subtle.importKey('raw', password, 'PBKDF2', false, ['deriveBits']);
    const bits = await globalThis.crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations, hash }, key, dkLen * 8
    );
    return new Uint8Array(bits);
  }

  function rotl32(value, count) {
    return ((value << count) | (value >>> (32 - count))) >>> 0;
  }

  function salsa20_8_into(input, output, original, working) {
    original.set(input.subarray(0, 16));
    working.set(original);

    for (let round = 0; round < 4; round += 1) {
      working[4] ^= rotl32((working[0] + working[12]) >>> 0, 7); working[8] ^= rotl32((working[4] + working[0]) >>> 0, 9); working[12] ^= rotl32((working[8] + working[4]) >>> 0, 13); working[0] ^= rotl32((working[12] + working[8]) >>> 0, 18);
      working[9] ^= rotl32((working[5] + working[1]) >>> 0, 7); working[13] ^= rotl32((working[9] + working[5]) >>> 0, 9); working[1] ^= rotl32((working[13] + working[9]) >>> 0, 13); working[5] ^= rotl32((working[1] + working[13]) >>> 0, 18);
      working[14] ^= rotl32((working[10] + working[6]) >>> 0, 7); working[2] ^= rotl32((working[14] + working[10]) >>> 0, 9); working[6] ^= rotl32((working[2] + working[14]) >>> 0, 13); working[10] ^= rotl32((working[6] + working[2]) >>> 0, 18);
      working[3] ^= rotl32((working[15] + working[11]) >>> 0, 7); working[7] ^= rotl32((working[3] + working[15]) >>> 0, 9); working[11] ^= rotl32((working[7] + working[3]) >>> 0, 13); working[15] ^= rotl32((working[11] + working[7]) >>> 0, 18);
      working[1] ^= rotl32((working[0] + working[3]) >>> 0, 7); working[2] ^= rotl32((working[1] + working[0]) >>> 0, 9); working[3] ^= rotl32((working[2] + working[1]) >>> 0, 13); working[0] ^= rotl32((working[3] + working[2]) >>> 0, 18);
      working[6] ^= rotl32((working[5] + working[4]) >>> 0, 7); working[7] ^= rotl32((working[6] + working[5]) >>> 0, 9); working[4] ^= rotl32((working[7] + working[6]) >>> 0, 13); working[5] ^= rotl32((working[4] + working[7]) >>> 0, 18);
      working[11] ^= rotl32((working[10] + working[9]) >>> 0, 7); working[8] ^= rotl32((working[11] + working[10]) >>> 0, 9); working[9] ^= rotl32((working[8] + working[11]) >>> 0, 13); working[10] ^= rotl32((working[9] + working[8]) >>> 0, 18);
      working[12] ^= rotl32((working[15] + working[14]) >>> 0, 7); working[13] ^= rotl32((working[12] + working[15]) >>> 0, 9); working[14] ^= rotl32((working[13] + working[12]) >>> 0, 13); working[15] ^= rotl32((working[14] + working[13]) >>> 0, 18);
    }

    for (let index = 0; index < 16; index += 1) output[index] = (working[index] + original[index]) >>> 0;
  }

  function xorInto(destination, source) {
    for (let index = 0; index < destination.length; index += 1) destination[index] ^= source[index];
  }

  function blockMixInto(input, output, r, workspace) {
    const blockCount = r * 2;
    const x = workspace.x;
    const y = workspace.y;
    x.set(input.subarray((blockCount - 1) * 16, blockCount * 16));
    for (let index = 0; index < blockCount; index += 1) {
      xorInto(x, input.subarray(index * 16, (index + 1) * 16));
      salsa20_8_into(x, x, workspace.original, workspace.working);
      y.set(x, index * 16);
    }
    for (let index = 0; index < r; index += 1) {
      output.set(y.subarray(index * 32, index * 32 + 16), index * 16);
      output.set(y.subarray(index * 32 + 16, index * 32 + 32), (r + index) * 16);
    }
  }

  function integerifyLow32(block, r) {
    return block[(2 * r - 1) * 16];
  }

  function nextEventLoopTurn() {
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  async function romix(input, N, r, onProgress) {
    const blockBytes = 128 * r;
    const blockWords = blockBytes / 4;
    let memory = null;
    let current = new Uint32Array(blockWords);
    let next = new Uint32Array(blockWords);
    const workspace = {
      x: new Uint32Array(16),
      y: new Uint32Array(blockWords),
      original: new Uint32Array(16),
      working: new Uint32Array(16)
    };
    current.set(new Uint32Array(input.buffer, input.byteOffset, blockWords));

    try {
      memory = new Uint32Array((N * blockBytes) / 4);
      for (let index = 0; index < N; index += 1) {
        memory.set(current, index * blockWords);
        blockMixInto(current, next, r, workspace);
        const swap = current; current = next; next = swap;
        if ((index + 1) % SCRYPT_YIELD_INTERVAL === 0) {
          onProgress?.(index + 1);
          await nextEventLoopTurn();
        }
      }
      for (let index = 0; index < N; index += 1) {
        const memoryIndex = integerifyLow32(current, r) & (N - 1);
        xorInto(current, memory.subarray(memoryIndex * blockWords, (memoryIndex + 1) * blockWords));
        blockMixInto(current, next, r, workspace);
        const swap = current; current = next; next = swap;
        if ((index + 1) % SCRYPT_YIELD_INTERVAL === 0) {
          onProgress?.(N + index + 1);
          await nextEventLoopTurn();
        }
      }
      onProgress?.(N * 2);
      const result = current;
      current = null;
      return result;
    } finally {
      zero(memory); zero(current); zero(next); zero(workspace.x); zero(workspace.y);
      workspace.original.fill(0); workspace.working.fill(0);
    }
  }

  function validateScryptParameters(N, r, p, dkLen) {
    if (!Number.isSafeInteger(N) || N < 2 || (N & (N - 1)) !== 0) throw new Error('scrypt N must be a power of two greater than one.');
    assertPositiveInteger(r, 'scrypt r');
    assertPositiveInteger(p, 'scrypt p');
    assertDerivationLength(dkLen);
    const memoryBytes = N * 128 * r;
    if (!Number.isSafeInteger(memoryBytes) || memoryBytes > MAX_SCRYPT_MEMORY) throw new Error('scrypt memory limit exceeded.');
    if (r * p >= 0x40000000) throw new Error('Invalid scrypt r × p value.');
  }

  async function scryptBytes(password, salt, N, r, p, dkLen, onProgress) {
    validateScryptParameters(N, r, p, dkLen);
    const blockBytes = 128 * r;
    let blocks = await pbkdf2Bytes(password, salt, 1, 'SHA-256', p * blockBytes);
    try {
      onProgress?.(0);
      for (let index = 0; index < p; index += 1) {
        const progressBase = index * N * 2;
        const progressTotal = p * N * 2;
        const mixed = await romix(
          blocks.subarray(index * blockBytes, (index + 1) * blockBytes),
          N,
          r,
          completed => onProgress?.((progressBase + completed) / progressTotal)
        );
        try {
          blocks.set(new Uint8Array(mixed.buffer, mixed.byteOffset, mixed.byteLength), index * blockBytes);
        } finally { zero(mixed); }
      }
      const result = await pbkdf2Bytes(password, blocks, 1, 'SHA-256', dkLen);
      onProgress?.(1);
      return result;
    } finally {
      zero(blocks);
    }
  }

  async function deriveEntropy(options) {
    if (!options || typeof options !== 'object') throw new Error('KDF options are required.');
    const algorithm = options.algorithm;
    const dkLen = Number(options.kdlen);
    const primary = options.primarySecret;
    const additional = typeof options.additionalSecret === 'string' ? options.additionalSecret : '';
    const saltText = additional === '' ? primary : additional;
    const onProgress = typeof options.onProgress === 'function'
      ? value => options.onProgress(Math.max(0, Math.min(1, Number(value) || 0)))
      : null;
    let password = null;
    let salt = null;
    let derived = null;

    try {
      password = encodeText(primary, 'Primary secret');
      salt = encodeText(saltText, 'Salt');
      assertDerivationLength(dkLen);
      if (algorithm === 'scrypt') {
        derived = await scryptBytes(password, salt, Number(options.n), Number(options.r), Number(options.p), dkLen, onProgress);
      } else if (algorithm === 'pbkdf2') {
        const hash = options.prf === 'hmac-sha-256' ? 'SHA-256' : options.prf === 'hmac-sha-512' ? 'SHA-512' : null;
        if (!hash) throw new Error('Unsupported PBKDF2 PRF.');
        onProgress?.(0);
        derived = await pbkdf2Bytes(password, salt, Number(options.iterations), hash, dkLen);
        onProgress?.(1);
      } else {
        throw new Error('Unsupported KDF algorithm.');
      }
      return bytesToLowerHex(derived);
    } finally {
      zero(password); zero(salt); zero(derived);
    }
  }

  async function deriveScryptBytes(password, salt, options = {}) {
    return scryptBytes(password, salt, Number(options.n), Number(options.r), Number(options.p), Number(options.dklen), options.onProgress);
  }

  window.WallexKdf = Object.freeze({ deriveEntropy, deriveScryptBytes });
})();
