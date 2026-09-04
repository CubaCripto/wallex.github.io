/* WALLEX BIP39 implementation. Fully local: no network or external dependencies. */
(() => {
  'use strict';

  const encoder = new TextEncoder();
  const wordlist = window.BIP39_WORDS;
  const VALID_ENTROPY_BYTES = new Set([16, 20, 24, 28, 32]);

  if (!Array.isArray(wordlist) || wordlist.length !== 2048 || new Set(wordlist).size !== 2048) {
    throw new Error('The local BIP39 English wordlist is invalid.');
  }

  function zero(value) {
    if (ArrayBuffer.isView(value) && typeof value.fill === 'function') value.fill(0);
  }

  function hexToBytes(hex) {
    if (typeof hex !== 'string' || !/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) {
      throw new Error('BIP39 entropy must be valid hexadecimal.');
    }
    const bytes = new Uint8Array(hex.length / 2);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }
    if (!VALID_ENTROPY_BYTES.has(bytes.length)) {
      zero(bytes);
      throw new Error('BIP39 entropy must contain 128, 160, 192, 224 or 256 bits.');
    }
    return bytes;
  }

  function bytesToLowerHex(bytes) {
    let result = '';
    for (const byte of bytes) result += byte.toString(16).padStart(2, '0');
    return result;
  }

  async function entropyToMnemonic(entropyHex) {
    if (!globalThis.crypto?.subtle) throw new Error('Web Crypto SHA-256 is unavailable in this browser.');
    const entropy = hexToBytes(entropyHex);
    let digest = null;
    try {
      digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', entropy));
      const entropyBits = entropy.length * 8;
      const checksumBits = entropyBits / 32;
      let bits = '';
      for (const byte of entropy) bits += byte.toString(2).padStart(8, '0');
      bits += digest[0].toString(2).padStart(8, '0').slice(0, checksumBits);

      const words = [];
      for (let offset = 0; offset < bits.length; offset += 11) {
        words.push(wordlist[Number.parseInt(bits.slice(offset, offset + 11), 2)]);
      }
      return words.join(' ');
    } finally {
      zero(entropy);
      zero(digest);
    }
  }

  async function mnemonicToSeed(mnemonic, passphrase = '') {
    if (!globalThis.crypto?.subtle) throw new Error('Web Crypto PBKDF2 is unavailable in this browser.');
    if (typeof mnemonic !== 'string' || mnemonic.trim() === '') throw new Error('A BIP39 mnemonic is required.');
    if (typeof passphrase !== 'string') throw new Error('The BIP39 passphrase must be text.');

    const password = encoder.encode(mnemonic.normalize('NFKD'));
    const salt = encoder.encode(`mnemonic${passphrase.normalize('NFKD')}`);
    let seed = null;
    try {
      const key = await globalThis.crypto.subtle.importKey('raw', password, 'PBKDF2', false, ['deriveBits']);
      const bits = await globalThis.crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt, iterations: 2048, hash: 'SHA-512' },
        key,
        512
      );
      seed = new Uint8Array(bits);
      return bytesToLowerHex(seed);
    } finally {
      zero(password);
      zero(salt);
      zero(seed);
    }
  }

  window.WallexBip39 = Object.freeze({ entropyToMnemonic, mnemonicToSeed });
})();
