import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {zstdNode} from './lib/runtime.mjs';

const files=readdirSync('tests').filter(n=>n.endsWith('.test.mjs')).sort().map(n=>`tests/${n}`);
const {execPath,env}=zstdNode();
const result=spawnSync(execPath,['--test',...files],{stdio:'inherit',env});
if(result.error)throw result.error;
process.exit(result.status??1);
