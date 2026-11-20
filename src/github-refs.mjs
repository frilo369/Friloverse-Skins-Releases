import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {writeAtomic} from './atomic-file.mjs';

// What a GitHub repository's branches and tags point at, and which release is newest. These
// come from the addresses git and the app's own update feed use, not from GitHub's API, whose
// 60 requests an hour are shared by everyone on one internet connection. Measured 2026-11-08:
// neither address moved that count, while an API answer of "unchanged" (304) still used one
// each without a login, so saving API answers alone would not have spared the limit.
const HEADERS={'User-Agent':'Friloverse'},TIMEOUT=20000,REDIRECT=new Set([301,302,303,307,308]);
const MAX_BACKOFF_MS=2*60*60*1000;

/** Whether an HTTP 403/429 response is genuinely a GitHub rate limit (not an auth/access 403). */
export function isRateLimitResponse(response){
  if(response?.status===429)return true;
  if(response?.status!==403)return false;
  const remaining=response?.headers?.get?.('x-ratelimit-remaining');
  const retryAfter=response?.headers?.get?.('retry-after');
  // Treat missing headers as rate-limited only for anonymous mocks/proxies; explicit remaining > 0 is not.
  if(remaining!==null&&remaining!==undefined&&remaining!==''&&Number(remaining)>0&&!retryAfter)return false;
  return true;
}

/** Plain words for GitHub refusing this network, saying until when. */
export function limitedError(response,{now=Date.now(),maxWait=0}={}){
  const reset=Number(response?.headers?.get?.('x-ratelimit-reset'));
  const after=Number(response?.headers?.get?.('retry-after'));
  const rawRetry=reset>0?reset*1000:after>0?now+after*1000:0;
  const retryAt=rawRetry>0&&maxWait>0?Math.min(rawRetry,now+maxWait):rawRetry;
  const until=retryAt>0?`until about ${new Date(retryAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}`:'for now';
  return Object.assign(new Error(`GitHub is limiting requests from this network ${until}`),{status:response?.status,limited:true,retryAt});
}
const refused=response=>{
  if(isRateLimitResponse(response))throw limitedError(response);
  throw Object.assign(new Error(`GitHub answered ${response.status}`),{status:response.status});
};

/** Persists GitHub API rate-limit cooldowns across app restarts so restarts don't burn extra quota. */
export class RateLimitGuard{
  constructor(dataDir,{now=Date.now}={}){
    this.file=path.join(dataDir,'github-rate-limit.json');
    this.now=now;
    this.blockedUntil=0;
  }
  async load(){
    try{
      const saved=JSON.parse(await readFile(this.file,'utf8'));
      const until=Number(saved?.blockedUntil)||0;
      const cap=this.now()+MAX_BACKOFF_MS;
      this.blockedUntil=until>this.now()?Math.min(until,cap):0;
    }catch{this.blockedUntil=0;}
    return this.blockedUntil;
  }
  remainingMs(){return Math.max(0,this.blockedUntil-this.now());}
  allowed(){return this.now()>=this.blockedUntil;}
  async note(retryAt){
    const fallback=this.now()+5*60*1000;
    const clamped=Math.min(Math.max(Number(retryAt)||fallback,this.now()+60*1000),this.now()+MAX_BACKOFF_MS);
    this.blockedUntil=Math.max(this.blockedUntil,clamped);
    await writeAtomic(this.file,JSON.stringify({blockedUntil:this.blockedUntil}),{durable:false}).catch(()=>{});
  }
}

/**
 * Git's list of references (packets of four hex digits of length, then the line) as a map of
 * name to commit. An annotated tag is listed twice, the second time as `name^{}` with its
 * commit, and that one wins.
 */
export function parseRefs(text){
  const refs=new Map();
  for(let at=0;at+4<=text.length;){
    const size=/^[0-9a-f]{4}$/i.test(text.slice(at,at+4))?Number.parseInt(text.slice(at,at+4),16):-1;
    if(size<0||(size>=4&&at+size>text.length))throw new Error('GitHub returned an invalid list of revisions');
    if(size<4){at+=4;continue;}
    const match=/^([0-9a-f]{40}) (\S+)$/i.exec(text.slice(at+4,at+size).replace(/\n$/,'').split('\0')[0]);
    at+=size;
    if(match)refs.set(match[2].replace(/\^\{\}$/,''),match[1].toLowerCase());
  }
  return refs;
}

export async function readRefs(fetchFn,repository){
  const response=await fetchFn(`https://github.com/${repository}.git/info/refs?service=git-upload-pack`,{headers:HEADERS,signal:AbortSignal.timeout(TIMEOUT)});
  if(!response.ok)refused(response);
  // Lengths count bytes, and latin1 keeps one character per byte whatever a tag is called.
  return parseRefs(Buffer.from(await response.arrayBuffer()).toString('latin1'));
}

/** The newest release's tag, or '' when the repository has no release. */
export async function latestRelease(fetchFn,repository){
  const response=await fetchFn(`https://github.com/${repository}/releases/latest`,{headers:HEADERS,redirect:'manual',signal:AbortSignal.timeout(TIMEOUT)});
  if(!REDIRECT.has(response.status))refused(response);
  const location=String(response.headers?.get?.('location')||'').replace(/[?#].*$/,'').replace(/\/+$/,'');
  const tag=/\/releases\/tag\/([^/]+)$/.exec(location);
  if(tag)return decodeURIComponent(tag[1]);
  if(location.endsWith(`/${repository}/releases`))return '';
  throw new Error('GitHub returned an unexpected address for the newest release');
}
