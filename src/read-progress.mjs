// Reads a download's body while telling how far it is (6.3). The total is the Content-Length only
// when nothing is compressed in between: fetch counts what it unpacks, so a compressed length would
// stop short of the bytes read. Total 0 is unknown, and the strip then shows MB without a percentage.
export async function readWithProgress(response,onProgress=()=>{}){
  const encoding=String(response.headers?.get?.('content-encoding')||'identity').toLowerCase();
  const length=Number(response.headers?.get?.('content-length'));
  const total=encoding==='identity'&&Number.isSafeInteger(length)&&length>0?length:0;
  const chunks=[];let bytes=0;
  onProgress({bytes:0,total});
  for await(const piece of response.body){
    const chunk=Buffer.from(piece);
    chunks.push(chunk);bytes+=chunk.length;
    onProgress({bytes,total:total&&Math.max(total,bytes)});
  }
  return Buffer.concat(chunks);
}
