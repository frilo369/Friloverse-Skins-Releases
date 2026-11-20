import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';

// Multi-IP rotation + DNS-over-HTTPS (DoH) fallback for Cloudflare Workers endpoints.
// Some European ISPs (e.g. Spanish ISPs during LaLiga matches) block specific Cloudflare IP
// ranges while other Cloudflare IPs for the same hostname keep serving normally via TLS SNI.

const DOH_RESOLVERS=[
  'https://cloudflare-dns.com/dns-query',
  'https://dns.google/resolve',
];
const TCP_CONNECT_TIMEOUT=4000;
const DOH_TIMEOUT=4000;
const FALLBACK_BUDGET=25000;
const preferred=new Map();

/** True only for globally routable IPv4/IPv6 addresses (rejects ISP DNS-poisoned 0.0.0.0/127.0.0.1/RFC1918). */
export function isGlobalIp(address){
  const version=net.isIP(address);
  if(version===4){
    const parts=address.split('.').map(Number);
    if(parts.length!==4||parts.some(n=>n<0||n>255))return false;
    const [a,b]=parts;
    if(a===0||a===10||a===127||a>=224)return false;
    if(a===100&&b>=64&&b<=127)return false;
    if(a===169&&b===254)return false;
    if(a===172&&b>=16&&b<=31)return false;
    if(a===192&&b===168)return false;
    return true;
  }
  if(version===6){
    const low=address.toLowerCase();
    if(low==='::'||low==='::1'||low.startsWith('fe80:')||low.startsWith('fc')||low.startsWith('fd')||low.startsWith('ff'))return false;
    return true;
  }
  return false;
}

export function parseDohAnswer(payload,recordType){
  if(!payload||typeof payload!=='object'||payload.Status!==0||!Array.isArray(payload.Answer))return [];
  const out=[];
  for(const record of payload.Answer){
    if(record?.type===recordType&&typeof record.data==='string'&&isGlobalIp(record.data))out.push(record.data);
  }
  return out;
}

export async function dohAddresses(host,{fetchFn=fetch}={}){
  const queries=[['A',1],['AAAA',28]].flatMap(([name,code])=>DOH_RESOLVERS.map(url=>({url,name,code})));
  const results=await Promise.allSettled(queries.map(async({url,name,code})=>{
    const response=await fetchFn(`${url}?name=${encodeURIComponent(host)}&type=${name}`,{
      headers:{Accept:'application/dns-json'},
      signal:AbortSignal.timeout(DOH_TIMEOUT),
    });
    if(!response.ok)return [];
    return parseDohAnswer(await response.json(),code);
  }));
  const seen=new Set(),out=[];
  for(const row of results){
    if(row.status!=='fulfilled')continue;
    for(const ip of row.value)if(!seen.has(ip)){seen.add(ip);out.push(ip);}
  }
  return out;
}

function connectTcp(ip,port,timeout){
  return new Promise((resolve,reject)=>{
    const socket=net.connect({host:ip,port,family:net.isIP(ip)});
    let settled=false;
    const done=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);if(error){socket.destroy();reject(error);}else resolve(value);};
    const timer=setTimeout(()=>done(new Error(`TCP timeout to ${ip}`)),timeout);
    socket.once('connect',()=>done(null,socket));
    socket.once('error',error=>done(error));
  });
}

function unique(list){
  const seen=new Set(),out=[];
  for(const item of list)if(item&&!seen.has(item)){seen.add(item);out.push(item);}
  return out;
}

/**
 * Resolve & connect a TLS (or plain TCP) socket to `hostname:port` by rotating across:
 * 1. The last working IP for this `(hostname, port)`
 * 2. All system-resolved IPs (`dns.lookup(..., {all:true})`)
 * 3. DNS-over-HTTPS (Cloudflare + Google) IPs if system IPs are blocked/poisoned
 * Always preserves TLS `servername: hostname` (SNI) so Cloudflare routes cleanly.
 */
export async function connectWithFailover(hostname,port,{secure=true,budget=FALLBACK_BUDGET,connect=connectTcp,lookup=dns.lookup,doh=dohAddresses,now=Date.now}={}){
  const key=`${hostname}:${port}`;
  const deadline=now()+budget;
  const tried=new Set();
  let stage='dns',lastError=null;

  const tryCandidates=async candidates=>{
    for(const ip of candidates){
      if(tried.has(ip)||now()>=deadline)continue;
      tried.add(ip);
      stage='tcp';
      try{
        const raw=await connect(ip,port,Math.min(TCP_CONNECT_TIMEOUT,Math.max(500,deadline-now())));
        if(!secure){preferred.set(key,ip);return raw;}
        stage='handshake';
        const secureSocket=await new Promise((resolve,reject)=>{
          const tlsSock=tls.connect({socket:raw,servername:hostname,rejectUnauthorized:true});
          let settled=false;
          const finish=(err,val)=>{if(settled)return;settled=true;clearTimeout(t);if(err){tlsSock.destroy();reject(err);}else resolve(val);};
          const t=setTimeout(()=>finish(new Error('TLS handshake timed out')),Math.min(5000,Math.max(1000,deadline-now())));
          tlsSock.once('secureConnect',()=>finish(null,tlsSock));
          tlsSock.once('error',err=>finish(err));
        });
        preferred.set(key,ip);
        return secureSocket;
      }catch(error){
        lastError=error;
        if(preferred.get(key)===ip)preferred.delete(key);
      }
    }
    return null;
  };

  if(net.isIP(hostname)){
    const direct=await tryCandidates([hostname]);
    if(direct)return direct;
  }else{
    let system=[];
    try{
      const rows=await lookup(hostname,{all:true});
      system=rows.map(row=>row.address).filter(Boolean);
    }catch(error){lastError=error;}
    const firstPass=unique([preferred.get(key),...system]);
    const connected=await tryCandidates(firstPass);
    if(connected)return connected;
    if(now()<deadline){
      const extra=(await doh(hostname).catch(()=>[])).filter(ip=>!tried.has(ip));
      const connectedDoh=await tryCandidates(extra);
      if(connectedDoh)return connectedDoh;
    }
  }
  const error=new Error(describeRelayError(stage,lastError));
  error.stage=stage;
  throw error;
}

export function describeRelayError(stage,error){
  const detail=error?.message||'connection failed';
  if(stage==='dns'||stage==='tcp'){
    return `Could not reach the party service (${stage}: ${detail}). Your ISP or network may be blocking Cloudflare right now — a VPN or Cloudflare WARP usually gets around this.`;
  }
  return `Could not establish a secure connection to the party service (${detail}). Check your Windows clock and network settings.`;
}

export function clearPreferredAddresses(){preferred.clear();}
