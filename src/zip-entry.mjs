/**
 * One archive entry into a single buffer of its size. The archives are opened with
 * validateEntrySizes, so the size is exact and no second copy (chunks joined afterwards) is held.
 */
export async function readEntry(zip,entry){
  const bytes=Buffer.allocUnsafe(entry.uncompressedSize);
  let at=0;
  for await(const chunk of await zip.openReadStreamPromise(entry)){
    if(at+chunk.length>bytes.length)throw new Error('The skin archive is damaged.');
    chunk.copy(bytes,at);at+=chunk.length;
  }
  if(at!==bytes.length)throw new Error('The skin archive is damaged.');
  return bytes;
}
