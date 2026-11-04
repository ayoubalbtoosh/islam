import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
function option(name){const index=args.indexOf(name);return index<0?null:args[index+1];}
const url=option('--url'),key=option('--publishable-key');
if(!url||!key)throw Error('Use --url PROJECT_HTTPS_URL --publishable-key PUBLIC_KEY. Never pass a service-role secret.');
let parsed;try{parsed=new URL(url);}catch{throw Error('Expected an HTTPS project origin.');}
if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.pathname!=='/'||parsed.search||parsed.hash)throw Error('Expected an HTTPS project origin.');
if(/^sb_secret_/i.test(key)||/\s/.test(key))throw Error('A server secret cannot be embedded in the website.');
if(!key.startsWith('sb_publishable_')){
 let claims;try{claims=JSON.parse(Buffer.from(key.split('.')[1],'base64url').toString());}catch{throw Error('Expected a public publishable or anon key.');}
 if(claims.role!=='anon')throw Error('Only the public anon role can be embedded.');
}
if(key.length<24)throw Error('Public key is incomplete.');
await writeFile(path.join(root,'config/auth.public.json'),JSON.stringify({url:parsed.origin,publishableKey:key},null,2)+'\n');
console.log('Public authentication configuration saved. Run npm run build. No secret values printed.');
