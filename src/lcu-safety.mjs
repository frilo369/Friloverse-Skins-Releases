import {processRunning} from './process-list.mjs';

export const GAME_EXECUTABLES=['League of Legends.exe','League of Legends (TM) Client.exe'];

/** Fail closed if the local game process cannot be checked. */
export async function noGameProcess() {
  try{
    for(const name of GAME_EXECUTABLES)if(await processRunning(name))return false;
    return true;
  }catch{return false;}
}
