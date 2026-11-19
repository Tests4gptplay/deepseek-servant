import {registerHooks,createRequire} from 'node:module';import {pathToFileURL} from 'node:url';
const require=createRequire(new URL('../../package.json',import.meta.url));
const url=pathToFileURL(require.resolve('mdast-util-from-markdown')).href;registerHooks({resolve(s,c,n){if(s==='mdast-util-from-markdown')return{url,shortCircuit:true};return n(s,c)}});
