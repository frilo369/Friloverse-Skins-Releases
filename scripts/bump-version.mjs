// Moves package.json and package-lock.json to the next version (owner's scheme: up 0.1, 6.9 -> 7.0),
// or to the one given: node scripts/bump-version.mjs [x.y.0]
import {readFileSync,writeFileSync} from 'node:fs';
const root=new URL('..',import.meta.url);
const pkgFile=new URL('package.json',root),lockFile=new URL('package-lock.json',root);
const pkg=readFileSync(pkgFile,'utf8');
const from=JSON.parse(pkg).version;
const next=([major,minor])=>minor>=9?`${major+1}.0.0`:`${major}.${minor+1}.0`;
const to=process.argv[2]||next(from.split('.').map(Number));
if(!/^\d+\.\d+\.0$/.test(to))throw new Error(`${to} is not x.y.0.`);
writeFileSync(pkgFile,pkg.replace(`"version": "${from}"`,`"version": "${to}"`));
const lock=readFileSync(lockFile,'utf8');
// Only the versions right after "name": "friloverse-skins": other packages share numbers.
const anchor=new RegExp(`("name": "friloverse-skins",\\r?\\n\\s*"version": ")${from.replaceAll('.','\\.')}"`,'g');
const count=(lock.match(anchor)||[]).length;
if(count!==2)throw new Error(`package-lock.json has ${count} friloverse-skins versions at ${from}, not 2.`);
writeFileSync(lockFile,lock.replace(anchor,`$1${to}"`));
console.log(`${from} -> ${to}`);
