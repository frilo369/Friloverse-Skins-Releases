// Read-only checks of the current public Mayhem sources; no League or LTK Manager changes.
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {MayhemData} from '../src/guide-data.mjs';
import {parseMayhemBuild,normaliseCatalogue} from '../src/ui/guide/mayhem-data.mjs';
const dir=await mkdtemp(path.join(tmpdir(),'friloverse-mayhem-live-'));
try{
  const data=new MayhemData(dir);
  const [guide,catalogue]=await Promise.all([data.guide(1,true),data.catalogue()]);
  const build=parseMayhemBuild(guide.build.value,1);
  const english=normaliseCatalogue(catalogue.sources);
  if(!build.augments.length||!Object.keys(english.champions).length||!Object.keys(english.items).length||!Object.keys(english.augments).length)throw new Error('Mayhem source coverage is incomplete.');
  console.log(`Mayhem sources passed: date ${guide.rankingDate}, ${build.augments.length} augments, ${Object.keys(english.champions).length} English champions.`);
}finally{await rm(dir,{recursive:true,force:true});}
