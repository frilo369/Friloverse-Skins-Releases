import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {createRequire} from 'node:module';

const run=promisify(execFile);
const require=createRequire(import.meta.url);
let native;
// An unfiltered CSV contains tasklist itself; require it so a failed or
// incomplete command is never mistaken for an empty list of game processes.
export function parseProcessNames(output){
  if(typeof output!=='string')return null;
  const lines=output.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  if(!lines.length)return null;
  const names=new Set();
  for(const line of lines){
    const match=/^"((?:[^"]|"")+)",/.exec(line);if(!match)return null;
    names.add(match[1].replaceAll('""','"').toLowerCase());
  }
  return names.has('tasklist.exe')?names:null;
}
export async function processRunning(name){
  if(process.platform!=='win32')throw new Error('Windows process status is unavailable.');
  try{
    native ||= require('./windows-process.cjs');
    return native.processNames().has(name.toLowerCase());
  }catch{
    // The slower independent check is still safer than guessing if a native
    // snapshot cannot be taken. Parsing errors also fail closed at the caller.
  }
  if(!process.env.SystemRoot)throw new Error('Windows process status is unavailable.');
  const executable=path.join(process.env.SystemRoot,'System32','tasklist.exe');
  const {stdout}=await run(executable,['/FO','CSV','/NH'],{windowsHide:true,timeout:3000,maxBuffer:4*1024*1024});
  const names=parseProcessNames(stdout);
  if(!names)throw new Error('Windows process status could not be verified.');
  return names.has(name.toLowerCase());
}
