import {readdir,readFile,stat} from 'node:fs/promises';
import path from 'node:path';

// Downstream LTK Manager log verdict classifier.
// LTK's bridge JSON API never reports in-game overlay refusals (`VRF########`), anti-skinhack
// rejections (`overlay verification failed`), late joins (`joined too late`), broken hidden mods
// (`Skipping broken mod entry`), or outdated patcher incidents — they only appear in
// `%APPDATA%\dev.leaguetoolkit.manager\logs\ltk-manager.*.log`.

const VRF_RE=/host verification failed[^[]*\[(VRF\d{8})\](?:\s*\(([^)]+)\))?/i;
const SIGNATURE_RE=/0x(?:800960[0-9a-f]{2}|800b0[0-9a-f]{3})/i;
const OVERLAY_DISABLED_RE=/overlay verification failed,\s*disabling overlay:\s*(.+)/i;
const LATE_JOIN_RE=/joined too late,\s*not overlaying/i;
const DLL_NOT_ATTACHED_RE=/DLL never attached after\s+(\d+)\s*s/i;
const INCIDENT_RE=/Incident recorded:\s*(.+?)\s+id=([^\s]+)\s+verdict=([^\s]+)/i;
const BROKEN_ENTRY_RE=/Skipping broken mod entry\s+([0-9a-f-]{8,64})/i;
const SLOW_SWEEP_RE=/Swept mod health in\s+(\d+(?:\.\d+)?)\s*s/i;
const OVERLAY_VERIFIED_RE=/overlay verified\s+(\d+)\s+wad/i;
const PATCHER_ERROR_RE=/\bERROR\b.*?(No patcher DLL is available|os error 740|error sending request|ltk_patcher_host\.exe not found|Unsupported Game Build)/i;

/** Parse a chunk of LTK Manager log lines into structured verdicts and broken mod IDs. */
export function parseLtkLogLines(text){
  const findings=[],brokenModIds=new Set();
  let verifiedWads=0;
  for(const raw of String(text||'').split(/\r?\n/)){
    const line=raw.trim();
    if(!line)continue;
    let m;
    if((m=OVERLAY_VERIFIED_RE.exec(line))){
      verifiedWads=Math.max(verifiedWads,Number(m[1])||0);
    }
    if((m=BROKEN_ENTRY_RE.exec(line))){
      brokenModIds.add(m[1]);
    }
    if((m=VRF_RE.exec(line))){
      const code=m[1].toUpperCase(),payload=m[2]||'';
      const sig=SIGNATURE_RE.test(line);
      findings.push({
        code:'LTK_HOST_REFUSED',
        vrfCode:code,
        signature:sig,
        title:`LTK Manager refused the overlay (${code})`,
        detail:sig
          ?`Windows signature verification failed (${code}${payload?`: ${payload}`:''}).`
          :`LTK Manager host verification failed (${code}${payload?`: ${payload}`:''}).`,
        fix:sig
          ?'Reinstall LTK Manager and check Windows Date & time (clock drift breaks Authenticode signatures).'
          :'Make sure neither League, LTK Manager, nor ltk_launcher.exe is set to Run as administrator, and close any manually opened LTK Manager.',
      });
      continue;
    }
    if((m=OVERLAY_DISABLED_RE.exec(line))){
      findings.push({
        code:'LTK_OVERLAY_REFUSED',
        title:'LTK Manager disabled skins for this match',
        detail:m[1].trim(),
        fix:'One of the staged skins or mods failed LTK Manager\'s in-game check. Try another skin or disable custom mods to find the culprit.',
      });
      continue;
    }
    if(LATE_JOIN_RE.test(line)){
      findings.push({
        code:'LTK_LATE_JOIN',
        title:'Skins arrived after League already loaded',
        detail:'LTK Manager reported "joined too late, not overlaying".',
        fix:'Pick your skin a few seconds earlier in champion select, or use the Reconnect screen to re-apply skins.',
      });
      continue;
    }
    if((m=DLL_NOT_ATTACHED_RE.exec(line))){
      findings.push({
        code:'LTK_DLL_NOT_ATTACHED',
        title:`LTK patcher DLL did not attach after ${m[1]} s`,
        detail:line.slice(0,220),
        fix:'Check your antivirus quarantine/block history (especially Defender, Smart App Control, or 360/Qihoo) and make sure League is not running as administrator.',
      });
      continue;
    }
    if((m=INCIDENT_RE.exec(line))){
      const [,title,id,verdict]=m;
      if(/PatcherOutOfDate|CorruptArchive/i.test(verdict)||/Unsupported Game Build/i.test(title)){
        findings.push({
          code:`LTK_INCIDENT_${verdict.toUpperCase()}`,
          title:`LTK Manager incident: ${title.trim()}`,
          detail:`Incident ${id} (${verdict}).`,
          fix:/PatcherOutOfDate|Unsupported/i.test(`${verdict} ${title}`)
            ?'League updated faster than LTK Manager\'s patcher. Wait for LTK Manager to deliver its patcher update and restart Friloverse.'
            :'One of your installed archives in LTK Manager is corrupt. Try re-downloading or removing the broken mod.',
        });
      }
      continue;
    }
    if((m=SLOW_SWEEP_RE.exec(line))&&Number(m[1])>=30){
      findings.push({
        code:'LTK_SLOW_MOD_CHECK',
        title:`LTK Manager health sweep took ${Math.round(Number(m[1]))} s`,
        detail:'A slow background health sweep delayed loading.',
        fix:'Remove unused large archives from LTK Manager\'s library so matches stage faster.',
      });
      continue;
    }
    if((m=PATCHER_ERROR_RE.exec(line))){
      findings.push({
        code:'LTK_PATCHER_ERROR',
        title:`LTK Manager error: ${m[1]}`,
        detail:line.slice(0,220),
        fix:/740/i.test(m[1])
          ?'Turn off "Run this program as an administrator" on ltk-manager.exe and ltk_patcher_host.exe.'
          :'Check your internet connection and antivirus exclusions for LTK Manager, then try again.',
      });
    }
  }
  return {findings,brokenModIds:[...brokenModIds],verifiedWads};
}

/** Check LTK Manager's `settings.json` for heavy built-in mods that force ~16 GB WAD rebuilds. */
export async function checkLtkBuiltins(ltkDir){
  try{
    const raw=await readFile(path.join(ltkDir,'settings.json'),'utf8');
    const settings=JSON.parse(raw);
    const builtins=settings?.builtinMods||{};
    const heavy=[];
    if(builtins.baseSkins==='allChampions')heavy.push('Base Skins (All Champions)');
    if(builtins.characterInking?.scope==='all')heavy.push('Character Inking (All)');
    if(!heavy.length)return null;
    return {
      code:'LTK_HEAVY_BUILTINS',
      title:'LTK Manager has heavy built-in mods turned on',
      detail:`Enabled built-in mod(s): ${heavy.join(', ')}. These force LTK Manager to rebuild every champion archive before each match.`,
      fix:'Open LTK Manager → Settings / Built-in Mods and switch them off (or to single-champion) so games load in seconds.',
    };
  }catch{return null;}
}

/** Incremental tail over `%APPDATA%\dev.leaguetoolkit.manager\logs\ltk-manager*.log`. */
export class LtkLogTail{
  constructor({ltkDir}){
    this.logsDir=path.join(ltkDir,'logs');
    this.file='';this.offset=0;
  }
  async latestLog(){
    const entries=(await readdir(this.logsDir).catch(()=>[])).filter(name=>/^ltk-manager.*\.log$/i.test(name)).sort();
    return entries.length?path.join(this.logsDir,entries.at(-1)):'';
  }
  /** Position the cursor at the current end of the newest LTK log before starting a match. */
  async mark(){
    const file=await this.latestLog();
    this.file=file;
    this.offset=file?await stat(file).then(info=>info.size,()=>0):0;
  }
  /** Read and classify all new log bytes written since the last `mark()` or `poll()`. */
  async poll(){
    const file=await this.latestLog();
    if(!file)return {findings:[],brokenModIds:[],verifiedWads:0,text:''};
    const info=await stat(file).catch(()=>null);
    if(!info)return {findings:[],brokenModIds:[],verifiedWads:0,text:''};
    if(file!==this.file||info.size<this.offset){this.file=file;this.offset=0;}
    if(info.size===this.offset)return {findings:[],brokenModIds:[],verifiedWads:0,text:''};
    const text=(await readFile(file,'utf8').catch(()=>'')).slice(this.offset);
    this.offset=info.size;
    return {...parseLtkLogLines(text),text};
  }
}
