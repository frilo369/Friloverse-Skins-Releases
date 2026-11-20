import test from 'node:test';
import assert from 'node:assert/strict';
import {latestRelease,limitedError,parseRefs,readRefs} from '../src/github-refs.mjs';
import {refsBody,refsResponse,releaseResponse} from './fixtures/github.mjs';

const sha=letter=>letter.repeat(40);

test('git\'s list gives each branch and tag its commit',()=>{
  const refs=parseRefs(refsBody({HEAD:sha('a'),'refs/heads/main':sha('a'),'refs/tags/v1':sha('b')}));
  assert.equal(refs.get('refs/heads/main'),sha('a'));
  assert.equal(refs.get('refs/tags/v1'),sha('b'));
  assert.equal(refs.has('# service=git-upload-pack'),false);
});

test('an annotated tag means the commit it points at',()=>{
  const refs=parseRefs(refsBody({HEAD:sha('a'),'refs/tags/v1':sha('c'),'refs/tags/v1^{}':sha('d')}));
  assert.equal(refs.get('refs/tags/v1'),sha('d'));
});

test('a damaged list is an error, not an empty answer',()=>{
  assert.throws(()=>parseRefs('not a list at all'),/invalid list/);
  assert.throws(()=>parseRefs(`0fff${sha('a')} refs/heads/main\n`),/invalid list/);
});

test('the list is read from git\'s address, with no API request',async()=>{
  const asked=[];
  const refs=await readRefs(async url=>{asked.push(url);return refsResponse({HEAD:sha('a'),'refs/heads/main':sha('a')});},'me/one');
  assert.equal(refs.get('refs/heads/main'),sha('a'));
  assert.deepEqual(asked,['https://github.com/me/one.git/info/refs?service=git-upload-pack']);
});

test('the newest release is read from where GitHub redirects, without following it',async()=>{
  const seen=[];
  const fetchFn=async(url,options)=>{seen.push([url,options.redirect]);return releaseResponse('me/one','list-1');};
  assert.equal(await latestRelease(fetchFn,'me/one'),'list-1');
  assert.deepEqual(seen,[['https://github.com/me/one/releases/latest','manual']]);
});

test('no release at all is a clear answer, and anything else an error',async()=>{
  assert.equal(await latestRelease(async()=>releaseResponse('me/one'),'me/one'),'');
  await assert.rejects(latestRelease(async()=>new Response(null,{status:302,headers:{location:'https://github.com/login'}}),'me/one'),/unexpected address/);
  await assert.rejects(latestRelease(async()=>new Response('nope',{status:404}),'me/one'),/answered 404/);
  await assert.rejects(latestRelease(async()=>new Response('nope',{status:429}),'me/one'),/limiting requests/);
});

test('being limited says until when, if GitHub said',()=>{
  assert.match(limitedError({status:403,headers:new Headers({'x-ratelimit-reset':'1800000000'})}).message,/until about \S/);
  assert.match(limitedError({status:403}).message,/for now$/);
});

test('being limited says when it is worth asking again',()=>{
  const reset=limitedError({status:403,headers:new Headers({'x-ratelimit-reset':'1800000000'})});
  assert.equal(reset.limited,true);assert.equal(reset.retryAt,1800000000*1000);
  const before=Date.now();
  assert.ok(limitedError({status:429,headers:new Headers({'retry-after':'90'})}).retryAt>=before+90*1000);
  assert.equal(limitedError({status:403}).retryAt,0);
});
