import test from 'node:test';
import assert from 'node:assert/strict';
import {artSources,normaliseCatalogue} from '../src/ui/guide/mayhem-data.mjs';
import {MayhemData} from '../src/guide-data.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

const CD='https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/';
const icons=name=>`/lol-game-data/assets/ASSETS/UX/Cherry/Augments/Icons/${name}`;
const filler=(prefix,count,extra={})=>Array.from({length:count},(_,i)=>({id:1000+i,name:`${prefix} ${i}`,...extra}));
function catalogue(){
  return normaliseCatalogue({
    champions:filler('Champion',100,{squarePortraitPath:'/lol-game-data/assets/v1/champion-icons/1.png'}).map((row,i)=>({...row,id:i+1})),
    items:filler('Item',100),
    augments:[
      ...filler('Filler',100).map(row=>({...row,nameTRA:row.name,augmentNameId:row.name,augmentSmallIconPath:icons('filler_small.png'),rarity:'kSilver'})),
      {id:1,nameTRA:'Magic Missile',augmentNameId:'MagicMissile',augmentSmallIconPath:icons('MagicMissile_small.png'),rarity:'kGold'},
      {id:2,nameTRA:'Eureka',augmentNameId:'Eureka',augmentSmallIconPath:icons('Eureka_small.png'),rarity:'kPrismatic'},
      {id:3,nameTRA:'Archmage',augmentNameId:'ARAM_Archmage',augmentSmallIconPath:icons('Eureka_small.png'),rarity:'kPrismatic'},
      {id:4,nameTRA:'Quickstep',augmentNameId:'ARAM_Quickstep',augmentSmallIconPath:'/lol-game-data/assets/ASSETS/UX/Kiwi/Augments/Icons/GenericAbilityAugmentIcon_Gold.png',rarity:'kGold'},
    ],
    tencentAugments:[
      {augmentID:1,large_Icon:'https://game.gtimg.cn/images/lol/act/img/rune/magicmissile_large.png',small_Icon:'https://game.gtimg.cn/images/lol/act/img/rune/magicmissile_small.png'},
      {augmentID:3,large_Icon:'https://game.gtimg.cn/images/lol/act/img/rune/archmage_large.png',small_Icon:'https://evil.example/archmage_small.png'},
      {augmentID:4,large_Icon:'https://game.gtimg.cn/images/lol/act/img/rune/genericabilityaugmenticon_gold.png'},
    ],
  });
}

test('an augment shows its own art: League\'s large picture, then Tencent\'s, then Riot\'s small glyph',()=>{
  const data=catalogue();
  assert.deepEqual(artSources(data,'augments',data.augments[1]),[
    './art/assets/ux/cherry/augments/icons/magicmissile_large.png',
    'https://game.gtimg.cn/images/lol/act/img/rune/magicmissile_large.png',
    'https://game.gtimg.cn/images/lol/act/img/rune/magicmissile_small.png',
    './art/assets/ux/cherry/augments/icons/magicmissile_small.png',
    `${CD}assets/ux/cherry/augments/icons/magicmissile_small.png`,
  ]);
  assert.deepEqual(data.augments[3].tencentArt,['https://game.gtimg.cn/images/lol/act/img/rune/archmage_large.png'],'only Tencent\'s own picture host is kept');
});

test('a borrowed or placeholder picture gives way to art named after the augment',()=>{
  const data=catalogue();
  const archmage=artSources(data,'augments',data.augments[3]);
  assert.ok(archmage.indexOf('https://game.gtimg.cn/images/lol/act/img/rune/archmage_large.png')<archmage.indexOf(`${CD}assets/ux/cherry/augments/icons/eureka_small.png`));
  assert.ok(archmage.includes('./art/assets/ux/kiwi/augments/icons/archmage_large.png'));
  assert.ok(!archmage.includes('./art/assets/ux/cherry/augments/icons/eureka_large.png'),'Eureka\'s art is not Archmage\'s');
  const quickstep=artSources(data,'augments',data.augments[4]);
  assert.ok(!quickstep.some(url=>url.includes('gtimg')),'Tencent\'s placeholder is not used');
  assert.match(quickstep.at(-1),/genericabilityaugmenticon_gold\.png$/,'Riot\'s choice stays the last resort');
});

test('champion and item pictures come from League first, then CommunityDragon',()=>{
  const data=catalogue();
  assert.deepEqual(artSources(data,'champions',data.champions[1]),['./art/v1/champion-icons/1.png',`${CD}v1/champion-icons/1.png`]);
  assert.deepEqual(artSources(data,'items',{icon:''}),[]);
});

test('the English lists come from the installed League, and CommunityDragon only without it',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-mayhem-art-'));
  try{
    const asked=[],list=Array.from({length:120},(_,i)=>({id:i+1}));
    const data=new MayhemData(dir,{fetch:async url=>{asked.push(url);if(url.includes('gtimg'))throw new Error('offline');return list;}});
    data.local=async name=>name==='items.json'?null:list;
    const result=await data.catalogue();
    assert.equal(result.sources.champions.length,120);
    assert.deepEqual(asked.filter(url=>url.includes('communitydragon')).map(url=>url.split('/').pop()),['items.json']);
    assert.deepEqual(result.sources.tencentAugments,[],'Tencent being unreachable leaves the guide whole');
  }finally{await rm(dir,{recursive:true,force:true});}
});
