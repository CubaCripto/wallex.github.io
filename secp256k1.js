/* WALLEX secp256k1 operations shared by BTC, ETH and TRX. Fully local. */
(() => {
  'use strict';
  const P=0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn,N=0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const G=Object.freeze({x:0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,y:0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n});
  const mod=(a,m=P)=>((a%m)+m)%m;
  function inv(a,m=P){let [r,n,s,t]=[mod(a,m),m,1n,0n];while(n){const q=r/n;[r,n]=[n,r-q*n];[s,t]=[t,s-q*t];}if(r!==1n)throw new Error('Invalid secp256k1 inverse.');return mod(s,m);}
  function add(a,b){if(!a)return b;if(!b)return a;if(a.x===b.x&&a.y!==b.y)return null;if(a.x===b.x&&a.y===0n)return null;const l=a.x===b.x?mod(3n*a.x*a.x*inv(2n*a.y)):mod((b.y-a.y)*inv(b.x-a.x));const x=mod(l*l-a.x-b.x);return{x,y:mod(l*(a.x-x)-a.y)};}
  function multiply(k,p=G){k=mod(BigInt(k),N);if(!k)return null;let r=null,q=p;while(k){if(k&1n)r=add(r,q);q=add(q,q);k>>=1n;}return r;}
  const bytesToNumber=bytes=>{let n=0n;for(const b of bytes)n=(n<<8n)|BigInt(b);return n;};
  function numberToBytes(n,length=32){const out=new Uint8Array(length);for(let i=length-1;i>=0;i--,n>>=8n)out[i]=Number(n&255n);return out;}
  function privateToPoint(key){const d=bytesToNumber(key);if(d<=0n||d>=N)throw new Error('Invalid secp256k1 private key.');return multiply(d);}
  function pointToBytes(p,compressed=true){const x=numberToBytes(p.x),y=numberToBytes(p.y);if(!compressed){const out=new Uint8Array(65);out[0]=4;out.set(x,1);out.set(y,33);return out;}const out=new Uint8Array(33);out[0]=Number(2n+(p.y&1n));out.set(x,1);return out;}
  const privateToPublic=(key,compressed=true)=>pointToBytes(privateToPoint(key),compressed);
  function privateAdd(key,tweak){const d=mod(bytesToNumber(key)+bytesToNumber(tweak),N);if(!d)throw new Error('Invalid secp256k1 child key.');return numberToBytes(d);}
  window.WallexSecp256k1=Object.freeze({P,N,G,add,multiply,bytesToNumber,numberToBytes,privateToPoint,pointToBytes,privateToPublic,privateAdd});
})();
