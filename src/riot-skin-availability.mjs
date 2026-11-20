// 10.6 (owner, 2026-11-19): LTK's in-game patcher `ltk_patcher-32` (delivered 2026-11-18) refuses
// some official Riot skins used as a mod ("base-skin check") and then turns the whole overlay off,
// custom skins included. Friloverse offers no Riot skins by default: no tab, no picks, no Local
// Skins stand-ins and no friend's Riot pick reaches LTK. Never get around LTK's check.
// 10.8: Friloverse ships the LTF bridge (`src/ltf-bridge.mjs`, built from `native/ltf`) and
// `main.cjs` then calls setRiotSkinsOff(false). Without that bridge the default below stays.
// 12.1: Revenant Reign Viego and its six swords use the 10.11 rebuilt model, so the family is
// offered again (owner, 2026-11-19).
export let RIOT_SKINS_OFF=true;
/** For tests only: the Riot paths keep their tests for the day LTK allows these skins again. */
export function setRiotSkinsOff(off){RIOT_SKINS_OFF=!!off;}
const OFF_ERROR='LTK Manager no longer loads Riot\'s own skins in game. Choose a custom or local skin.';

export function riotSkinUnavailable(id){
  if(RIOT_SKINS_OFF)return OFF_ERROR;
  // 10.6's proven refusal: Winterblessed Hecarim and its chromas. One refused mod turns
  // the whole overlay off, so they stay out even with Rose's injection path.
  if(id>=120031&&id<=120040){
    return 'LTK Manager refused Winterblessed Hecarim in a real game. Choose another skin.';
  }
  return '';
}
