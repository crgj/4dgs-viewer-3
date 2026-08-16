(function(){var e=(e,t)=>()=>(t||(e((t={exports:{}}).exports,t),e=null),t.exports),t=`data:application/wasm;base64,AGFzbQEAAAABSQZgAABgAX8Bf2AEf39/fwBgCX9/f39/f39/fwF/YA1/f39/f39/f39/f39/AGAZf39/f39/f39/f399fX19fX19fX19fX19fwADBwYAAQIDBAUFBQEBIIAIBgYBfwFBCAsHRwYGbWVtb3J5AgAFcmVzZXQAAAVhbGxvYwABBmNlbnN1cwACEXN0ZXJlb19tYXRjaF9ncmlkAAQNb3BhY2l0eV9zcGxhdAAFCq4IBgYAQQgkAAtAAQN/IwAhASABIABBB2pqQXhxIQIgAj8AQRB0SwRAIAJB//8DakEQdj8AayEDIANAAEF/RgRAAAsLIAIkACABC+UBAQd/IAFBACACIANsQQJ0/AsAQQIhBQJAA0AgBSADQQJrTg0BQQIhBAJAA0AgBCACQQJrTg0BIAAgBSACbCAEamotAAAhCEEAIQlBACEKQX4hBwJAA0AgB0ECSg0BQX4hBgJAA0AgBkECSg0BIAZBAEcgB0EAR3IEQCAAIAUgB2ogAmwgBCAGampqLQAAIAhJBEAgCUEBIAp0ciEJCyAKQQFqIQoLIAZBAWohBgwACwsgB0EBaiEHDAALCyABIAUgAmwgBGpBAnRqIAk2AgAgBEEBaiEEDAALCyAFQQFqIQUMAAsLC9kBAQl/Qf////8HIQ1B/////wchDkEAIQ8gByEJAkADQCAJIAhKDQEgBCAGIAlsaiEKIApBA04gCiACQQNrSHEEQEEAIQxBfyELAkADQCALQQFKDQEgBSALaiACbCAEakECdCEQIAUgC2ogAmwgCmpBAnQhESAMIAAgEGooAgAgASARaigCAHNpaiEMIAtBAWohCwwACwsgDCANSARAIA0hDiAMIQ0gCSEPBSAMIA5IBEAgDCEOCwsLIAlBAWohCQwACwsgDUE0TCAOIA1rQQFOcQR/IA8FQQALC9sBAQh/IAxBACAIIAlsQQF0/AsAQQAhDgJAA0AgDiAJTg0BIAYgDiAHbGohEEEAIQ0CQANAIA0gCE4NASAFIA0gB2xqIQ8gDiAIbCANaiEUIAIgECADbCAPamotAABBAEcEQCAAIAEgAyAEIA8gEEF/IAogCxADIREgEUEASgRAIAEgACADIAQgDyARayAQQQEgCiALEAMhEiASIBFrIRMgE0EASARAQQAgE2shEwsgE0ECTARAIAwgFEEBdGogETsBAAsLCyANQQFqIQ0MAAsLIA5BAWohDgwACwsLxAICBH8KfSAJIRsCQANAIBsgCkoNASAbsiANkyEfIAchGgJAA0AgGiAISg0BIBqyIAyTIR4gBSEZAkADQCAZIAZKDQEgGbIgC5MhHSAOIB2UIA8gHpSSIBAgH5SSISAgESAdlCASIB6UkiATIB+UkiEhIBQgHZQgFSAelJIgFiAflJIhIiAgICCUICEgIZSSICIgIpSSISMgI0MAABBBXQRAQwAAgD8gI0MAABBBlZMhJCAXICQgJCAklJSUISUgGyAEbCAaaiADbCAZakECdCEcIAAgHGoqAgAhJiAAIBxqQwAAgD9DAACAP0MAAIA/ICaTQwAAgD8gJZOUk5Y4AgAgJSABIBxqKgIAXgRAIAEgHGogJTgCACACIBxqIBg2AgALCyAZQQFqIRkMAAsLIBpBAWohGgwACwsgG0EBaiEbDAALCwsA1gUEbmFtZQEIAQMFbWF0Y2gCuwUGAAABBAAEc2l6ZQEFc3RhcnQCA2VuZAMIcmVxdWlyZWQCCwAEZ3JheQEGb3V0cHV0AgV3aWR0aAMGaGVpZ2h0BAF4BQF5BgJkeAcCZHkIBmNlbnRlcgkKZGVzY3JpcHRvcgoDYml0AxIABnNvdXJjZQEGdGFyZ2V0AgV3aWR0aAMGaGVpZ2h0BAF4BQF5BglkaXJlY3Rpb24HB21pbmltdW0IB21heGltdW0JCWRpc3Bhcml0eQoIdGFyZ2V0X3gLAmR5DARjb3N0DQRiZXN0DgZzZWNvbmQPDmJlc3RfZGlzcGFyaXR5EA1zb3VyY2Vfb2Zmc2V0EQ10YXJnZXRfb2Zmc2V0BBUABGxlZnQBBXJpZ2h0Agpmb3JlZ3JvdW5kAwV3aWR0aAQGaGVpZ2h0BQd4X3N0YXJ0Bgd5X3N0YXJ0BwRzdGVwCAdjb2x1bW5zCQRyb3dzCgdtaW5pbXVtCwdtYXhpbXVtDAZvdXRwdXQNBmNvbHVtbg4Dcm93DwF4EAF5EQlkaXNwYXJpdHkSB3JldmVyc2UTCmRpZmZlcmVuY2UUDG91dHB1dF9pbmRleAUnAAVmaWVsZAEEYmVzdAIGd2lubmVyAwVkaW1feAQFZGltX3kFBW1pbl94BgVtYXhfeAcFbWluX3kIBW1heF95CQVtaW5fegoFbWF4X3oLCGNlbnRlcl94DAhjZW50ZXJfeQ0IY2VudGVyX3oOA2EwMA8DYTAxEANhMDIRA2ExMBIDYTExEwNhMTIUA2EyMBUDYTIxFgNhMjIXB29wYWNpdHkYC2dhdXNzaWFuX2lkGQF4GgF5GwF6HAZvZmZzZXQdAmR4HgJkeR8CZHogAmx4IQJseSICbHojDnJhZGl1c19zcXVhcmVkJAZrZXJuZWwlDGNvbnRyaWJ1dGlvbiYIcHJldmlvdXMHBwEABGhlYXA=`,n=e((e=>{var t=new Int32Array(24),n=new Int32Array(256);(function(){for(var e=0,r=0;r<8;++r)for(var i=1;i<=4;i<<=1){var a=r^i;r<=a&&(t[e++]=r,t[e++]=a)}for(var r=0;r<256;++r){for(var o=0,i=0;i<24;i+=2){var s=!!(r&1<<t[i]),c=!!(r&1<<t[i+1]);o|=s===c?0:1<<(i>>1)}n[r]=o}})();var r=Array(4096);(function(){for(var e=0;e<r.length;++e)r[e]=0})(),e.surfaceNets=function(e,i,a){a||=[[0,0,0],e];for(var o=[0,0,0],s=[0,0,0],c=0;c<3;++c)o[c]=(a[1][c]-a[0][c])/e[c],s[c]=a[0][c];var l=[],u=[],d=0,f=[0,0,0],p=[1,e[0]+1,(e[0]+1)*(e[1]+1)],m=[0,0,0,0,0,0,0,0],h=1;if(p[2]*2>r.length){var g=r.length;for(r.length=p[2]*2;g<r.length;)r[g++]=0}for(f[2]=0;f[2]<e[2]-1;++f[2],d+=e[0],h^=1,p[2]=-p[2]){var _=1+(e[0]+1)*(1+h*(e[1]+1));for(f[1]=0;f[1]<e[1]-1;++f[1],++d,_+=2)for(f[0]=0;f[0]<e[0]-1;++f[0],++d,++_){for(var v=0,y=0,b=0;b<2;++b)for(var x=0;x<2;++x)for(var c=0;c<2;++c,++y){var S=i(o[0]*(f[0]+c)+s[0],o[1]*(f[1]+x)+s[1],o[2]*(f[2]+b)+s[2]);m[y]=S,v|=S<0?1<<y:0}if(v!==0&&v!==255){for(var C=n[v],w=[0,0,0],T=0,c=0;c<12;++c)if(C&1<<c){++T;var E=t[c<<1],D=t[(c<<1)+1],O=m[E],k=O-m[D];if(Math.abs(k)>1e-6)k=O/k;else continue;for(var x=0,b=1;x<3;++x,b<<=1){var A=E&b;A===(D&b)?w[x]+=+!!A:w[x]+=A?1-k:k}}for(var j=1/T,c=0;c<3;++c)w[c]=o[c]*(f[c]+j*w[c])+s[c];r[_]=l.length,l.push(w);for(var c=0;c<3;++c)if(C&1<<c){var M=(c+1)%3,N=(c+2)%3;if(f[M]!==0&&f[N]!==0){var P=p[M],F=p[N];v&1?(u.push([r[_],r[_-P],r[_-F]]),u.push([r[_-F],r[_-P],r[_-P-F]])):(u.push([r[_],r[_-F],r[_-P]]),u.push([r[_-P],r[_-F],r[_-P-F]]))}}}}}return{positions:l,cells:u}}})),r=e((e=>{var t=new Uint32Array([0,265,515,778,1030,1295,1541,1804,2060,2309,2575,2822,3082,3331,3593,3840,400,153,915,666,1430,1183,1941,1692,2460,2197,2975,2710,3482,3219,3993,3728,560,825,51,314,1590,1855,1077,1340,2620,2869,2111,2358,3642,3891,3129,3376,928,681,419,170,1958,1711,1445,1196,2988,2725,2479,2214,4010,3747,3497,3232,1120,1385,1635,1898,102,367,613,876,3180,3429,3695,3942,2154,2403,2665,2912,1520,1273,2035,1786,502,255,1013,764,3580,3317,4095,3830,2554,2291,3065,2800,1616,1881,1107,1370,598,863,85,348,3676,3925,3167,3414,2650,2899,2137,2384,1984,1737,1475,1226,966,719,453,204,4044,3781,3535,3270,3018,2755,2505,2240,2240,2505,2755,3018,3270,3535,3781,4044,204,453,719,966,1226,1475,1737,1984,2384,2137,2899,2650,3414,3167,3925,3676,348,85,863,598,1370,1107,1881,1616,2800,3065,2291,2554,3830,4095,3317,3580,764,1013,255,502,1786,2035,1273,1520,2912,2665,2403,2154,3942,3695,3429,3180,876,613,367,102,1898,1635,1385,1120,3232,3497,3747,4010,2214,2479,2725,2988,1196,1445,1711,1958,170,419,681,928,3376,3129,3891,3642,2358,2111,2869,2620,1340,1077,1855,1590,314,51,825,560,3728,3993,3219,3482,2710,2975,2197,2460,1692,1941,1183,1430,666,915,153,400,3840,3593,3331,3082,2822,2575,2309,2060,1804,1541,1295,1030,778,515,265,0]),n=[[],[0,8,3],[0,1,9],[1,8,3,9,8,1],[1,2,10],[0,8,3,1,2,10],[9,2,10,0,2,9],[2,8,3,2,10,8,10,9,8],[3,11,2],[0,11,2,8,11,0],[1,9,0,2,3,11],[1,11,2,1,9,11,9,8,11],[3,10,1,11,10,3],[0,10,1,0,8,10,8,11,10],[3,9,0,3,11,9,11,10,9],[9,8,10,10,8,11],[4,7,8],[4,3,0,7,3,4],[0,1,9,8,4,7],[4,1,9,4,7,1,7,3,1],[1,2,10,8,4,7],[3,4,7,3,0,4,1,2,10],[9,2,10,9,0,2,8,4,7],[2,10,9,2,9,7,2,7,3,7,9,4],[8,4,7,3,11,2],[11,4,7,11,2,4,2,0,4],[9,0,1,8,4,7,2,3,11],[4,7,11,9,4,11,9,11,2,9,2,1],[3,10,1,3,11,10,7,8,4],[1,11,10,1,4,11,1,0,4,7,11,4],[4,7,8,9,0,11,9,11,10,11,0,3],[4,7,11,4,11,9,9,11,10],[9,5,4],[9,5,4,0,8,3],[0,5,4,1,5,0],[8,5,4,8,3,5,3,1,5],[1,2,10,9,5,4],[3,0,8,1,2,10,4,9,5],[5,2,10,5,4,2,4,0,2],[2,10,5,3,2,5,3,5,4,3,4,8],[9,5,4,2,3,11],[0,11,2,0,8,11,4,9,5],[0,5,4,0,1,5,2,3,11],[2,1,5,2,5,8,2,8,11,4,8,5],[10,3,11,10,1,3,9,5,4],[4,9,5,0,8,1,8,10,1,8,11,10],[5,4,0,5,0,11,5,11,10,11,0,3],[5,4,8,5,8,10,10,8,11],[9,7,8,5,7,9],[9,3,0,9,5,3,5,7,3],[0,7,8,0,1,7,1,5,7],[1,5,3,3,5,7],[9,7,8,9,5,7,10,1,2],[10,1,2,9,5,0,5,3,0,5,7,3],[8,0,2,8,2,5,8,5,7,10,5,2],[2,10,5,2,5,3,3,5,7],[7,9,5,7,8,9,3,11,2],[9,5,7,9,7,2,9,2,0,2,7,11],[2,3,11,0,1,8,1,7,8,1,5,7],[11,2,1,11,1,7,7,1,5],[9,5,8,8,5,7,10,1,3,10,3,11],[5,7,0,5,0,9,7,11,0,1,0,10,11,10,0],[11,10,0,11,0,3,10,5,0,8,0,7,5,7,0],[11,10,5,7,11,5],[10,6,5],[0,8,3,5,10,6],[9,0,1,5,10,6],[1,8,3,1,9,8,5,10,6],[1,6,5,2,6,1],[1,6,5,1,2,6,3,0,8],[9,6,5,9,0,6,0,2,6],[5,9,8,5,8,2,5,2,6,3,2,8],[2,3,11,10,6,5],[11,0,8,11,2,0,10,6,5],[0,1,9,2,3,11,5,10,6],[5,10,6,1,9,2,9,11,2,9,8,11],[6,3,11,6,5,3,5,1,3],[0,8,11,0,11,5,0,5,1,5,11,6],[3,11,6,0,3,6,0,6,5,0,5,9],[6,5,9,6,9,11,11,9,8],[5,10,6,4,7,8],[4,3,0,4,7,3,6,5,10],[1,9,0,5,10,6,8,4,7],[10,6,5,1,9,7,1,7,3,7,9,4],[6,1,2,6,5,1,4,7,8],[1,2,5,5,2,6,3,0,4,3,4,7],[8,4,7,9,0,5,0,6,5,0,2,6],[7,3,9,7,9,4,3,2,9,5,9,6,2,6,9],[3,11,2,7,8,4,10,6,5],[5,10,6,4,7,2,4,2,0,2,7,11],[0,1,9,4,7,8,2,3,11,5,10,6],[9,2,1,9,11,2,9,4,11,7,11,4,5,10,6],[8,4,7,3,11,5,3,5,1,5,11,6],[5,1,11,5,11,6,1,0,11,7,11,4,0,4,11],[0,5,9,0,6,5,0,3,6,11,6,3,8,4,7],[6,5,9,6,9,11,4,7,9,7,11,9],[10,4,9,6,4,10],[4,10,6,4,9,10,0,8,3],[10,0,1,10,6,0,6,4,0],[8,3,1,8,1,6,8,6,4,6,1,10],[1,4,9,1,2,4,2,6,4],[3,0,8,1,2,9,2,4,9,2,6,4],[0,2,4,4,2,6],[8,3,2,8,2,4,4,2,6],[10,4,9,10,6,4,11,2,3],[0,8,2,2,8,11,4,9,10,4,10,6],[3,11,2,0,1,6,0,6,4,6,1,10],[6,4,1,6,1,10,4,8,1,2,1,11,8,11,1],[9,6,4,9,3,6,9,1,3,11,6,3],[8,11,1,8,1,0,11,6,1,9,1,4,6,4,1],[3,11,6,3,6,0,0,6,4],[6,4,8,11,6,8],[7,10,6,7,8,10,8,9,10],[0,7,3,0,10,7,0,9,10,6,7,10],[10,6,7,1,10,7,1,7,8,1,8,0],[10,6,7,10,7,1,1,7,3],[1,2,6,1,6,8,1,8,9,8,6,7],[2,6,9,2,9,1,6,7,9,0,9,3,7,3,9],[7,8,0,7,0,6,6,0,2],[7,3,2,6,7,2],[2,3,11,10,6,8,10,8,9,8,6,7],[2,0,7,2,7,11,0,9,7,6,7,10,9,10,7],[1,8,0,1,7,8,1,10,7,6,7,10,2,3,11],[11,2,1,11,1,7,10,6,1,6,7,1],[8,9,6,8,6,7,9,1,6,11,6,3,1,3,6],[0,9,1,11,6,7],[7,8,0,7,0,6,3,11,0,11,6,0],[7,11,6],[7,6,11],[3,0,8,11,7,6],[0,1,9,11,7,6],[8,1,9,8,3,1,11,7,6],[10,1,2,6,11,7],[1,2,10,3,0,8,6,11,7],[2,9,0,2,10,9,6,11,7],[6,11,7,2,10,3,10,8,3,10,9,8],[7,2,3,6,2,7],[7,0,8,7,6,0,6,2,0],[2,7,6,2,3,7,0,1,9],[1,6,2,1,8,6,1,9,8,8,7,6],[10,7,6,10,1,7,1,3,7],[10,7,6,1,7,10,1,8,7,1,0,8],[0,3,7,0,7,10,0,10,9,6,10,7],[7,6,10,7,10,8,8,10,9],[6,8,4,11,8,6],[3,6,11,3,0,6,0,4,6],[8,6,11,8,4,6,9,0,1],[9,4,6,9,6,3,9,3,1,11,3,6],[6,8,4,6,11,8,2,10,1],[1,2,10,3,0,11,0,6,11,0,4,6],[4,11,8,4,6,11,0,2,9,2,10,9],[10,9,3,10,3,2,9,4,3,11,3,6,4,6,3],[8,2,3,8,4,2,4,6,2],[0,4,2,4,6,2],[1,9,0,2,3,4,2,4,6,4,3,8],[1,9,4,1,4,2,2,4,6],[8,1,3,8,6,1,8,4,6,6,10,1],[10,1,0,10,0,6,6,0,4],[4,6,3,4,3,8,6,10,3,0,3,9,10,9,3],[10,9,4,6,10,4],[4,9,5,7,6,11],[0,8,3,4,9,5,11,7,6],[5,0,1,5,4,0,7,6,11],[11,7,6,8,3,4,3,5,4,3,1,5],[9,5,4,10,1,2,7,6,11],[6,11,7,1,2,10,0,8,3,4,9,5],[7,6,11,5,4,10,4,2,10,4,0,2],[3,4,8,3,5,4,3,2,5,10,5,2,11,7,6],[7,2,3,7,6,2,5,4,9],[9,5,4,0,8,6,0,6,2,6,8,7],[3,6,2,3,7,6,1,5,0,5,4,0],[6,2,8,6,8,7,2,1,8,4,8,5,1,5,8],[9,5,4,10,1,6,1,7,6,1,3,7],[1,6,10,1,7,6,1,0,7,8,7,0,9,5,4],[4,0,10,4,10,5,0,3,10,6,10,7,3,7,10],[7,6,10,7,10,8,5,4,10,4,8,10],[6,9,5,6,11,9,11,8,9],[3,6,11,0,6,3,0,5,6,0,9,5],[0,11,8,0,5,11,0,1,5,5,6,11],[6,11,3,6,3,5,5,3,1],[1,2,10,9,5,11,9,11,8,11,5,6],[0,11,3,0,6,11,0,9,6,5,6,9,1,2,10],[11,8,5,11,5,6,8,0,5,10,5,2,0,2,5],[6,11,3,6,3,5,2,10,3,10,5,3],[5,8,9,5,2,8,5,6,2,3,8,2],[9,5,6,9,6,0,0,6,2],[1,5,8,1,8,0,5,6,8,3,8,2,6,2,8],[1,5,6,2,1,6],[1,3,6,1,6,10,3,8,6,5,6,9,8,9,6],[10,1,0,10,0,6,9,5,0,5,6,0],[0,3,8,5,6,10],[10,5,6],[11,5,10,7,5,11],[11,5,10,11,7,5,8,3,0],[5,11,7,5,10,11,1,9,0],[10,7,5,10,11,7,9,8,1,8,3,1],[11,1,2,11,7,1,7,5,1],[0,8,3,1,2,7,1,7,5,7,2,11],[9,7,5,9,2,7,9,0,2,2,11,7],[7,5,2,7,2,11,5,9,2,3,2,8,9,8,2],[2,5,10,2,3,5,3,7,5],[8,2,0,8,5,2,8,7,5,10,2,5],[9,0,1,5,10,3,5,3,7,3,10,2],[9,8,2,9,2,1,8,7,2,10,2,5,7,5,2],[1,3,5,3,7,5],[0,8,7,0,7,1,1,7,5],[9,0,3,9,3,5,5,3,7],[9,8,7,5,9,7],[5,8,4,5,10,8,10,11,8],[5,0,4,5,11,0,5,10,11,11,3,0],[0,1,9,8,4,10,8,10,11,10,4,5],[10,11,4,10,4,5,11,3,4,9,4,1,3,1,4],[2,5,1,2,8,5,2,11,8,4,5,8],[0,4,11,0,11,3,4,5,11,2,11,1,5,1,11],[0,2,5,0,5,9,2,11,5,4,5,8,11,8,5],[9,4,5,2,11,3],[2,5,10,3,5,2,3,4,5,3,8,4],[5,10,2,5,2,4,4,2,0],[3,10,2,3,5,10,3,8,5,4,5,8,0,1,9],[5,10,2,5,2,4,1,9,2,9,4,2],[8,4,5,8,5,3,3,5,1],[0,4,5,1,0,5],[8,4,5,8,5,3,9,0,5,0,3,5],[9,4,5],[4,11,7,4,9,11,9,10,11],[0,8,3,4,9,7,9,11,7,9,10,11],[1,10,11,1,11,4,1,4,0,7,4,11],[3,1,4,3,4,8,1,10,4,7,4,11,10,11,4],[4,11,7,9,11,4,9,2,11,9,1,2],[9,7,4,9,11,7,9,1,11,2,11,1,0,8,3],[11,7,4,11,4,2,2,4,0],[11,7,4,11,4,2,8,3,4,3,2,4],[2,9,10,2,7,9,2,3,7,7,4,9],[9,10,7,9,7,4,10,2,7,8,7,0,2,0,7],[3,7,10,3,10,2,7,4,10,1,10,0,4,0,10],[1,10,2,8,7,4],[4,9,1,4,1,7,7,1,3],[4,9,1,4,1,7,0,8,1,8,7,1],[4,0,3,7,4,3],[4,8,7],[9,10,8,10,11,8],[3,0,9,3,9,11,11,9,10],[0,1,10,0,10,8,8,10,11],[3,1,10,11,3,10],[1,2,11,1,11,9,9,11,8],[3,0,9,3,9,11,1,2,9,2,11,9],[0,2,11,8,0,11],[3,2,11],[2,3,8,2,8,10,10,8,9],[9,10,2,0,9,2],[2,3,8,2,8,10,0,1,8,1,10,8],[1,10,2],[1,3,8,9,1,8],[0,9,1],[0,3,8],[]],r=[[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]],i=[[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];e.marchingCubes=function(e,a,o){o||=[[0,0,0],e];for(var s=[0,0,0],c=[0,0,0],l=0;l<3;++l)s[l]=(o[1][l]-o[0][l])/e[l],c[l]=o[0][l];var u=[],d=[],f=0,p=Array(8),m=Array(12),h=[0,0,0];for(h[2]=0;h[2]<e[2]-1;++h[2],f+=e[0])for(h[1]=0;h[1]<e[1]-1;++h[1],++f)for(h[0]=0;h[0]<e[0]-1;++h[0],++f){for(var g=0,l=0;l<8;++l){var _=r[l],v=a(s[0]*(h[0]+_[0])+c[0],s[1]*(h[1]+_[1])+c[1],s[2]*(h[2]+_[2])+c[2]);p[l]=v,g|=v>0?1<<l:0}var y=t[g];if(y!==0){for(var l=0;l<12;++l)if(y&1<<l){m[l]=u.length;var b=[0,0,0],x=i[l],S=r[x[0]],C=r[x[1]],w=p[x[0]],T=w-p[x[1]],E=0;Math.abs(T)>1e-6&&(E=w/T);for(var D=0;D<3;++D)b[D]=s[D]*(h[D]+S[D]+E*(C[D]-S[D]))+c[D];u.push(b)}for(var O=n[g],l=0;l<O.length;l+=3)d.push([m[O[l]],m[O[l+1]],m[O[l+2]]])}}return{positions:u,cells:d}}})),i=e((e=>{var t=[[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]],n=[[0,2,3,7],[0,6,2,7],[0,4,6,7],[0,6,1,2],[0,1,6,4],[5,6,1,4]];e.marchingTetrahedra=function(e,r,i){i||=[[0,0,0],e];for(var a=[0,0,0],o=[0,0,0],s=0;s<3;++s)a[s]=(i[1][s]-i[0][s])/e[s],o[s]=i[0][s];var c=[],l=[],u=0,d=new Float32Array(8),f=[0,0,0];function p(e,n){var r=d[e],i=d[n],s=t[e],l=t[n],u=[f[0],f[1],f[2]],p=r-i;Math.abs(p)>1e-6&&(p=r/p);for(var m=0;m<3;++m)u[m]=a[m]*(u[m]+s[m]+p*(l[m]-s[m]))+o[m];return c.push(u),c.length-1}for(f[2]=0;f[2]<e[2]-1;++f[2],u+=e[0])for(f[1]=0;f[1]<e[1]-1;++f[1],++u)for(f[0]=0;f[0]<e[0]-1;++f[0],++u){for(var s=0;s<8;++s){var m=t[s];d[s]=r(a[0]*(f[0]+m[0])+o[0],a[1]*(f[1]+m[1])+o[1],a[2]*(f[2]+m[2])+o[2])}for(var s=0;s<n.length;++s){var h=n[s],g=0;switch(d[h[0]]<0&&(g|=1),d[h[1]]<0&&(g|=2),d[h[2]]<0&&(g|=4),d[h[3]]<0&&(g|=8),g){case 0:case 15:break;case 14:l.push([p(h[0],h[1]),p(h[0],h[3]),p(h[0],h[2])]);break;case 1:l.push([p(h[0],h[1]),p(h[0],h[2]),p(h[0],h[3])]);break;case 13:l.push([p(h[1],h[0]),p(h[1],h[2]),p(h[1],h[3])]);break;case 2:l.push([p(h[1],h[0]),p(h[1],h[3]),p(h[1],h[2])]);break;case 12:l.push([p(h[1],h[2]),p(h[1],h[3]),p(h[0],h[3]),p(h[0],h[2])]);break;case 3:l.push([p(h[1],h[2]),p(h[0],h[2]),p(h[0],h[3]),p(h[1],h[3])]);break;case 4:l.push([p(h[2],h[0]),p(h[2],h[1]),p(h[2],h[3])]);break;case 11:l.push([p(h[2],h[0]),p(h[2],h[3]),p(h[2],h[1])]);break;case 5:l.push([p(h[0],h[1]),p(h[1],h[2]),p(h[2],h[3]),p(h[0],h[3])]);break;case 10:l.push([p(h[0],h[1]),p(h[0],h[3]),p(h[2],h[3]),p(h[1],h[2])]);break;case 6:l.push([p(h[2],h[3]),p(h[0],h[2]),p(h[0],h[1]),p(h[1],h[3])]);break;case 9:l.push([p(h[2],h[3]),p(h[1],h[3]),p(h[0],h[1]),p(h[0],h[2])]);break;case 7:l.push([p(h[3],h[0]),p(h[3],h[1]),p(h[3],h[2])]);break;case 8:l.push([p(h[3],h[0]),p(h[3],h[2]),p(h[3],h[1])])}}}return{positions:c,cells:l}}})),a=e((e=>{e.surfaceNets=n().surfaceNets,e.marchingCubes=r().marchingCubes,e.marchingTetrahedra=i().marchingTetrahedra}))();let o=typeof self>`u`?null:self,s=[[0,5,1,6],[0,1,2,6],[0,2,3,6],[0,3,7,6],[0,7,4,6],[0,4,5,6]],c=[[0,1],[1,2],[2,0],[0,3],[1,3],[2,3]],l=[[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]],u=1024,d=4e6,f=12e6,p=125e4,m=3.5;var h=class extends Error{constructor(e){super(e),this.name=`BrowserTopologyBudgetError`}};function g(e){let t=Math.max(48,Math.min(u,e));return t>160?128:t}let _=null,v=null;async function y(e){return await e.requestAdapter({powerPreference:`high-performance`})||await e.requestAdapter()||e.requestAdapter({powerPreference:`low-power`})}function b(e,t=[]){o?.postMessage(e,t)}function x(e,t,n){b({type:`progress`,requestId:e,stage:t,progress:n})}async function S(){return _??=(async()=>{let e=await fetch(t);if(!e.ok)throw Error(`无法加载 GS2Mesh WASM 不透明度核心（HTTP ${e.status}）。`);return(await WebAssembly.instantiate(await e.arrayBuffer(),{})).instance.exports})(),_}async function C(e=!1){let t=navigator.gpu;if(!t)throw Error(`当前浏览器未提供 WebGPU。`);e&&(v=null),v??=y(t);let n=await v;if(!n)throw v=null,Error(`无法取得 WebGPU 适配器。请确认浏览器已启用硬件加速和 WebGPU。`);return n}async function w(){try{return await(await C()).requestDevice()}catch(e){v=null;try{return await(await C(!0)).requestDevice()}catch{throw e}}}function T(e,t){return e.sort((e,t)=>e-t),e[Math.max(0,Math.min(e.length-1,Math.round((e.length-1)*t)))]}function E(e,t=e.fieldResolution,n=160,r){let i=e.positions.length/3,a=Math.max(1,Math.ceil(i/3e4)),o=[[],[],[]],s=[];for(let t=0;t<i;t+=a){let n=t*3;o[0].push(e.positions[n]),o[1].push(e.positions[n+1]),o[2].push(e.positions[n+2]),s.push(Math.max(e.scales[n],e.scales[n+1],e.scales[n+2]))}let c=[T(o[0],.002),T(o[1],.002),T(o[2],.002)],l=[T(o[0],.998),T(o[1],.998),T(o[2],.998)],u=T(s,.5),d=l.map((e,t)=>Math.max(1e-5,e-c[t])),f=Math.max(...d),p=Math.max(f*.025,u*2.5,1e-5),m=[c[0]-p,c[1]-p,c[2]-p],h=l.map((e,t)=>e+p-m[t]),g=Math.max(...h),_=Number.isFinite(r)&&r>0?Math.max(1e-8,r):null,v=_===null?Math.max(48,Math.min(n,t)):Math.max(48,Math.min(n,Math.max(t,Math.ceil(g/_)+1))),y=g/Math.max(1,v-1);return{minimum:m,dimensions:[Math.max(24,Math.min(v,Math.ceil(h[0]/y)+1)),Math.max(24,Math.min(v,Math.ceil(h[1]/y)+1)),Math.max(24,Math.min(v,Math.ceil(h[2]/y)+1))],spacing:y}}function D(e,t=12e3){let n=e.positions.length/3,r=Math.max(1,Math.min(n,Math.round(t)));if(r===n&&e.fieldResolution===72)return e;let i=new Set;if(n>0){let t=[0,0,0,0,0,0];for(let r=1;r<n;r+=1){let n=r*3;e.positions[n]<e.positions[t[0]*3]&&(t[0]=r),e.positions[n]>e.positions[t[1]*3]&&(t[1]=r),e.positions[n+1]<e.positions[t[2]*3+1]&&(t[2]=r),e.positions[n+1]>e.positions[t[3]*3+1]&&(t[3]=r),e.positions[n+2]<e.positions[t[4]*3+2]&&(t[4]=r),e.positions[n+2]>e.positions[t[5]*3+2]&&(t[5]=r)}for(let e of t){if(i.size>=r)break;i.add(e)}for(let e=0;i.size<r&&e<n*2;e+=1)i.add(Math.min(n-1,Math.floor((e+.5)*n/r)%n));for(let e=0;i.size<r&&e<n;e+=1)i.add(e)}let a=[...i].sort((e,t)=>e-t),o=new Float32Array(a.length*3),s=new Float32Array(a.length*4),c=new Float32Array(a.length*3),l=new Uint8Array(a.length*4),u=new Float32Array(a.length);for(let t=0;t<a.length;t+=1){let n=a[t];o.set(e.positions.subarray(n*3,n*3+3),t*3),s.set(e.rotations.subarray(n*4,n*4+4),t*4),c.set(e.scales.subarray(n*3,n*3+3),t*3),l.set(e.colors.subarray(n*4,n*4+4),t*4),u[t]=e.opacities[n]}return{...e,positions:o,rotations:s,scales:c,colors:l,opacities:u,fieldResolution:72,targetVoxelMillimeters:void 0,targetVoxelSize:void 0}}function O(e,t){let{minimum:n,dimensions:r,spacing:i}=E(e,t,e.targetVoxelSize?16384:u,e.targetVoxelSize);return{dimensions:r,brickDimensions:r.map(e=>Math.ceil((e-1)/16)),minimum:n,spacing:i,brickSize:16}}function k(e,t,n,r,i,a=0){let{brickDimensions:o,minimum:s,spacing:c}=t,l=Math.max(0,Math.min(o[2],Math.floor(n))),u=Math.max(l,Math.min(o[2],Math.ceil(r))),d=new Set,f=(e,t,n,r)=>{if(e<0||t<0||n<l||e>=o[0]||t>=o[1]||n>=o[2]||n>=u)return;let a=(n*o[1]+t)*o[0]+e;d.add(a),i?.(a,r)},p=t.brickSize*c*.5,h=m**2,g=e.positions.length/3;for(let n=0;n<g;n+=1){let r=n*3,i=e.positions[r],d=e.positions[r+1],g=e.positions[r+2],_=Math.max(1e-7,Math.hypot(e.scales[r],a)),v=Math.max(1e-7,Math.hypot(e.scales[r+1],a)),y=Math.max(1e-7,Math.hypot(e.scales[r+2],a)),b=n*4,x=e.rotations[b],S=e.rotations[b+1],C=e.rotations[b+2],w=e.rotations[b+3],T=1/Math.max(1e-12,Math.hypot(x,S,C,w)),E=x*T,D=S*T,O=C*T,k=w*T,A=1-2*(D*D+O*O),j=2*(E*D-O*k),M=2*(E*O+D*k),N=2*(E*D+O*k),P=1-2*(E*E+O*O),F=2*(D*O-E*k),I=2*(E*O-D*k),L=2*(D*O+E*k),R=1-2*(E*E+D*D),z=m*Math.hypot(A*_,j*v,M*y),B=m*Math.hypot(N*_,P*v,F*y),V=m*Math.hypot(I*_,L*v,R*y),H=(i-s[0])/c,U=(d-s[1])/c,W=(g-s[2])/c,G=Math.max(0,Math.floor((H-z/c)/t.brickSize)),K=Math.min(o[0]-1,Math.floor((H+z/c)/t.brickSize)),q=Math.max(0,Math.floor((U-B/c)/t.brickSize)),J=Math.min(o[1]-1,Math.floor((U+B/c)/t.brickSize)),Y=Math.max(l,Math.floor((W-V/c)/t.brickSize)),X=Math.min(u-1,Math.floor((W+V/c)/t.brickSize));if(G>K||q>J||Y>X)continue;let Z=p*(Math.abs(A)+Math.abs(N)+Math.abs(I))/_,Q=p*(Math.abs(j)+Math.abs(P)+Math.abs(L))/v,$=p*(Math.abs(M)+Math.abs(F)+Math.abs(R))/y;for(let e=Y;e<=X;e+=1)for(let r=q;r<=J;r+=1)for(let a=G;a<=K;a+=1){let o=s[0]+(a*t.brickSize+t.brickSize*.5)*c,l=s[1]+(r*t.brickSize+t.brickSize*.5)*c,u=s[2]+(e*t.brickSize+t.brickSize*.5)*c,p=o-i,m=l-d,b=u-g,x=(p*A+m*N+b*I)/_,S=(p*j+m*P+b*L)/v,C=(p*M+m*F+b*R)/y,w=Math.max(0,Math.abs(x)-Z),T=Math.max(0,Math.abs(S)-Q),E=Math.max(0,Math.abs(C)-$);w*w+T*T+E*E<=h&&f(a,r,e,n)}}let _=[...d].sort((e,t)=>e-t),v=new Uint32Array(_.length*4),y=o[0]*o[1];for(let e=0;e<_.length;e+=1){let n=_[e],r=Math.floor(n/y),i=n-r*y,a=Math.floor(i/o[0]),s=i-a*o[0];v.set([s*t.brickSize,a*t.brickSize,r*t.brickSize,0],e*4)}return v}function A(e,t,n,r){for(let i=0;i<r;i+=1){for(let r=0;r<n;r+=1){let a=(i*n+r)*t;e[a]=0,e[a+t-1]=0}i===0||i===r-1?e.fill(0,i*n*t,(i+1)*n*t):(e.fill(0,i*n*t,i*n*t+t),e.fill(0,(i*n+n-1)*t,(i+1)*n*t))}}function j(e,t,n){let r=t*3,i=e.scales[r],a=e.scales[r+1],o=e.scales[r+2],s=i<=a&&i<=o?0:a<=o?1:2;return[Math.min(n*8,Math.max(i,n*(s===0?.34:.62))),Math.min(n*8,Math.max(a,n*(s===1?.34:.62))),Math.min(n*8,Math.max(o,n*(s===2?.34:.62)))]}function M(e,t,n,r,i){let a=n.map(e=>Math.ceil(e/8)),o=a[0]*a[1]*a[2],s=Array.from({length:o},()=>[]),c=e.positions.length/3,l=new Float32Array(c*16);for(let n=0;n<c;n+=1){let o=n*3,c=n*4,u=e.positions[o],d=e.positions[o+1],f=e.positions[o+2],[p,m,h]=i?j(e,n,r):[Math.max(1e-7,e.scales[o]),Math.max(1e-7,e.scales[o+1]),Math.max(1e-7,e.scales[o+2])],g=e.rotations[c],_=e.rotations[c+1],v=e.rotations[c+2],y=e.rotations[c+3],b=1-2*(_*_+v*v),x=2*(g*_-v*y),S=2*(g*v+_*y),C=2*(g*_+v*y),w=1-2*(g*g+v*v),T=2*(_*v-g*y),E=2*(g*v-_*y),D=2*(_*v+g*y),O=1-2*(g*g+_*_);l.set([u,d,f,Math.max(0,Math.min(.999,e.opacities[n])),b/p,C/p,E/p,0,x/m,w/m,D/m,0,S/h,T/h,O/h,0],n*16);let k=Math.min(24,Math.max(2,Math.ceil(Math.max(p,m,h)*3/r))),A=(u-t[0])/r,M=(d-t[1])/r,N=(f-t[2])/r,P=Math.max(0,Math.floor((A-k)/8)),F=Math.min(a[0]-1,Math.floor((A+k)/8)),I=Math.max(0,Math.floor((M-k)/8)),L=Math.min(a[1]-1,Math.floor((M+k)/8)),R=Math.max(0,Math.floor((N-k)/8)),z=Math.min(a[2]-1,Math.floor((N+k)/8));for(let e=R;e<=z;e+=1)for(let t=I;t<=L;t+=1)for(let r=P;r<=F;r+=1)s[(e*a[1]+t)*a[0]+r].push(n)}let u=new Uint32Array(o+1),d=0;for(let e=0;e<o;e+=1)u[e]=d,d+=s[e].length;if(u[o]=d,d>16e6)throw Error(`WebGPU 稀疏块索引超过浏览器安全上限。`);let f=new Uint32Array(d),p=0;for(let e of s)f.set(e,p),p+=e.length;return{gaussians:l,blockOffsets:u,blockGaussianIds:f,blockDimensions:a,blockSize:8}}function N(e,t=64){let n=e.views.slice(0,16),r=n.length,i=new Float32Array(Math.max(1,r)*16),a=new Uint32Array(Math.max(1,r)*t*t);for(let e=0;e<r;e+=1){let t=n[e];i.set([...t.position,Math.max(1e-4,t.tanHalfFovX),...t.right,Math.max(1e-4,t.tanHalfFovY),...t.up,0,...t.forward,0],e*16)}let o=e.positions.length/3;for(let i=0;i<r;i+=1){let r=n[i],s=i*t*t;for(let n=0;n<o;n+=1){let i=n*3,o=e.positions[i]-r.position[0],c=e.positions[i+1]-r.position[1],l=e.positions[i+2]-r.position[2],u=o*r.forward[0]+c*r.forward[1]+l*r.forward[2];if(!(u>1e-5))continue;let d=(o*r.right[0]+c*r.right[1]+l*r.right[2])/(u*r.tanHalfFovX),f=(o*r.up[0]+c*r.up[1]+l*r.up[2])/(u*r.tanHalfFovY),p=Math.max(e.scales[i],e.scales[i+1],e.scales[i+2]),m=Math.max(1.5,p*3/(u*r.tanHalfFovX)*t*.5+1),h=Math.max(1.5,p*3/(u*r.tanHalfFovY)*t*.5+1),g=(d*.5+.5)*t,_=(f*.5+.5)*t,v=Math.max(0,Math.floor(g-m)),y=Math.min(t-1,Math.ceil(g+m)),b=Math.max(0,Math.floor(_-h)),x=Math.min(t-1,Math.ceil(_+h));for(let e=b;e<=x;e+=1)a.fill(1,s+e*t+v,s+e*t+y+1)}}return{views:i,masks:a,resolution:t,viewCount:r}}function P(e,t,n,r,i){let a=M(e,t,n,r,!1),o=Math.ceil(i/4),s=Math.ceil(i/4),c=e.views.length,l=Array.from({length:Math.max(1,c*o*s)},()=>[]),u=e.positions.length/3;for(let t=0;t<c;t+=1){let n=e.views[t];for(let r=0;r<u;r+=1){let a=r*3,c=e.positions[a]-n.position[0],u=e.positions[a+1]-n.position[1],d=e.positions[a+2]-n.position[2],f=c*n.forward[0]+u*n.forward[1]+d*n.forward[2];if(!(f>1e-5))continue;let p=(c*n.right[0]+u*n.right[1]+d*n.right[2])/(f*n.tanHalfFovX),m=(c*n.up[0]+u*n.up[1]+d*n.up[2])/(f*n.tanHalfFovY),h=Math.max(e.scales[a],e.scales[a+1],e.scales[a+2]),g=Math.max(1,h*3/(f*n.tanHalfFovX)*i*.5+1),_=Math.max(1,h*3/(f*n.tanHalfFovY)*i*.5+1),v=(p*.5+.5)*i,y=(m*.5+.5)*i,b=Math.max(0,Math.floor((v-g)/4)),x=Math.min(o-1,Math.floor((v+g)/4)),S=Math.max(0,Math.floor((y-_)/4)),C=Math.min(s-1,Math.floor((y+_)/4));for(let e=S;e<=C;e+=1)for(let n=b;n<=x;n+=1)l[(t*s+e)*o+n].push(r)}}let d=new Uint32Array(l.length+1),f=0;for(let e=0;e<l.length;e+=1)d[e]=f,f+=l[e].length;if(d[l.length]=f,f>16e6)throw Error(`WebGPU GOF 屏幕 tile 索引超过浏览器安全上限。`);let p=new Uint32Array(f),m=0;for(let e of l)p.set(e,m),m+=e.length;return{gaussians:a.gaussians,blockOffsets:d,blockGaussianIds:p,blockDimensions:[o,s,Math.max(1,c)],blockSize:4}}function F(e,t,n){let r=e.createBuffer({size:Math.max(4,Math.ceil(t.byteLength/4)*4),usage:n,mappedAtCreation:!0});return new Uint8Array(r.getMappedRange()).set(new Uint8Array(t.buffer,t.byteOffset,t.byteLength)),r.unmap(),r}async function I(e,t,n){let r=await w(),i=Math.max(48,Math.min(u,Math.round(t))),a=g(i),{minimum:o,dimensions:s,spacing:c}=E(e,a),[l,d,f]=s,p=l*d*f,m=N(e,n?256:64),h=n?P(e,o,s,c,m.resolution):M(e,o,s,c,!0),_=new ArrayBuffer(64),v=new Uint32Array(_),y=new Float32Array(_);v.set([l,d,f,e.positions.length/3],0),v.set([...h.blockDimensions,h.blockSize],4),y.set([...o,c],8),v.set([m.viewCount,m.resolution,+!!n,0],12);let b=[];try{let e=F(r,new Uint8Array(_),GPUBufferUsage.UNIFORM),t=F(r,h.gaussians,GPUBufferUsage.STORAGE),s=F(r,h.blockOffsets,GPUBufferUsage.STORAGE),u=F(r,h.blockGaussianIds,GPUBufferUsage.STORAGE),g=F(r,m.views,GPUBufferUsage.STORAGE),v=F(r,m.masks,GPUBufferUsage.STORAGE),y=r.createBuffer({size:p*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC}),x=r.createBuffer({size:p*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC}),S=r.createBuffer({size:p*4,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),C=r.createBuffer({size:p*4,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});b.push(e,t,s,u,g,v,y,x,S,C);let w=r.createShaderModule({code:`
struct Params {
  dims: vec4<u32>,
  blockDims: vec4<u32>,
  minimumSpacing: vec4<f32>,
  visual: vec4<u32>,
};
struct Gaussian {
  centerOpacity: vec4<f32>,
  inverse0: vec4<f32>,
  inverse1: vec4<f32>,
  inverse2: vec4<f32>,
};
struct View {
  positionTanX: vec4<f32>,
  rightTanY: vec4<f32>,
  up: vec4<f32>,
  forward: vec4<f32>,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> gaussians: array<Gaussian>;
@group(0) @binding(2) var<storage, read> blockOffsets: array<u32>;
@group(0) @binding(3) var<storage, read> blockGaussianIds: array<u32>;
@group(0) @binding(4) var<storage, read> views: array<View>;
@group(0) @binding(5) var<storage, read> hullMasks: array<u32>;
@group(0) @binding(6) var<storage, read_write> field: array<f32>;
@group(0) @binding(7) var<storage, read_write> winners: array<u32>;

fn insideVisualHull(point: vec3<f32>) -> bool {
  for (var viewId = 0u; viewId < params.visual.x; viewId += 1u) {
    let view = views[viewId];
    let relative = point - view.positionTanX.xyz;
    let depth = dot(relative, view.forward.xyz);
    if (depth <= 0.00001) { return false; }
    let nx = dot(relative, view.rightTanY.xyz) / (depth * view.positionTanX.w);
    let ny = dot(relative, view.up.xyz) / (depth * view.rightTanY.w);
    if (abs(nx) > 1.0 || abs(ny) > 1.0) { return false; }
    let resolution = params.visual.y;
    let px = min(resolution - 1u, u32((nx * 0.5 + 0.5) * f32(resolution)));
    let py = min(resolution - 1u, u32((ny * 0.5 + 0.5) * f32(resolution)));
    let maskIndex = viewId * resolution * resolution + py * resolution + px;
    if (hullMasks[maskIndex] == 0u) { return false; }
  }
  return true;
}

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (any(id >= params.dims.xyz)) { return; }
  let outputIndex = (id.z * params.dims.y + id.y) * params.dims.x + id.x;
  let point = params.minimumSpacing.xyz + vec3<f32>(id) * params.minimumSpacing.w;
  if (!insideVisualHull(point)) {
    field[outputIndex] = 0.0;
    winners[outputIndex] = 0u;
    return;
  }
  if (params.visual.z == 1u && params.visual.x > 0u) {
    var minimumViewOpacity = 1.0;
    var gofBestContribution = 0.0;
    var gofWinner = 0u;
    for (var viewId = 0u; viewId < params.visual.x; viewId += 1u) {
      let view = views[viewId];
      let rayVector = point - view.positionTanX.xyz;
      let pointDistance = length(rayVector);
      let rayDirection = rayVector / max(0.000001, pointDistance);
      let depth = dot(rayVector, view.forward.xyz);
      let nx = dot(rayVector, view.rightTanY.xyz) / (depth * view.positionTanX.w);
      let ny = dot(rayVector, view.up.xyz) / (depth * view.rightTanY.w);
      let pixelX = min(params.visual.y - 1u, u32((nx * 0.5 + 0.5) * f32(params.visual.y)));
      let pixelY = min(params.visual.y - 1u, u32((ny * 0.5 + 0.5) * f32(params.visual.y)));
      let tileX = pixelX / params.blockDims.w;
      let tileY = pixelY / params.blockDims.w;
      let tileIndex = (viewId * params.blockDims.y + tileY) * params.blockDims.x + tileX;
      let begin = blockOffsets[tileIndex];
      let end = blockOffsets[tileIndex + 1u];
      var viewTransmittance = 1.0;
      for (var gofCursor = begin; gofCursor < end; gofCursor += 1u) {
        let gaussianId = blockGaussianIds[gofCursor];
        let gaussian = gaussians[gaussianId];
        let originDelta = view.positionTanX.xyz - gaussian.centerOpacity.xyz;
        let originLocal = vec3<f32>(
          dot(originDelta, gaussian.inverse0.xyz),
          dot(originDelta, gaussian.inverse1.xyz),
          dot(originDelta, gaussian.inverse2.xyz)
        );
        let rayLocal = vec3<f32>(
          dot(rayDirection, gaussian.inverse0.xyz),
          dot(rayDirection, gaussian.inverse1.xyz),
          dot(rayDirection, gaussian.inverse2.xyz)
        );
        let denominator = max(0.0000001, dot(rayLocal, rayLocal));
        let peakDistance = clamp(-dot(originLocal, rayLocal) / denominator, 0.0, pointDistance);
        let evaluation = originLocal + rayLocal * peakDistance;
        let contribution = gaussian.centerOpacity.w * exp(-0.5 * dot(evaluation, evaluation));
        viewTransmittance *= 1.0 - contribution;
        let pointDelta = point - gaussian.centerOpacity.xyz;
        let pointLocal = vec3<f32>(
          dot(pointDelta, gaussian.inverse0.xyz),
          dot(pointDelta, gaussian.inverse1.xyz),
          dot(pointDelta, gaussian.inverse2.xyz)
        );
        let pointContribution = gaussian.centerOpacity.w * exp(-0.5 * dot(pointLocal, pointLocal));
        if (pointContribution > gofBestContribution) {
          gofBestContribution = pointContribution;
          gofWinner = gaussianId;
        }
      }
      minimumViewOpacity = min(minimumViewOpacity, 1.0 - viewTransmittance);
    }
    field[outputIndex] = minimumViewOpacity;
    winners[outputIndex] = gofWinner;
    return;
  }
  let block = id / params.blockDims.www;
  let blockIndex = (block.z * params.blockDims.y + block.y) * params.blockDims.x + block.x;
  let begin = blockOffsets[blockIndex];
  let end = blockOffsets[blockIndex + 1u];
  var transmittance = 1.0;
  var bestContribution = 0.0;
  var winner = 0u;
  for (var cursor = begin; cursor < end; cursor += 1u) {
    let gaussianId = blockGaussianIds[cursor];
    let gaussian = gaussians[gaussianId];
    let delta = point - gaussian.centerOpacity.xyz;
    let local = vec3<f32>(
      dot(delta, gaussian.inverse0.xyz),
      dot(delta, gaussian.inverse1.xyz),
      dot(delta, gaussian.inverse2.xyz)
    );
    let radiusSquared = dot(local, local);
    if (radiusSquared <= 9.0) {
      let contribution = gaussian.centerOpacity.w * exp(-0.5 * radiusSquared);
      transmittance *= 1.0 - contribution;
      if (contribution > bestContribution) {
        bestContribution = contribution;
        winner = gaussianId;
      }
    }
  }
  field[outputIndex] = 1.0 - transmittance;
  winners[outputIndex] = winner;
}`}),T=(await w.getCompilationInfo()).messages.filter(e=>e.type===`error`);if(T.length)throw Error(`WebGPU shader 编译失败：${T[0].message}`);let E=r.createComputePipeline({layout:`auto`,compute:{module:w,entryPoint:`main`}}),D=r.createBindGroup({layout:E.getBindGroupLayout(0),entries:[e,t,s,u,g,v,y,x].map((e,t)=>({binding:t,resource:{buffer:e}}))}),O=r.createCommandEncoder(),k=O.beginComputePass();k.setPipeline(E),k.setBindGroup(0,D),k.dispatchWorkgroups(Math.ceil(l/4),Math.ceil(d/4),Math.ceil(f/4)),k.end(),O.copyBufferToBuffer(y,0,S,0,p*4),O.copyBufferToBuffer(x,0,C,0,p*4),r.queue.submit([O.finish()]),await Promise.all([S.mapAsync(GPUMapMode.READ),C.mapAsync(GPUMapMode.READ)]);let j=new Float32Array(S.getMappedRange()).slice(),M=new Uint32Array(C.getMappedRange()).slice();return S.unmap(),C.unmap(),A(j,l,d,f),{field:j,winner:M,dimX:l,dimY:d,dimZ:f,minimum:o,spacing:c,backend:n?`WebGPU GOF ${i}³-equivalent sparse field (${a}³ topology) + Marching Tetrahedra`:`WebGPU Sparse Oriented Occupancy + Visual Hull + Marching Cubes`}}finally{for(let e of b)e.destroy();r.destroy()}}async function L(e,t,n){let r=O(e,t),i=await w(),a=N(e,256),o=E(e,128),s=P(e,o.minimum,o.dimensions,o.spacing,a.resolution),c=r.brickSize+1,l=c**3,u=24*l*8,f=[],m=[],g=[],_=[],v=[],y=new Map,b=0,S=1/Math.max(1e-10,r.spacing*1e-4),C=e=>{let t=new Int32Array(e.mesh.positions.length/3);t.fill(-1);let n=n=>{let r=t[n];if(r>=0)return r;let i=n*3,a=`${Math.round(e.mesh.positions[i]*S)},${Math.round(e.mesh.positions[i+1]*S)},${Math.round(e.mesh.positions[i+2]*S)}`,o=y.get(a);if(o!==void 0)return t[n]=o,o;let s=m.length/3;t[n]=s,y.set(a,s),m.push(e.mesh.positions[i],e.mesh.positions[i+1],e.mesh.positions[i+2]);let c=n*4;g.push(e.mesh.colors[c],e.mesh.colors[c+1],e.mesh.colors[c+2],255);let l=n*6;return v.push(e.brackets[l],e.brackets[l+1],e.brackets[l+2],e.brackets[l+3],e.brackets[l+4],e.brackets[l+5]),s};for(let t=0;t<e.mesh.indices.length;t+=3){let r=n(e.mesh.indices[t]),i=n(e.mesh.indices[t+1]),a=n(e.mesh.indices[t+2]);r!==i&&i!==a&&a!==r&&_.push(r,i,a)}if(_.length/3>p)throw new h(`精细 GOF 表面超过浏览器安全内存预算（125 万三角形）。已保留快速预览；请改用 2 mm 或 40K Gaussian。`);if(_.length/3>d)throw Error(`活动分区生成的三角形超过 400 万，请降低不透明度场精度。`)};try{let t=i.createBuffer({size:80,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),o=F(i,s.gaussians,GPUBufferUsage.STORAGE),d=F(i,s.blockOffsets,GPUBufferUsage.STORAGE),p=F(i,s.blockGaussianIds,GPUBufferUsage.STORAGE),h=F(i,a.views,GPUBufferUsage.STORAGE),y=F(i,a.masks,GPUBufferUsage.STORAGE),S=i.createBuffer({size:384,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}),w=i.createBuffer({size:u,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC}),T=i.createBuffer({size:u,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});f.push(t,o,d,p,h,y,S,w,T);let E=i.createShaderModule({code:`
struct Params {
  volumeDims: vec4<u32>,
  batch: vec4<u32>,
  tile: vec4<u32>,
  minimumSpacing: vec4<f32>,
  visual: vec4<u32>,
};
struct Gaussian {
  centerOpacity: vec4<f32>,
  inverse0: vec4<f32>,
  inverse1: vec4<f32>,
  inverse2: vec4<f32>,
};
struct View {
  positionTanX: vec4<f32>,
  rightTanY: vec4<f32>,
  up: vec4<f32>,
  forward: vec4<f32>,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> gaussians: array<Gaussian>;
@group(0) @binding(2) var<storage, read> tileOffsets: array<u32>;
@group(0) @binding(3) var<storage, read> tileGaussianIds: array<u32>;
@group(0) @binding(4) var<storage, read> views: array<View>;
@group(0) @binding(5) var<storage, read> hullMasks: array<u32>;
@group(0) @binding(6) var<storage, read> brickOrigins: array<vec4<u32>>;
@group(0) @binding(7) var<storage, read_write> output: array<vec2<f32>>;

fn insideVisualHull(point: vec3<f32>) -> bool {
  for (var viewId = 0u; viewId < params.visual.x; viewId += 1u) {
    let view = views[viewId];
    let relative = point - view.positionTanX.xyz;
    let depth = dot(relative, view.forward.xyz);
    if (depth <= 0.00001) { return false; }
    let nx = dot(relative, view.rightTanY.xyz) / (depth * view.positionTanX.w);
    let ny = dot(relative, view.up.xyz) / (depth * view.rightTanY.w);
    if (abs(nx) > 1.0 || abs(ny) > 1.0) { return false; }
    let resolution = params.visual.y;
    let px = min(resolution - 1u, u32((nx * 0.5 + 0.5) * f32(resolution)));
    let py = min(resolution - 1u, u32((ny * 0.5 + 0.5) * f32(resolution)));
    if (hullMasks[viewId * resolution * resolution + py * resolution + px] == 0u) { return false; }
  }
  return true;
}

@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let pointsPerBrick = params.batch.z * params.batch.z * params.batch.z;
  let pointId = id.x;
  if (pointId >= params.batch.x * pointsPerBrick) { return; }
  let brickId = pointId / pointsPerBrick;
  let localId = pointId - brickId * pointsPerBrick;
  let localZ = localId / (params.batch.z * params.batch.z);
  let remainder = localId - localZ * params.batch.z * params.batch.z;
  let localY = remainder / params.batch.z;
  let localX = remainder - localY * params.batch.z;
  let globalId = brickOrigins[brickId].xyz + vec3<u32>(localX, localY, localZ);
  if (any(globalId >= params.volumeDims.xyz)
      || any(globalId == vec3<u32>(0u))
      || any(globalId >= params.volumeDims.xyz - vec3<u32>(1u))) {
    output[pointId] = vec2<f32>(0.0, bitcast<f32>(0u));
    return;
  }
  let point = params.minimumSpacing.xyz + vec3<f32>(globalId) * params.minimumSpacing.w;
  if (!insideVisualHull(point) || params.visual.x == 0u) {
    output[pointId] = vec2<f32>(0.0, bitcast<f32>(0u));
    return;
  }
  var minimumViewOpacity = 1.0;
  var bestPointContribution = 0.0;
  var winner = 0u;
  for (var viewId = 0u; viewId < params.visual.x; viewId += 1u) {
    let view = views[viewId];
    let rayVector = point - view.positionTanX.xyz;
    let pointDistance = length(rayVector);
    let rayDirection = rayVector / max(0.000001, pointDistance);
    let depth = dot(rayVector, view.forward.xyz);
    let nx = dot(rayVector, view.rightTanY.xyz) / (depth * view.positionTanX.w);
    let ny = dot(rayVector, view.up.xyz) / (depth * view.rightTanY.w);
    let pixelX = min(params.visual.y - 1u, u32((nx * 0.5 + 0.5) * f32(params.visual.y)));
    let pixelY = min(params.visual.y - 1u, u32((ny * 0.5 + 0.5) * f32(params.visual.y)));
    let tileX = pixelX / params.tile.z;
    let tileY = pixelY / params.tile.z;
    let tileIndex = (viewId * params.tile.y + tileY) * params.tile.x + tileX;
    let begin = tileOffsets[tileIndex];
    let end = tileOffsets[tileIndex + 1u];
    var transmittance = 1.0;
    for (var cursor = begin; cursor < end; cursor += 1u) {
      let gaussianId = tileGaussianIds[cursor];
      let gaussian = gaussians[gaussianId];
      let originDelta = view.positionTanX.xyz - gaussian.centerOpacity.xyz;
      let originLocal = vec3<f32>(
        dot(originDelta, gaussian.inverse0.xyz),
        dot(originDelta, gaussian.inverse1.xyz),
        dot(originDelta, gaussian.inverse2.xyz)
      );
      let rayLocal = vec3<f32>(
        dot(rayDirection, gaussian.inverse0.xyz),
        dot(rayDirection, gaussian.inverse1.xyz),
        dot(rayDirection, gaussian.inverse2.xyz)
      );
      let denominator = max(0.0000001, dot(rayLocal, rayLocal));
      let peakDistance = clamp(-dot(originLocal, rayLocal) / denominator, 0.0, pointDistance);
      let evaluation = originLocal + rayLocal * peakDistance;
      let contribution = gaussian.centerOpacity.w * exp(-0.5 * dot(evaluation, evaluation));
      transmittance *= 1.0 - contribution;
      let pointDelta = point - gaussian.centerOpacity.xyz;
      let pointLocal = vec3<f32>(
        dot(pointDelta, gaussian.inverse0.xyz),
        dot(pointDelta, gaussian.inverse1.xyz),
        dot(pointDelta, gaussian.inverse2.xyz)
      );
      let pointContribution = gaussian.centerOpacity.w * exp(-0.5 * dot(pointLocal, pointLocal));
      if (pointContribution > bestPointContribution) {
        bestPointContribution = pointContribution;
        winner = gaussianId;
      }
    }
    minimumViewOpacity = min(minimumViewOpacity, 1.0 - transmittance);
  }
  output[pointId] = vec2<f32>(minimumViewOpacity, bitcast<f32>(winner));
}`}),D=(await E.getCompilationInfo()).messages.filter(e=>e.type===`error`);if(D.length)throw Error(`分区 GOF shader 编译失败：${D[0].message}`);let O=i.createComputePipeline({layout:`auto`,compute:{module:E,entryPoint:`main`}}),A=i.createBindGroup({layout:O.getBindGroupLayout(0),entries:[t,o,d,p,h,y,S,w].map((e,t)=>({binding:t,resource:{buffer:e}}))}),j=r.brickDimensions[2];for(let o=0;o<j;o+=1){let u=Math.min(j,o+1),d=k(e,r,o,u),f=d.length/4;b+=f;for(let p=0;p<f;p+=24){let m=Math.min(24,f-p),h=m*l,g=h*8,_=new ArrayBuffer(80),v=new Uint32Array(_),y=new Float32Array(_);v.set([...r.dimensions,0],0),v.set([m,r.brickSize,c,h],4),v.set([s.blockDimensions[0],s.blockDimensions[1],s.blockSize,0],8),y.set([...r.minimum,r.spacing],12),v.set([a.viewCount,a.resolution,0,0],16),i.queue.writeBuffer(t,0,_),i.queue.writeBuffer(S,0,d.subarray(p*4,(p+m)*4));let b=i.createCommandEncoder(),E=b.beginComputePass();E.setPipeline(O),E.setBindGroup(0,A),E.dispatchWorkgroups(Math.ceil(h/128)),E.end(),b.copyBufferToBuffer(w,0,T,0,g),i.queue.submit([b.finish()]),await T.mapAsync(GPUMapMode.READ,0,g);let D=new Uint32Array(T.getMappedRange(0,g)).slice();T.unmap();let k=new Float32Array(D.buffer);for(let t=0;t<m;t+=1){let i=new Float32Array(l),a=new Uint32Array(l),o=t*l*2;for(let e=0;e<l;e+=1)i[e]=k[o+e*2],a[e]=D[o+e*2+1];let s=(p+t)*4,u=d[s],f=d[s+1],m=d[s+2],h=$({field:i,winner:a,dimX:c,dimY:c,dimZ:c,minimum:[r.minimum[0]+u*r.spacing,r.minimum[1]+f*r.spacing,r.minimum[2]+m*r.spacing],spacing:r.spacing},e,n,!1,!1,!1);h.mesh.indices.length&&C(h)}x(n,`fusing`,(o+(u-o)*(p+m)/Math.max(1,f))/j*.82),await new Promise(e=>setTimeout(e,0))}f||x(n,`fusing`,u/j*.82)}if(!b)throw Error(`当前帧没有可计算的非空 GOF 分区。`);let M=U(m,g,_,v);if(M.indices.length<30)throw Error(`分区 GOF 没有提取到足够的连续表面。`);let N=Float32Array.from(M.positions),P=Uint32Array.from(M.indices),I=Math.max(...r.dimensions),L=e.sceneUnitMillimeters?` / ${(r.spacing*e.sceneUnitMillimeters).toFixed(3)} mm leaf`:``;return{mesh:{positions:N,normals:W(N,P),colors:Uint8Array.from(M.colors),indices:P},brackets:Float32Array.from(M.brackets),spacing:r.spacing,activeBrickCount:b,backend:`WebGPU GOF ${I}³ virtual${L}, streamed sparse 16³ bricks (${b.toLocaleString()} active, 1 Z layer registry, 24/GPU batch) + welded Marching Tetrahedra`}}finally{for(let e of f)e.destroy();i.destroy()}}function R(e,t,n,r,i,a){if(!a.viewCount)return;let o=i*i;for(let s=0;s<e.length;s+=1){if(!(e[s]>0))continue;let c=Math.floor(s/o),l=s-c*o,u=Math.floor(l/i),d=l-u*i,f=n[0]+d*r,p=n[1]+u*r,m=n[2]+c*r,h=!0;for(let e=0;e<a.viewCount;e+=1){let t=e*16,n=f-a.views[t],r=p-a.views[t+1],i=m-a.views[t+2],o=n*a.views[t+12]+r*a.views[t+13]+i*a.views[t+14];if(!(o>1e-5)){h=!1;break}let s=(n*a.views[t+4]+r*a.views[t+5]+i*a.views[t+6])/(o*a.views[t+3]),c=(n*a.views[t+8]+r*a.views[t+9]+i*a.views[t+10])/(o*a.views[t+7]);if(Math.abs(s)>1||Math.abs(c)>1){h=!1;break}let l=Math.min(a.resolution-1,Math.max(0,Math.floor((s*.5+.5)*a.resolution))),u=Math.min(a.resolution-1,Math.max(0,Math.floor((c*.5+.5)*a.resolution)));if(!a.masks[(e*a.resolution+u)*a.resolution+l]){h=!1;break}}h||(e[s]=0,t[s]=0)}}async function z(e,t,n,r){let i=O(t,n),a=N(t,128),o=i.brickSize+1,s=o**3,c=i.spacing*1.5;e.reset();let l=e.alloc(s*Float32Array.BYTES_PER_ELEMENT),u=e.alloc(s*Float32Array.BYTES_PER_ELEMENT),d=e.alloc(s*Uint32Array.BYTES_PER_ELEMENT),m=new Float32Array(e.memory.buffer,l,s),g=new Float32Array(e.memory.buffer,u,s),_=new Uint32Array(e.memory.buffer,d,s),v=[],y=[],b=[],S=[],C=new Map,w=1e-4,T=1/Math.max(1e-10,i.spacing*w),E=0,D=e=>{let t=[],n=[],r=[],a=new Map,o=new Uint32Array(S.length),s=1/Math.max(1e-10,i.spacing*e);for(let e=0;e<S.length;e+=1){let i=Math.max(1,S[e]),c=e*3,l=e*4,u=v[c]/i,d=v[c+1]/i,f=v[c+2]/i,p=`${Math.round(u*s)},${Math.round(d*s)},${Math.round(f*s)}`,m=a.get(p);m===void 0&&(m=r.length,a.set(p,m),t.push(0,0,0),n.push(0,0,0,0),r.push(0)),o[e]=m,t[m*3]+=u*i,t[m*3+1]+=d*i,t[m*3+2]+=f*i,n[m*4]+=y[l],n[m*4+1]+=y[l+1],n[m*4+2]+=y[l+2],n[m*4+3]+=255*i,r[m]+=i}let c=[];for(let e=0;e<b.length;e+=3){let t=o[b[e]],n=o[b[e+1]],r=o[b[e+2]];t!==n&&n!==r&&r!==t&&c.push(t,n,r)}v=t,y=n,b=c,S=r,C=a,w=e,T=s},A=e=>{let t=new Int32Array(e.positions.length/3);t.fill(-1);let n=n=>{let r=t[n];if(r>=0)return r;let i=n*3,a=`${Math.round(e.positions[i]*T)},${Math.round(e.positions[i+1]*T)},${Math.round(e.positions[i+2]*T)}`,o=C.get(a);if(o!==void 0)return t[n]=o,S[o]+=1,v[o*3]+=e.positions[i],v[o*3+1]+=e.positions[i+1],v[o*3+2]+=e.positions[i+2],y[o*4]+=e.colors[n*4],y[o*4+1]+=e.colors[n*4+1],y[o*4+2]+=e.colors[n*4+2],y[o*4+3]+=255,o;let s=v.length/3;t[n]=s,C.set(a,s),v.push(e.positions[i],e.positions[i+1],e.positions[i+2]);let c=n*4;return y.push(e.colors[c],e.colors[c+1],e.colors[c+2],255),S.push(1),s};for(let t=0;t<e.indices.length;t+=3){let r=n(e.indices[t]),i=n(e.indices[t+1]),a=n(e.indices[t+2]);r!==i&&i!==a&&a!==r&&b.push(r,i,a)}if(b.length/3>p)throw new h(`WASM 精细表面超过浏览器安全内存预算（125 万三角形）。已保留快速预览；请改用 2 mm 或 40K Gaussian。`);if(b.length/3>1e7&&w<4&&D(w<1?2:w*2),b.length/3>f*1.5)throw Error(`WASM 流式 Marching Cubes 的中间三角形超过 1,800 万，浏览器内存不足以安全完成最终连通分量过滤。`)},j=i.brickDimensions[2];for(let n=0;n<j;n+=1){let s=Math.min(j,n+1),f=new Map,p=k(t,i,n,s,(e,t)=>{let n=f.get(e);n?n.push(t):f.set(e,[t])},c),h=p.length/4;E+=h;for(let n=0;n<h;n+=1){m.fill(0),g.fill(0),_.fill(0);let r=n*4,s=p[r],h=p[r+1],v=p[r+2],y=s/i.brickSize,b=h/i.brickSize,x=(v/i.brickSize*i.brickDimensions[1]+b)*i.brickDimensions[0]+y,S=[i.minimum[0]+s*i.spacing,i.minimum[1]+h*i.spacing,i.minimum[2]+v*i.spacing];for(let n of f.get(x)??[]){let r=n*3,a=n*4,s=(t.positions[r]-S[0])/i.spacing,f=(t.positions[r+1]-S[1])/i.spacing,p=(t.positions[r+2]-S[2])/i.spacing,m=Math.max(1e-7,Math.hypot(t.scales[r],c)),h=Math.max(1e-7,Math.hypot(t.scales[r+1],c)),g=Math.max(1e-7,Math.hypot(t.scales[r+2],c)),_=t.rotations[a],v=t.rotations[a+1],y=t.rotations[a+2],b=t.rotations[a+3],x=1/Math.max(1e-12,Math.hypot(_,v,y,b)),C=_*x,w=v*x,T=y*x,E=b*x,D=1-2*(w*w+T*T),O=2*(C*w-T*E),k=2*(C*T+w*E),A=2*(C*w+T*E),j=1-2*(C*C+T*T),M=2*(w*T-C*E),N=2*(C*T-w*E),P=2*(w*T+C*E),F=1-2*(C*C+w*w),I=3*Math.hypot(D*m,O*h,k*g)/i.spacing,L=3*Math.hypot(A*m,j*h,M*g)/i.spacing,R=3*Math.hypot(N*m,P*h,F*g)/i.spacing,z=Math.max(0,Math.floor(s-I)),B=Math.min(o-1,Math.ceil(s+I)),V=Math.max(0,Math.floor(f-L)),H=Math.min(o-1,Math.ceil(f+L)),U=Math.max(0,Math.floor(p-R)),W=Math.min(o-1,Math.ceil(p+R));z>B||V>H||U>W||e.opacity_splat(l,u,d,o,o,z,B,V,H,U,W,s,f,p,D*i.spacing/m,A*i.spacing/m,N*i.spacing/m,O*i.spacing/h,j*i.spacing/h,P*i.spacing/h,k*i.spacing/g,M*i.spacing/g,F*i.spacing/g,t.opacities[n],n)}R(m,_,S,i.spacing,o,a);let C=Z({field:m,winner:_,dimX:o,dimY:o,dimZ:o,minimum:S,spacing:i.spacing},t);C.indices.length&&A(C),(n&7)==7&&await new Promise(e=>setTimeout(e,0))}x(r,`fusing`,s/Math.max(1,j)*.82),await new Promise(e=>setTimeout(e,0))}if(!E)throw Error(`当前帧没有可计算的非空 WASM 分区。`);for(let e=0;e<S.length;e+=1){let t=Math.max(1,S[e]);v[e*3]/=t,v[e*3+1]/=t,v[e*3+2]/=t,y[e*4]=Math.round(y[e*4]/t),y[e*4+1]=Math.round(y[e*4+1]/t),y[e*4+2]=Math.round(y[e*4+2]/t),y[e*4+3]=255}let M=U(v,y,b);if(M.indices.length<30)throw Error(`WASM 分区不透明度场没有提取到足够的连续表面。`);if(M.indices.length/3>f)throw Error(`WASM 最终有效表面超过 1,200 万三角形，请改用更大的目标叶子体素。`);let P=Float32Array.from(M.positions),F=Uint32Array.from(M.indices),I=Math.max(...i.dimensions),L=t.sceneUnitMillimeters?` / ${(i.spacing*t.sceneUnitMillimeters).toFixed(3)} mm leaf`:``;return{mesh:{positions:P,normals:W(P,F),colors:Uint8Array.from(M.colors),indices:F},brackets:new Float32Array,spacing:i.spacing,activeBrickCount:E,backend:`WASM Gaussian alpha wrap ${I}³ virtual${L}, 1.5-voxel anisotropic envelope, streamed sparse 16³ bricks (${E.toLocaleString()} active, 1 Z layer registry) + Visual Hull + welded standard Marching Cubes${w>=1?` + adaptive ${w} voxel vertex clustering`:``}`}}async function B(e,t,n=8){let r=t.mesh.positions.length/3;if(t.brackets.length!==r*6)throw Error(`GOF 高精度回投缺少完整的等值面交边。`);let i=await w(),{minimum:a,dimensions:o,spacing:s}=E(e,g(e.fieldResolution)),c=N(e,256),l=P(e,a,o,s,c.resolution),u=Math.min(65536,Math.max(1,r)),d=new Float32Array(r*3),f=[];try{let a=i.createBuffer({size:48,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),o=F(i,l.gaussians,GPUBufferUsage.STORAGE),s=F(i,l.blockOffsets,GPUBufferUsage.STORAGE),p=F(i,l.blockGaussianIds,GPUBufferUsage.STORAGE),m=F(i,c.views,GPUBufferUsage.STORAGE),h=F(i,c.masks,GPUBufferUsage.STORAGE),g=i.createBuffer({size:u*32,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}),_=i.createBuffer({size:u*16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC}),v=i.createBuffer({size:u*16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});f.push(a,o,s,p,m,h,g,_,v);let y=i.createShaderModule({code:`
struct Params {
  counts: vec4<u32>,
  tile: vec4<u32>,
  surface: vec4<f32>,
};
struct Gaussian {
  centerOpacity: vec4<f32>,
  inverse0: vec4<f32>,
  inverse1: vec4<f32>,
  inverse2: vec4<f32>,
};
struct View {
  positionTanX: vec4<f32>,
  rightTanY: vec4<f32>,
  up: vec4<f32>,
  forward: vec4<f32>,
};
struct Bracket {
  first: vec4<f32>,
  second: vec4<f32>,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> gaussians: array<Gaussian>;
@group(0) @binding(2) var<storage, read> tileOffsets: array<u32>;
@group(0) @binding(3) var<storage, read> tileGaussianIds: array<u32>;
@group(0) @binding(4) var<storage, read> views: array<View>;
@group(0) @binding(5) var<storage, read> hullMasks: array<u32>;
@group(0) @binding(6) var<storage, read> brackets: array<Bracket>;
@group(0) @binding(7) var<storage, read_write> refinedPositions: array<vec4<f32>>;

fn insideVisualHull(point: vec3<f32>) -> bool {
  for (var viewId = 0u; viewId < params.counts.y; viewId += 1u) {
    let view = views[viewId];
    let relative = point - view.positionTanX.xyz;
    let depth = dot(relative, view.forward.xyz);
    if (depth <= 0.00001) { return false; }
    let nx = dot(relative, view.rightTanY.xyz) / (depth * view.positionTanX.w);
    let ny = dot(relative, view.up.xyz) / (depth * view.rightTanY.w);
    if (abs(nx) > 1.0 || abs(ny) > 1.0) { return false; }
    let pixelX = min(params.counts.z - 1u, u32((nx * 0.5 + 0.5) * f32(params.counts.z)));
    let pixelY = min(params.counts.z - 1u, u32((ny * 0.5 + 0.5) * f32(params.counts.z)));
    let maskIndex = viewId * params.counts.z * params.counts.z + pixelY * params.counts.z + pixelX;
    if (hullMasks[maskIndex] == 0u) { return false; }
  }
  return true;
}

fn gofOpacity(point: vec3<f32>) -> f32 {
  if (!insideVisualHull(point) || params.counts.y == 0u) { return 0.0; }
  var minimumViewOpacity = 1.0;
  for (var viewId = 0u; viewId < params.counts.y; viewId += 1u) {
    let view = views[viewId];
    let rayVector = point - view.positionTanX.xyz;
    let pointDistance = length(rayVector);
    let rayDirection = rayVector / max(0.000001, pointDistance);
    let depth = dot(rayVector, view.forward.xyz);
    let nx = dot(rayVector, view.rightTanY.xyz) / (depth * view.positionTanX.w);
    let ny = dot(rayVector, view.up.xyz) / (depth * view.rightTanY.w);
    let pixelX = min(params.counts.z - 1u, u32((nx * 0.5 + 0.5) * f32(params.counts.z)));
    let pixelY = min(params.counts.z - 1u, u32((ny * 0.5 + 0.5) * f32(params.counts.z)));
    let tileX = pixelX / params.tile.z;
    let tileY = pixelY / params.tile.z;
    let tileIndex = (viewId * params.tile.y + tileY) * params.tile.x + tileX;
    let begin = tileOffsets[tileIndex];
    let end = tileOffsets[tileIndex + 1u];
    var transmittance = 1.0;
    for (var cursor = begin; cursor < end; cursor += 1u) {
      let gaussian = gaussians[tileGaussianIds[cursor]];
      let originDelta = view.positionTanX.xyz - gaussian.centerOpacity.xyz;
      let originLocal = vec3<f32>(
        dot(originDelta, gaussian.inverse0.xyz),
        dot(originDelta, gaussian.inverse1.xyz),
        dot(originDelta, gaussian.inverse2.xyz)
      );
      let rayLocal = vec3<f32>(
        dot(rayDirection, gaussian.inverse0.xyz),
        dot(rayDirection, gaussian.inverse1.xyz),
        dot(rayDirection, gaussian.inverse2.xyz)
      );
      let denominator = max(0.0000001, dot(rayLocal, rayLocal));
      let peakDistance = clamp(-dot(originLocal, rayLocal) / denominator, 0.0, pointDistance);
      let evaluation = originLocal + rayLocal * peakDistance;
      let contribution = gaussian.centerOpacity.w * exp(-0.5 * dot(evaluation, evaluation));
      transmittance *= 1.0 - contribution;
    }
    minimumViewOpacity = min(minimumViewOpacity, 1.0 - transmittance);
  }
  return minimumViewOpacity;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let vertexId = id.x;
  if (vertexId >= params.counts.x) { return; }
  var first = brackets[vertexId].first.xyz;
  var second = brackets[vertexId].second.xyz;
  let firstInside = gofOpacity(first) >= params.surface.x;
  let secondInside = gofOpacity(second) >= params.surface.x;
  if (firstInside == secondInside) {
    refinedPositions[vertexId] = vec4<f32>((first + second) * 0.5, 1.0);
    return;
  }
  for (var iteration = 0u; iteration < params.counts.w; iteration += 1u) {
    let middle = (first + second) * 0.5;
    let middleInside = gofOpacity(middle) >= params.surface.x;
    if (middleInside == firstInside) {
      first = middle;
    } else {
      second = middle;
    }
  }
  refinedPositions[vertexId] = vec4<f32>((first + second) * 0.5, 1.0);
}`}),b=(await y.getCompilationInfo()).messages.filter(e=>e.type===`error`);if(b.length)throw Error(`GOF 高精度 shader 编译失败：${b[0].message}`);let x=i.createComputePipeline({layout:`auto`,compute:{module:y,entryPoint:`main`}}),S=i.createBindGroup({layout:x.getBindGroupLayout(0),entries:[a,o,s,p,m,h,g,_].map((e,t)=>({binding:t,resource:{buffer:e}}))});for(let o=0;o<r;o+=u){let s=Math.min(u,r-o),f=new Float32Array(s*8);for(let e=0;e<s;e+=1){let n=(o+e)*6,r=e*8;f.set(t.brackets.subarray(n,n+3),r),f.set(t.brackets.subarray(n+3,n+6),r+4)}let p=new ArrayBuffer(48),m=new Uint32Array(p),h=new Float32Array(p);m.set([s,c.viewCount,c.resolution,Math.max(1,Math.min(8,n))],0),m.set([l.blockDimensions[0],l.blockDimensions[1],l.blockSize,0],4),h.set([e.isoLevel,0,0,0],8),i.queue.writeBuffer(a,0,p),i.queue.writeBuffer(g,0,f);let y=i.createCommandEncoder(),b=y.beginComputePass();b.setPipeline(x),b.setBindGroup(0,S),b.dispatchWorkgroups(Math.ceil(s/64)),b.end(),y.copyBufferToBuffer(_,0,v,0,s*16),i.queue.submit([y.finish()]),await v.mapAsync(GPUMapMode.READ,0,s*16);let C=new Float32Array(v.getMappedRange(0,s*16));for(let e=0;e<s;e+=1){let t=(o+e)*3;d[t]=C[e*4],d[t+1]=C[e*4+1],d[t+2]=C[e*4+2]}v.unmap(),await new Promise(e=>setTimeout(e,0))}return{positions:d,normals:W(d,t.mesh.indices),colors:t.mesh.colors,indices:t.mesh.indices}}finally{for(let e of f)e.destroy();i.destroy()}}function V(e,t,n,r=`matching`){let{minimum:i,dimensions:a,spacing:o}=E(t),[s,c,l]=a,u=s*c*l;e.reset();let d=e.alloc(u*Float32Array.BYTES_PER_ELEMENT),f=e.alloc(u*Float32Array.BYTES_PER_ELEMENT),p=e.alloc(u*Uint32Array.BYTES_PER_ELEMENT),m=new Float32Array(e.memory.buffer,d,u),h=new Float32Array(e.memory.buffer,f,u),g=new Uint32Array(e.memory.buffer,p,u);m.fill(0),h.fill(0),g.fill(0);let _=t.positions.length/3;for(let a=0;a<_;a+=1){let u=a*3,m=a*4,h=(t.positions[u]-i[0])/o,g=(t.positions[u+1]-i[1])/o,v=(t.positions[u+2]-i[2])/o;if(h<-16||g<-16||v<-16||h>s+15||g>c+15||v>l+15)continue;let[y,b,S]=j(t,a,o),C=Math.min(24,Math.max(2,Math.ceil(Math.max(y,b,S)*3/o))),w=Math.max(0,Math.floor(h-C)),T=Math.min(s-1,Math.ceil(h+C)),E=Math.max(0,Math.floor(g-C)),D=Math.min(c-1,Math.ceil(g+C)),O=Math.max(0,Math.floor(v-C)),k=Math.min(l-1,Math.ceil(v+C));if(w>T||E>D||O>k)continue;let A=t.rotations[m],M=t.rotations[m+1],N=t.rotations[m+2],P=t.rotations[m+3],F=1-2*(M*M+N*N),I=2*(A*M-N*P),L=2*(A*N+M*P),R=2*(A*M+N*P),z=1-2*(A*A+N*N),B=2*(M*N-A*P),V=2*(A*N-M*P),H=2*(M*N+A*P),U=1-2*(A*A+M*M);e.opacity_splat(d,f,p,s,c,w,T,E,D,O,k,h,g,v,F*o/y,R*o/y,V*o/y,I*o/b,z*o/b,H*o/b,L*o/S,B*o/S,U*o/S,t.opacities[a],a),a&1023||x(n,r,a/Math.max(1,_))}return A(m,s,c,l),x(n,r,1),{field:m,winner:g,dimX:s,dimY:c,dimZ:l,minimum:i,spacing:o}}function H(e,t,n){let r=Math.hypot(e,t,n);return r>1e-12?[e/r,t/r,n/r]:[0,1,0]}function U(e,t,n,r=[]){let i=e.length/3,a=new Int32Array(i),o=new Uint8Array(i);for(let e=0;e<i;e+=1)a[e]=e;let s=e=>{let t=e;for(;a[t]!==t;)t=a[t];for(;a[e]!==e;){let n=a[e];a[e]=t,e=n}return t},c=(e,t)=>{let n=s(e),r=s(t);n!==r&&(o[n]<o[r]&&([n,r]=[r,n]),a[r]=n,o[n]===o[r]&&(o[n]+=1))};for(let e=0;e<n.length;e+=3)c(n[e],n[e+1]),c(n[e],n[e+2]);let l=new Map,u=0;for(let e=0;e<n.length;e+=3){let t=s(n[e]),r=(l.get(t)??0)+1;l.set(t,r),u=Math.max(u,r)}let d=Math.max(24,Math.floor(u*.0015)),f=new Set([...l].filter(([,e])=>e>=d).map(([e])=>e)),p=new Int32Array(i);p.fill(-1);let m=[],h=[],g=[],_=[];for(let i=0;i<n.length;i+=3)if(f.has(s(n[i])))for(let a=0;a<3;a+=1){let o=n[i+a],s=p[o];s<0&&(s=m.length/3,p[o]=s,m.push(e[o*3],e[o*3+1],e[o*3+2]),h.push(t[o*4],t[o*4+1],t[o*4+2],t[o*4+3]),r.length&&_.push(r[o*6],r[o*6+1],r[o*6+2],r[o*6+3],r[o*6+4],r[o*6+5])),g.push(s)}return{positions:m,colors:h,indices:g,brackets:_}}function W(e,t){let n=new Float32Array(e.length);for(let r=0;r<t.length;r+=3){let i=t[r]*3,a=t[r+1]*3,o=t[r+2]*3,s=e[a]-e[i],c=e[a+1]-e[i+1],l=e[a+2]-e[i+2],u=e[o]-e[i],d=e[o+1]-e[i+1],f=e[o+2]-e[i+2],p=c*f-l*d,m=l*u-s*f,h=s*d-c*u;for(let e of[i,a,o])n[e]+=p,n[e+1]+=m,n[e+2]+=h}for(let e=0;e<n.length;e+=3){let[t,r,i]=H(n[e],n[e+1],n[e+2]);n[e]=t,n[e+1]=r,n[e+2]=i}return n}function G(e,t){let n=new Float32Array(e.length);for(let r=0;r<t.length;r+=3){let i=[t[r],t[r+1],t[r+2]],a=i.map(t=>[e[t*3],e[t*3+1],e[t*3+2]]),o=[a[1][0]-a[0][0],a[1][1]-a[0][1],a[1][2]-a[0][2]],s=[a[2][0]-a[0][0],a[2][1]-a[0][1],a[2][2]-a[0][2]],c=H(o[1]*s[2]-o[2]*s[1],o[2]*s[0]-o[0]*s[2],o[0]*s[1]-o[1]*s[0]);for(let e=0;e<3;e+=1){let t=a[e],r=a[(e+1)%3],o=a[(e+2)%3],s=r[0]-t[0],l=r[1]-t[1],u=r[2]-t[2],d=o[0]-t[0],f=o[1]-t[1],p=o[2]-t[2],m=Math.max(1e-20,Math.hypot(s,l,u)*Math.hypot(d,f,p)),h=Math.acos(Math.max(-1,Math.min(1,(s*d+l*f+u*p)/m))),g=i[e]*3;n[g]+=c[0]*h,n[g+1]+=c[1]*h,n[g+2]+=c[2]*h}}for(let e=0;e<n.length;e+=3){let t=H(n[e],n[e+1],n[e+2]);n.set(t,e)}return n}function K(e,t,n){let r=Math.max(0,Math.min(5,Math.round(n))),i=e.positions.length/3;if(!r||i<4)return e;let a=new Uint32Array(i);for(let t=0;t<e.indices.length;t+=3)a[e.indices[t]]+=2,a[e.indices[t+1]]+=2,a[e.indices[t+2]]+=2;let o=new Uint32Array(i+1);for(let e=0;e<i;e+=1)o[e+1]=o[e]+a[e];let s=o.slice(0,i),c=new Uint32Array(o[i]),l=(e,t)=>{c[s[e]]=t,s[e]+=1};for(let t=0;t<e.indices.length;t+=3){let n=e.indices[t],r=e.indices[t+1],i=e.indices[t+2];l(n,r),l(n,i),l(r,n),l(r,i),l(i,n),l(i,r)}let u=e.positions,d=e.positions.slice(),f=Math.max(1e-8,t*2.5),p=1/(2*f*f),m=(t*4.5)**2,h=t*.25,g=t*.5,_=Math.cos(35*Math.PI/180);for(let t=0;t<r;t+=1){let t=W(d,e.indices),n=d.slice();for(let e=0;e<i;e+=1){let r=e*3,i=t[r],a=t[r+1],s=t[r+2],l=0,f=0;for(let n=o[e];n<o[e+1];n+=1){let e=c[n]*3,o=i*t[e]+a*t[e+1]+s*t[e+2];if(o<_)continue;let u=d[e]-d[r],h=d[e+1]-d[r+1],g=d[e+2]-d[r+2],v=u*u+h*h+g*g;if(v>m)continue;let y=u*i+h*a+g*s,b=1-Math.max(-1,Math.min(1,o)),x=Math.exp(-v*p)*Math.exp(-b*b*15.4320987654321);l+=y*x,f+=x}if(f<=1e-8)continue;let v=Math.max(-h,Math.min(h,l/f*.45)),y=d[r]+i*v,b=d[r+1]+a*v,x=d[r+2]+s*v,S=y-u[r],C=b-u[r+1],w=x-u[r+2],T=Math.hypot(S,C,w);if(T>g){let e=g/T;y=u[r]+S*e,b=u[r+1]+C*e,x=u[r+2]+w*e}n[r]=y,n[r+1]=b,n[r+2]=x}d=n}let v=G(d,e.indices),y=e.colors.slice();for(let e=0;e<r;e+=1){let e=y.slice();for(let t=0;t<i;t+=1){let n=t*3,r=t*4,i=y[r]*2,a=y[r+1]*2,s=y[r+2]*2,l=2;for(let e=o[t];e<o[t+1];e+=1){let t=c[e],o=t*3;if(v[n]*v[o]+v[n+1]*v[o+1]+v[n+2]*v[o+2]<_)continue;let u=t*4,d=y[u]-y[r],f=y[u+1]-y[r+1],p=y[u+2]-y[r+2],m=Math.exp(-(d*d+f*f+p*p)*.0002469135802469136);i+=y[u]*m,a+=y[u+1]*m,s+=y[u+2]*m,l+=m}e[r]=Math.round(i/l),e[r+1]=Math.round(a/l),e[r+2]=Math.round(s/l),e[r+3]=255}y=e}return{positions:d,normals:v,colors:y,indices:e.indices}}function q(e,t,n=.65){let r=new Float32Array(e.positions.length);for(let i=0;i<r.length;i+=1)r[i]=e.positions[i]*(1-n)+t.positions[i]*n;return{positions:r,normals:G(r,e.indices),colors:e.colors,indices:e.indices}}function J(e){let t=Array.from(e.positions),n=Array.from(e.colors),r=[],i=e.positions.length/3,a=new Map,o=(r,o)=>{let s=Math.min(r,o),c=Math.max(r,o),l=s*i+c,u=a.get(l);if(u!==void 0)return u;let d=t.length/3;return a.set(l,d),t.push((e.positions[r*3]+e.positions[o*3])*.5,(e.positions[r*3+1]+e.positions[o*3+1])*.5,(e.positions[r*3+2]+e.positions[o*3+2])*.5),n.push(Math.round((e.colors[r*4]+e.colors[o*4])*.5),Math.round((e.colors[r*4+1]+e.colors[o*4+1])*.5),Math.round((e.colors[r*4+2]+e.colors[o*4+2])*.5),255),d};for(let t=0;t<e.indices.length;t+=3){let n=e.indices[t],i=e.indices[t+1],a=e.indices[t+2],s=o(n,i),c=o(i,a),l=o(a,n);r.push(n,s,l,s,i,c,l,c,a,s,c,l)}let s=Float32Array.from(t),c=Uint32Array.from(r);return{positions:s,normals:W(s,c),colors:Uint8Array.from(n),indices:c}}function Y(e,t){let n=e.normals??W(e.positions,e.indices),r=new Float32Array(e.positions.length*2);for(let i=0;i<e.positions.length/3;i+=1){let a=i*3,o=i*6;r[o]=e.positions[a]-n[a]*t,r[o+1]=e.positions[a+1]-n[a+1]*t,r[o+2]=e.positions[a+2]-n[a+2]*t,r[o+3]=e.positions[a]+n[a]*t,r[o+4]=e.positions[a+1]+n[a+1]*t,r[o+5]=e.positions[a+2]+n[a+2]*t}return{mesh:e,brackets:r}}function X(e,t){let n=e.indices.length/3,r=Math.max(48,Math.min(u,t)),i=Math.max(2,Math.ceil(Math.log2(r/g(r)))),a=0;for(;a<i&&n*4**(a+1)<=d;)a+=1;return a}function Z(e,t){let{field:n,winner:r,dimX:i,dimY:o,dimZ:s,minimum:c,spacing:l}=e,u=[c[0]+l*i,c[1]+l*o,c[2]+l*s],d=(0,a.marchingCubes)([i,o,s],(e,r,a)=>{let u=Math.max(0,Math.min(i-1,Math.round((e-c[0])/l))),d=Math.max(0,Math.min(o-1,Math.round((r-c[1])/l))),f=Math.max(0,Math.min(s-1,Math.round((a-c[2])/l)));return n[(f*o+d)*i+u]-t.isoLevel},[c,u]),f=[],p=[],m=[],h=new Int32Array(d.positions.length);h.fill(-1);let g=new Map,_=1/Math.max(1e-8,l*1e-4),v=e=>{let n=h[e];if(n>=0)return n;let a=d.positions[e],u=`${Math.round(a[0]*_)},${Math.round(a[1]*_)},${Math.round(a[2]*_)}`,m=g.get(u);if(m!==void 0)return h[e]=m,m;let v=f.length/3;h[e]=v,g.set(u,v),f.push(a[0],a[1],a[2]);let y=Math.max(0,Math.min(i-1,Math.round((a[0]-c[0])/l))),b=Math.max(0,Math.min(o-1,Math.round((a[1]-c[1])/l))),x=Math.max(0,Math.min(s-1,Math.round((a[2]-c[2])/l))),S=Math.min(t.colors.length/4-1,r[(x*o+b)*i+y]);return p.push(t.colors[S*4],t.colors[S*4+1],t.colors[S*4+2],255),v};for(let e of d.cells){let t=v(e[0]),n=v(e[1]),r=v(e[2]);t!==n&&n!==r&&r!==t&&m.push(t,n,r)}let y=Float32Array.from(f),b=Uint32Array.from(m);return{positions:y,normals:null,colors:Uint8Array.from(p),indices:b}}function Q(e,t){let{field:n,winner:r,dimX:i,dimY:o,dimZ:s,minimum:c,spacing:l}=e,u=[c[0]+l*i,c[1]+l*o,c[2]+l*s],d=(0,a.surfaceNets)([i,o,s],(e,r,a)=>{let u=Math.max(0,Math.min(i-1,Math.round((e-c[0])/l))),d=Math.max(0,Math.min(o-1,Math.round((r-c[1])/l))),f=Math.max(0,Math.min(s-1,Math.round((a-c[2])/l)));return n[(f*o+d)*i+u]-t.isoLevel},[c,u]),f=[],p=[];for(let e of d.positions){f.push(e[0],e[1],e[2]);let n=Math.max(0,Math.min(i-1,Math.round((e[0]-c[0])/l))),a=Math.max(0,Math.min(o-1,Math.round((e[1]-c[1])/l))),u=Math.max(0,Math.min(s-1,Math.round((e[2]-c[2])/l))),d=Math.min(t.colors.length/4-1,r[(u*o+a)*i+n]);p.push(t.colors[d*4],t.colors[d*4+1],t.colors[d*4+2],255)}let m=[];for(let e of d.cells){if(e.length<3)continue;let t=e[0];for(let n=1;n+1<e.length;n+=1){let r=e[n],i=e[n+1];t!==r&&r!==i&&i!==t&&m.push(t,r,i)}}let h=U(f,p,m);if(h.indices.length<30)throw Error(`Surface Nets 快速预览没有提取到足够的连续表面。`);let g=Float32Array.from(h.positions),_=Uint32Array.from(h.indices);return{positions:g,normals:W(g,_),colors:Uint8Array.from(h.colors),indices:_}}function $(e,t,n,r=!0,i=!0,a=!0){let{field:o,winner:u,dimX:d,dimY:f,dimZ:p,minimum:m,spacing:h}=e,g=[],_=[],v=[],y=[],b=new Map,S=t.isoLevel,C=(e,t,n)=>(n*f+t)*d+e,w=(e,n,r,i)=>{let a=Math.min(e,n),s=Math.max(e,n),c=a*o.length+s,l=b.get(c),d=o[e],f=o[n],p=f-d,v=Math.max(0,Math.min(1,Math.abs(p)>1e-8?(S-d)/p:.5)),x=r[0]+(i[0]-r[0])*v,C=r[1]+(i[1]-r[1])*v,w=r[2]+(i[2]-r[2])*v;if(l===void 0){l=g.length/3,b.set(c,l),g.push(m[0]+x*h,m[1]+C*h,m[2]+w*h),y.push(m[0]+r[0]*h,m[1]+r[1]*h,m[2]+r[2]*h,m[0]+i[0]*h,m[1]+i[1]*h,m[2]+i[2]*h);let a=u[d>=f?e:n],o=Math.min(t.colors.length/4-1,a)*4;_.push(t.colors[o],t.colors[o+1],t.colors[o+2],255)}return{index:l,x,y:C,z:w}},T=(e,t,n,r)=>{let i=t.x-e.x,a=t.y-e.y,o=t.z-e.z,s=n.x-e.x,c=n.y-e.y,l=n.z-e.z;(a*l-o*c)*r[0]+(o*s-i*l)*r[1]+(i*c-a*s)*r[2]>=0?v.push(e.index,t.index,n.index):v.push(e.index,n.index,t.index)};for(let e=0;e<p-1;e+=1){for(let t=0;t<f-1;t+=1)for(let n=0;n<d-1;n+=1){let r=l.map(r=>C(n+r[0],t+r[1],e+r[2])),i=r.map(e=>o[e]);if(i.every(e=>e<S)||i.every(e=>e>=S))continue;let a=l.map(r=>[n+r[0],t+r[1],e+r[2]]);for(let e of s){let t=e.map(e=>i[e]>=S),n=t.filter(Boolean).length;if(n===0||n===4)continue;let o=[];for(let n of c){if(t[n[0]]===t[n[1]])continue;let i=e[n[0]],s=e[n[1]];o.push(w(r[i],r[s],a[i],a[s]))}let s=0,l=0,u=0,d=0,f=0,p=0;for(let r=0;r<4;r+=1){let i=a[e[r]];t[r]?(s+=i[0]/n,l+=i[1]/n,u+=i[2]/n):(d+=i[0]/(4-n),f+=i[1]/(4-n),p+=i[2]/(4-n))}let m=H(d-s,f-l,p-u);if(o.length===3)T(o[0],o[1],o[2],m);else if(o.length===4){let e=o.reduce((e,t)=>[e[0]+t.x/4,e[1]+t.y/4,e[2]+t.z/4],[0,0,0]),t=Math.abs(m[1])<.9?[0,1,0]:[1,0,0],n=H(m[1]*t[2]-m[2]*t[1],m[2]*t[0]-m[0]*t[2],m[0]*t[1]-m[1]*t[0]),r=[m[1]*n[2]-m[2]*n[1],m[2]*n[0]-m[0]*n[2],m[0]*n[1]-m[1]*n[0]];o.sort((t,i)=>{let a=t.x-e[0],o=t.y-e[1],s=t.z-e[2],c=i.x-e[0],l=i.y-e[1],u=i.z-e[2];return Math.atan2(a*r[0]+o*r[1]+s*r[2],a*n[0]+o*n[1]+s*n[2])-Math.atan2(c*r[0]+l*r[1]+u*r[2],c*n[0]+l*n[1]+u*n[2])}),T(o[0],o[1],o[2],m),T(o[0],o[2],o[3],m)}}if(v.length/3>4e6)throw Error(`不透明度场生成的三角形过多，请降低场分辨率。`)}i&&x(n,`fusing`,(e+1)/Math.max(1,p-1))}let E=r?U(g,_,v,y):{positions:g,colors:_,indices:v,brackets:y};if(r&&E.indices.length<30)throw Error(`Gaussian 不透明度场没有提取到足够的连续表面。`);let D=Float32Array.from(E.positions),O=Uint32Array.from(E.indices);return{mesh:{positions:D,normals:a?W(D,O):null,colors:Uint8Array.from(E.colors),indices:O},brackets:Float32Array.from(E.brackets)}}function ee(e,t,n){return $(e,t,n).mesh}async function te(e){let t=performance.now();x(e.requestId,`matching`,.01);let n=null,r=async()=>(n??=await S(),n),i=Math.max(48,Math.min(u,Math.round(e.input.fieldResolution))),a=D(e.input),o;try{o=await I(a,72,!1)}catch{o={...V(await r(),a,e.requestId),backend:`WASM bounded preview (${a.positions.length/3} Gaussian / 72³) + Surface Nets`}}o.backend.includes(`bounded preview`)||(o={...o,backend:`${o.backend} · bounded preview (${a.positions.length/3} Gaussian / 72³)`});let s=Q(o,a),c={type:`preview`,requestId:e.requestId,positions:s.positions,normals:s.normals??new Float32Array(s.positions.length),colors:s.colors,indices:s.indices,backend:o.backend,elapsedMs:performance.now()-t};b(c,[c.positions.buffer,c.normals.buffer,c.colors.buffer,c.indices.buffer]),x(e.requestId,`fusing`,0);try{if(i>160||e.input.targetVoxelSize){let t;try{t=await L(e.input,i,e.requestId)}catch(n){if(n instanceof h)throw n;try{t=await z(await r(),e.input,i,e.requestId)}catch(e){let t=n instanceof Error?n.message:String(n),r=e instanceof Error?e.message:String(e);throw Error(`WebGPU 路径不可用（${t}）；WASM 分区回退也失败（${r}）。`)}}if(t.backend.startsWith(`WASM`)){let n=t.mesh,r=e.input.smoothingIterations??0,i=``;return r>0&&(n=K(n,t.spacing,r),i=` + ${r}x bounded bilateral feature smoothing`),x(e.requestId,`fusing`,1),{mesh:n,backend:`${t.backend}${i} (WebGPU adapter unavailable; metric WASM fallback)`}}try{let n=await B(e.input,t),r=e.input.smoothingIterations??0,i=``;if(r>0){let a=t.spacing,o=K(n,a,r);try{n=q(o,await B(e.input,Y(o,Math.max(t.spacing,a)*1.5))),i=` + ${r}x bilateral feature smoothing (0.5-voxel drift, 65% GOF constraint)`}catch{n=o,i=` + ${r}x bounded bilateral feature smoothing`}}return x(e.requestId,`fusing`,1),{mesh:n,backend:`${t.backend} + batched 8-step GOF edge bisection (256x positional)${i}`}}catch{return{mesh:t.mesh,backend:`${t.backend} (edge refinement unavailable)`}}}let t=await I(e.input,i,!0),n=$(t,e.input,e.requestId);try{let r=await B(e.input,n),a=X(r,i);if(a>0){let n=r;for(let e=0;e<a;e+=1)n=J(n);try{let i=t.spacing*.9/2**a;r=await B(e.input,Y(n,i),4)}catch{}}return{mesh:r,backend:`${t.backend} + 8-step GOF edge bisection (256x positional) + ${4**a}x projected triangles`}}catch{return{mesh:n.mesh,backend:`${t.backend} (edge refinement unavailable)`}}}catch(t){if(e.input.targetVoxelSize)throw t;return{mesh:ee(e.input.fieldResolution===72&&o.backend.startsWith(`WASM`)?o:V(await r(),e.input,e.requestId,`fusing`),e.input,e.requestId),backend:`WASM Gaussian opacity refinement fallback + Marching Tetrahedra`}}}o&&(o.onmessage=e=>{let t=e.data;t.type===`reconstruct-opacity`&&te(t).then(({mesh:e,backend:n})=>{let r={type:`result`,requestId:t.requestId,positions:e.positions,normals:e.normals??new Float32Array(e.positions.length),colors:e.colors,indices:e.indices,backend:n};b(r,[r.positions.buffer,r.normals.buffer,r.colors.buffer,r.indices.buffer])}).catch(e=>{b({type:`error`,requestId:t.requestId,message:e instanceof Error?e.message:String(e)})})},b({type:`ready`}))})();
//# sourceMappingURL=gs2mesh-opacity.worker-Dssufm7P.js.map