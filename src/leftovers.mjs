import {access,mkdir,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';

// Left in the data folder by older versions. Nothing has read any of these for a long time.
const OLD=['riot-skins','riot-database','restart-old-games','database-imports.json'];
const CLEARED='prepared-skins-cleared-7.3';

/**
 * Removes what older versions left behind. Since 7.3 a custom skin is prepared when it is picked,
 * so the copies made ahead of time for the whole library (about 2 GB) go, once. Copies kept from
 * picks after that stay. Cleared before the marker is written: a crash between the two only means
 * the folder is cleared again.
 */
export async function removeLeftovers(dataDir){
  await Promise.allSettled(OLD.map(name=>rm(path.join(dataDir,name),{recursive:true,force:true})));
  const marker=path.join(dataDir,CLEARED);
  if(await access(marker).then(()=>true,()=>false))return;
  await rm(path.join(dataDir,'prepared-skins'),{recursive:true,force:true});
  await mkdir(dataDir,{recursive:true});
  await writeFile(marker,'');
}
