// Isolated Electron smoke test using captured source data; never touches League or LTK Manager.
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import electron from 'electron';
import {tmpdir} from 'node:os';
import path from 'node:path';
const output=path.resolve(process.argv[2]||path.join(tmpdir(),'friloverse-guide-qa'));
const userData=await mkdtemp(path.join(tmpdir(),'friloverse-guide-test-'));
const env={...process.env,FRILOVERSE_GUIDE_USER_DATA:userData};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(electron,['scripts/verify-guide.cjs',output],{stdio:'inherit',env,windowsHide:true});
child.on('exit',async code=>{await rm(userData,{recursive:true,force:true}).catch(()=>{});process.exit(code??1);});
child.on('error',async error=>{console.error(error.message);await rm(userData,{recursive:true,force:true}).catch(()=>{});process.exit(1);});
