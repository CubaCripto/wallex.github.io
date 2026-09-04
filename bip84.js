/* WALLEX BIP84 native SegWit policy. Fully local. */
(()=>{'use strict';const account=(network=0,accountIndex=0)=>`m/84'/${network}'/${accountIndex}'`,path=(index=0,change=0,network=0,accountIndex=0)=>`${account(network,accountIndex)}/${change}/${index}`;window.WallexBip84=Object.freeze({account,path});})();
