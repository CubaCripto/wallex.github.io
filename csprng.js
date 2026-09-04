/* WALLEX CSPRNG entropy generator — local-only, no dependencies. */
(() => {
  'use strict';

  const BIP39_ENTROPY_BYTES = Object.freeze({
    12: 16,
    15: 20,
    18: 24,
    21: 28,
    24: 32
  });

  function bytesToLowerHex(bytes) {
    let hex = '';
    for (let index = 0; index < bytes.length; index += 1) {
      hex += bytes[index].toString(16).padStart(2, '0');
    }
    return hex;
  }

  function generateEntropy(wordCount) {
    const byteLength = BIP39_ENTROPY_BYTES[Number(wordCount)];
    if (!Number.isInteger(byteLength)) {
      throw new Error('Unsupported BIP39 word count.');
    }

    const webCrypto = globalThis.crypto;
    if (!webCrypto || typeof webCrypto.getRandomValues !== 'function') {
      throw new Error('Web Crypto getRandomValues() is unavailable in this browser.');
    }

    const entropyBytes = new Uint8Array(byteLength);
    try {
      webCrypto.getRandomValues(entropyBytes);
      return bytesToLowerHex(entropyBytes);
    } finally {
      entropyBytes.fill(0);
    }
  }

  window.WallexCSPRNG = Object.freeze({ generateEntropy });
})();
