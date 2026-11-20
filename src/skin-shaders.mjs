import path from 'node:path';
import {xxh64} from './league-icons.mjs';
import {parseBin,plainRow,readWadHashesOnDisk,unpackRow,wadRows,writeBin,writeWadRows} from './skin-slots.mjs';

// Some custom skins add a shader of their own (Unohana Master Yi: AnimeToon). To do that they
// ship League's whole shader list, `Shaders.wad`, as it was on the patch they were made on, plus
// compiled programs in `ShaderCache.*.wad`. Today's League then has old Riot shaders it fails to
// compile (the game closes about 30 s in), and without the list the skin's own shader is missing
// (the game closes while loading). So a skin keeps only what it adds: League's current list with
// the skin's new shader entries added, and files League does not have. Every copy of a Riot file
// is left out.
export const SHADER_WAD=/^wad\/(shaders|shadercache\.[^/]+)\.wad\.client(?:\/(.+))?$/i;
const HASHED=/^([0-9a-f]{16})(?:\.|$)/i;

/** Where League keeps this shader WAD, from its name in a skin. */
export function leagueShaderWad(league,name){
  const base=/^shaders\./i.test(name)?path.join('Shaders','Shaders.wad.client'):name;
  return path.join(league,'Game','DATA','FINAL',base);
}

/** League's bin with the skin's new top-level entries added; null when the skin adds none. */
export function mergeBin(game,skin){
  const ours=parseBin(game),theirs=parseBin(skin);
  if(!ours||!theirs||ours.version!==theirs.version)return null;
  const present=new Set(ours.objects.map(row=>row.hash));
  const added=theirs.objects.filter(row=>!present.has(row.hash));
  return added.length?writeBin({...ours,objects:[...ours.objects,...added]}):null;
}

/** The bytes this member should be in the skin's copy, or null to leave it out. */
function fit(row,game,skin){
  if(!game.has(row.hash))return skin;
  const ours=game.get(row.hash);
  return ours&&skin?mergeBin(ours,skin):null;
}

/** The skin's files with its shader WADs fitted to the installed League (see above). */
export async function fitShaders(files,league){
  const groups=new Map();
  for(const row of files){
    const match=SHADER_WAD.exec(row.name);
    if(!match)continue;
    const name=`${match[1]}.wad.client`.toLowerCase();
    if(!groups.has(name))groups.set(name,[]);
    groups.get(name).push({row,loose:match[2]});
  }
  const drop=new Set(),changed=new Map();
  for(const [name,items] of groups){
    const members=[];
    for(const {row,loose} of items){
      if(loose){
        const hashed=HASHED.exec(loose.split('/').pop()),hash=hashed&&!loose.includes('/')?BigInt(`0x${hashed[1]}`):xxh64(loose.toLowerCase());
        members.push({row,hash,read:()=>row.bytes});
      }else{
        let rows;
        try{rows=wadRows(row.bytes);}catch{drop.add(row);continue;}
        for(const member of rows)members.push({row,member,hash:member.hash,read:()=>{try{return unpackRow(member);}catch{return null;}}});
      }
    }
    const game=await readWadHashesOnDisk(leagueShaderWad(league,name),members.map(item=>item.hash));
    const kept=new Map();
    for(const item of members){
      const bytes=game?fit(item,game,item.read()):null;
      if(!item.member){if(bytes)item.row.bytes=bytes;else drop.add(item.row);continue;}
      if(!kept.has(item.row))kept.set(item.row,[]);
      if(bytes)kept.get(item.row).push(game.has(item.hash)?plainRow(item.hash,bytes):item.member);
    }
    for(const [row,rows] of kept){
      if(rows.length)changed.set(row,writeWadRows(row.bytes,rows));else drop.add(row);
    }
  }
  for(const [row,bytes] of changed)row.bytes=bytes;
  return files.filter(row=>!drop.has(row));
}
