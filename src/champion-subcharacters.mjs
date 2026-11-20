// Champion sub-characters and form character records carried inside champion WADs.
// Used for selected-slot retargeting (skin-slots.mjs), custom skin compatibility, and
// slot-0 loading-screen name protection so transformed forms keep the champion's name in chat.

export const SUBCHARACTERS={
  anivia:['aniviaegg','aniviaiceblock'],
  annie:['annietibbers'],
  aphelios:['apheliosturret'],
  aurora:['auroraspirits'],
  azir:['azirsoldier','azirsundisc','azirtowerclicker','azirultsoldier'],
  bard:['bardfollower','bardhealthshrine','bardpickup','bardpickupnoicon','bardportalclickable'],
  belveth:['belvethspore','belvethvoidling'],
  caitlyn:['caitlyntrap'],
  cassiopeia:['cassiopeia_death'],
  elise:['elisespider','elisespiderling'],
  fiddlesticks:['fiddlestickseffigy'],
  fizz:['fizzbait','fizzshark'],
  gangplank:['gangplankbarrel'],
  gnar:['gnarbig'],
  heimerdinger:['heimertblue','heimertyellow'],
  illaoi:['illaoiminion'],
  irelia:['ireliablades'],
  ivern:['ivernminion','iverntotem'],
  jarvaniv:['jarvanivstandard','jarvanivwall'],
  jhin:['jhintrap'],
  jinx:['jinxmine'],
  kalista:['kalistaaltar','kalistaspawn'],
  kindred:['kindredjunglebountyminion','kindredwolf'],
  kled:['kledmount','kledrider'],
  kogmaw:['kogmawdead'],
  lissandra:['lissandrapassive'],
  locke:['locketotem'],
  lulu:['lulufaerie','lulupolymorphcritter'],
  lux:['luxair','luxdark','luxfire','luxice','luxmagma','luxmystic','luxnature','luxstorm','luxwater'],
  malzahar:['malzaharvoidling'],
  maokai:['maokaisproutling'],
  milio:['miliominion'],
  monkeyking:['monkeykingclone','monkeykingflying'],
  naafiri:['naafiripackmate'],
  nasus:['nasusult'],
  nidalee:['nidaleecougar','nidaleespear'],
  nunu:['nunusnowball'],
  olaf:['olafaxe'],
  orianna:['oriannaball','oriannanoball'],
  ornn:['ornnram'],
  quinn:['quinnvalor'],
  rammus:['rammusdbc','rammuspb'],
  reksai:['reksaitunnel'],
  senna:['sennasoul'],
  shaco:['shacobox'],
  shen:['shenspirit'],
  shyvana:['shyvanadragon'],
  sona:['sonadjgenre01','sonadjgenre02','sonadjgenre03'],
  swain:['swaindemonform'],
  syndra:['syndraorbs','syndrasphere'],
  taliyah:['taliyahwallchunk'],
  teemo:['teemomushroom'],
  thresh:['threshlantern'],
  trundle:['trundlewall'],
  viego:['viegosoul'],
  viktor:['viktorsingularity'],
  yorick:['yorickbigghoul','yorickghoulmelee','yorickwghoul','yorickwinvisible'],
  zac:['zacrebirthbloblet'],
  zed:['zedshadow'],
  zoe:['zoeorbs'],
  zyra:['zyragraspingplant','zyrapassive','zyraseed','zyrathornplant'],
};

// Forms and objects whose character `.bin` also prints `game_character_displayname_<alias>` in chat/overhead.
export const FORM_RECORDS={
  cassiopeia:['cassiopeia_death'],
  elise:['elisespider'],
  fiddlesticks:['fiddlestickseffigy'],
  fizz:['fizzbait','fizzshark','jade_fizzbait','jade_fizzshark'],
  kogmaw:['jade_kogmawdead','kogmawdead'],
  locke:['locketotem'],
  lux:['luxair','luxdark','luxfire','luxice','luxmagma','luxmystic','luxnature','luxstorm','luxwater'],
  monkeyking:['monkeykingflying'],
  nasus:['jade_nasusult','nasusult'],
  nidalee:['jade_nidaleecougar','nidaleecougar'],
  orianna:['oriannaball','oriannanoball'],
  quinn:['quinnvalor'],
  rammus:['jade_rammusdbc','jade_rammuspb','rammusdbc','rammuspb'],
  shyvana:['jade_shyvanadragon','shyvanadragon'],
  sona:['sonadjgenre01','sonadjgenre02','sonadjgenre03'],
  swain:['jade_swaindemonform','swaindemonform'],
  syndra:['syndraorbs','syndrasphere'],
  zed:['zedshadow'],
  zoe:['zoeorbs'],
};

const ALIAS_MAP={wukong:'monkeyking',renataglasc:'renata',nunuwillump:'nunu'};

export function normalizeAlias(name){
  const clean=String(name||'').replace(/[^a-z0-9]/gi,'').toLowerCase();
  return ALIAS_MAP[clean]||clean;
}

export function subcharactersOf(alias){
  return SUBCHARACTERS[normalizeAlias(alias)]||[];
}

export function formRecordsOf(alias){
  return FORM_RECORDS[normalizeAlias(alias)]||[];
}
