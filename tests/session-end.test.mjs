import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import session from '../src/session-end.cjs';
test('Windows session end releases immediately and only restores once across windows',async()=>{
  const calls=[];
  const end=session.sessionEndHandler({stop:()=>calls.push('release'),restore:async()=>calls.push('restore')});
  end();end();assert.deepEqual(calls,['release']);
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(calls,['release','restore']);
});
test('a cleanup failure is handled without preventing Windows shutdown',async()=>{
  const errors=[];
  const end=session.sessionEndHandler({stop:()=>{throw Error('stop');},restore:async()=>{throw Error('restore');},onError:error=>errors.push(error.message)});
  end();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(errors,['stop','restore']);
});
test('session-end is wired to every BrowserWindow, without vetoing shutdown',()=>{
  const main=readFileSync(new URL('../src/main.cjs',import.meta.url),'utf8');
  assert.match(main,/app\.on\('browser-window-created',[^\n]*window\.on\('session-end',endWindowsSession\)/);
});
