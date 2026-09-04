/* WALLEX BIP38 non-EC-multiply encryption. Fully local. */
(() => {
  'use strict';
  const encoder = new TextEncoder();
  const zero = value => { if (ArrayBuffer.isView(value)) value.fill(0); };

  async function encrypt(privateKey, passphrase, address, compressed = true, onProgress = null) {
    if (!(privateKey instanceof Uint8Array) || privateKey.length !== 32) throw new Error('BIP38 requires a 32-byte private key.');
    if (typeof passphrase !== 'string' || passphrase.length === 0) throw new Error('A BIP38 passphrase is required.');
    if (typeof address !== 'string' || address.length === 0) throw new Error('A Bitcoin address is required for BIP38.');
    if (!window.WallexKdf || typeof window.WallexKdf.deriveScryptBytes !== 'function') throw new Error('The local scrypt module is unavailable.');

    let password=null,addressBytes=null,firstHash=null,secondHash=null,derived=null,left=null,right=null,aesKey=null,encryptedLeft=null,encryptedRight=null;
    try {
      password=encoder.encode(passphrase.normalize('NFC'));
      addressBytes=encoder.encode(address);
      firstHash=await window.WallexBtc.sha256(addressBytes);
      secondHash=await window.WallexBtc.sha256(firstHash);
      const addressHash=secondHash.slice(0,4);
      derived=await window.WallexKdf.deriveScryptBytes(password,addressHash,{n:16384,r:8,p:8,dklen:64,onProgress});
      left=privateKey.slice(0,16);right=privateKey.slice(16,32);
      for(let i=0;i<16;i+=1){left[i]^=derived[i];right[i]^=derived[i+16];}
      aesKey=derived.slice(32,64);
      encryptedLeft=window.WallexAes256.encryptBlock(left,aesKey);
      encryptedRight=window.WallexAes256.encryptBlock(right,aesKey);
      const payload=window.WallexBtc.concat(Uint8Array.of(0x01,0x42,compressed?0xe0:0xc0),addressHash,encryptedLeft,encryptedRight);
      return await window.WallexBtc.base58check(payload);
    } finally {
      zero(password);zero(addressBytes);zero(firstHash);zero(secondHash);zero(derived);
      zero(left);zero(right);zero(aesKey);zero(encryptedLeft);zero(encryptedRight);
    }
  }

  window.WallexBip38=Object.freeze({encrypt});
})();
