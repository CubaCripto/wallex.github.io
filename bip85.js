/* WALLEX BIP85 deterministic entropy derivation. Fully local. */
(() => {
  'use strict';

  const encoder = new TextEncoder();
  const bip85Key = encoder.encode('bip-entropy-from-k');

  async function hmacSha512(key, message) {
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      key,
      { name: 'HMAC', hash: 'SHA-512' },
      false,
      ['sign']
    );
    return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, message));
  }

  async function entropyAtPath(root, path) {
    const node = await window.WallexBip32.derive(root, path);
    return hmacSha512(bip85Key, node.key);
  }

  async function deriveHex(root, bits, index) {
    const bytes = bits / 8;
    if (![16, 20, 24, 28, 32, 64].includes(bytes)) {
      throw new Error('Invalid BIP85 hexadecimal entropy length.');
    }
    const path = `m/83696968'/128169'/${bytes}'/${index}'`;
    const entropy = await entropyAtPath(root, path);
    return {
      path,
      value: window.WallexBtc.hex(entropy.slice(0, bytes))
    };
  }

  async function deriveMnemonic(root, words, index) {
    const entropyBytesByWords = { 12: 16, 15: 20, 18: 24, 21: 28, 24: 32 };
    const bytes = entropyBytesByWords[words];
    if (!bytes) throw new Error('Invalid BIP85 BIP39 word count.');
    const path = `m/83696968'/39'/0'/${words}'/${index}'`;
    const entropy = await entropyAtPath(root, path);
    const entropyHex = window.WallexBtc.hex(entropy.slice(0, bytes));
    return {
      path,
      value: await window.WallexBip39.entropyToMnemonic(entropyHex)
    };
  }

  async function deriveXprv(root, index) {
    const path = `m/83696968'/32'/${index}'`;
    const entropy = await entropyAtPath(root, path);
    const key = entropy.slice(32, 64);
    const keyNumber = window.WallexSecp256k1.bytesToNumber(key);
    if (keyNumber === 0n || keyNumber >= window.WallexSecp256k1.N) {
      throw new Error('BIP85 produced an invalid XPRV private key.');
    }
    const node = {
      key,
      chainCode: entropy.slice(0, 32),
      depth: 0,
      index: 0,
      parentFingerprint: new Uint8Array(4)
    };
    return { path, value: await window.WallexBip32.serialize(node, true) };
  }

  async function deriveWif(root, index) {
    const path = `m/83696968'/2'/${index}'`;
    const entropy = await entropyAtPath(root, path);
    const key = entropy.slice(0, 32);
    const keyNumber = window.WallexSecp256k1.bytesToNumber(key);
    if (keyNumber === 0n || keyNumber >= window.WallexSecp256k1.N) {
      throw new Error('BIP85 produced an invalid WIF private key.');
    }
    return { path, value: await window.WallexBtc.wif(key) };
  }

  async function derive(root, options) {
    const index = Number(options.index);
    if (!Number.isSafeInteger(index) || index < 0 || index >= 0x80000000) {
      throw new Error('BIP85 index must be between 0 and 2147483647.');
    }
    if (options.type === 'bip39-mnemonic') {
      return deriveMnemonic(root, Number(options.words), index);
    }
    if (options.type === 'hexadecimal-entropy') {
      return deriveHex(root, Number(options.bits), index);
    }
    if (options.type === 'bip32-xprv') return deriveXprv(root, index);
    if (options.type === 'private-key-wif') return deriveWif(root, index);
    throw new Error('Unsupported BIP85 derivation type.');
  }

  window.WallexBip85 = Object.freeze({ entropyAtPath, derive });
})();
