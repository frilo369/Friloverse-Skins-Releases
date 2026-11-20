import {championFromDraft,championFromGameflow,customFromSession,isLobbyPickLobby,mapFromSession,nextSighting,queueFromSession,swiftplaySlotsFromLobby} from './guide-match.mjs';
import {champSelectSkinSlots,gameflowSkinSlots,leagueConnection,leagueGet} from './league-client.mjs';
import {LOBBY_TOPICS,LeagueEvents,TOPICS} from './league-events.mjs';

const ACTIVE=new Set(['ChampSelect','GameStart','InProgress','Reconnect','WaitingForStats','PreEndOfGame']);
const POST_GAME=new Set(['WaitingForStats','PreEndOfGame']);
const SKIN_PHASES=new Set(['ChampSelect','GameStart','InProgress','Reconnect']);
const LOBBY_PHASES=new Set(['Lobby','Matchmaking','ReadyCheck']);
const INGAME_POLL_MS=2000;
const POST_GAME_LOSS_MS=5*60*1000;

export class GuideWatcher{
  constructor(onChange,{readConnection=leagueConnection,request=leagueGet,now=Date.now,listen=onEvent=>new LeagueEvents(onEvent,{topics:[...TOPICS,...LOBBY_TOPICS]})}={}){
    this.onChange=onChange;this.readConnection=readConnection;this.request=request;this.now=now;this.listen=listen;
    this.sighting={phase:'',mode:null,champion:null};this.lostAt=null;this.busy=false;this.stopped=false;this.retryAt=0;
    // The draft as League's client last gave it, for whoever else needs it: one reading for all.
    this.draft=null;this.draftId=0;this.skinSlots=new Map();this.matchChampions=new Set();
    this.swiftplay={active:false,searching:false,slots:[]};
    this.lastClient=null;this.lastInGamePoll=-Infinity;this.again=false;this.events=null;
  }
  // Connectivity is separate from the last known match, which must survive an outage.
  get connected(){return !!this.sighting.phase&&(this.lostAt===null||this.now()-this.lostAt<10000);}
  /** League's client said something changed: look now, or once more after the look under way. */
  poke(){
    this.lastInGamePoll=-Infinity;
    if(this.busy)this.again=true;
    else void this.poll({urgent:true});
  }
  async poll({urgent=false}={}){
    if(this.busy||this.stopped)return;
    // During a steady InProgress match with champion already known, throttle background timer
    // polls to 2 s (WAMP events still wake immediately via poke()).
    if(!urgent&&this.sighting.phase==='InProgress'&&this.sighting.champion&&this.lostAt===null&&this.now()-this.lastInGamePoll<INGAME_POLL_MS){
      return;
    }
    this.busy=true;
    try{
      // While the League client is closed, look for it every two seconds.
      if(this.now()<this.retryAt)throw new Error('League client unavailable');
      let client;
      try{client=await this.readConnection();this.lastClient=client;}
      catch(error){this.retryAt=this.now()+2000;throw error;}
      const phase=await this.request(client,'/lol-gameflow/v1/gameflow-phase');
      if(typeof phase!=='string')throw new Error('Invalid League phase');
      // The client is there, so it can say when something changes.
      this.events?.use(client);
      let draft=null,session=null,recovered=null;
      if(SKIN_PHASES.has(phase)){
        const needDraft=phase==='ChampSelect'||phase==='GameStart'||!this.sighting.champion;
        const needSession=phase!=='InProgress'||!this.sighting.champion||!this.sighting.mode||!this.matchChampions.size;
        [draft,session]=await Promise.all([
          needDraft?this.request(client,'/lol-champ-select/v1/session').catch(()=>null):Promise.resolve(null),
          needSession?this.request(client,'/lol-gameflow/v1/session').catch(()=>null):Promise.resolve(null),
        ]);
        if(phase!=='ChampSelect'&&session&&!this.sighting.champion&&!championFromDraft(draft)){
          const player=await this.request(client,'/lol-summoner/v1/current-summoner').catch(()=>null);
          recovered=championFromGameflow(session,player);
        }
        if(phase==='InProgress')this.lastInGamePoll=this.now();
        this.swiftplay={active:false,searching:false,slots:[]};
      }else if(LOBBY_PHASES.has(phase)){
        const [lobby,search]=await Promise.all([
          this.request(client,'/lol-lobby/v2/lobby').catch(()=>null),
          phase==='Lobby'||phase==='Matchmaking'?this.request(client,'/lol-lobby/v2/lobby/matchmaking/search-state').catch(()=>null):Promise.resolve(null),
        ]);
        const active=isLobbyPickLobby(lobby);
        const slots=active?swiftplaySlotsFromLobby(lobby):[];
        const searching=active&&(phase==='Matchmaking'||phase==='ReadyCheck'||String(search?.searchState||'').toLowerCase()==='searching');
        this.swiftplay={active,searching,slots};
        this.matchChampions.clear();
      }else{
        this.swiftplay={active:false,searching:false,slots:[]};
        this.matchChampions.clear();
      }
      this.lostAt=null;
      this.draft=phase==='ChampSelect'?draft:null;
      const previous=this.sighting.phase;
      if(phase==='ChampSelect'&&previous!=='ChampSelect'){
        this.draftId++;this.skinSlots.clear();this.matchChampions.clear();
      }
      this.sighting=nextSighting(this.sighting,{phase,draft,queue:queueFromSession(session),map:mapFromSession(session),custom:customFromSession(session),recovered});
      this.readSkinSlots(phase,phase==='ChampSelect'||previous==='ChampSelect'||!this.skinSlots.size?draft:null,session);
      this.readMatchChampions(draft,session);
      if(!this.stopped)this.onChange(this.sighting);
    }catch{
      this.draft=null;
      this.lastClient=null;
      if(this.lostAt===null)this.lostAt=this.now();
      const lostFor=this.now()-this.lostAt;
      // Losing the client is not a dodge or a match ending. Keep its last active
      // sighting until it reports a real phase; post-game phases (WaitingForStats,
      // PreEndOfGame) clear after 5 minutes of disconnect so closing League after a
      // match never permanently blocks auto-updates.
      const clearable=!ACTIVE.has(this.sighting.phase)||(POST_GAME.has(this.sighting.phase)&&lostFor>=POST_GAME_LOSS_MS);
      if(lostFor>=10000&&this.sighting.phase&&clearable){
        this.sighting={phase:'',mode:null,champion:null};this.swiftplay={active:false,searching:false,slots:[]};
        if(!this.stopped)this.onChange(this.sighting);
      }
    }finally{
      this.busy=false;
      if(this.again){this.again=false;void this.poll({urgent:true});}
    }
  }
  readMatchChampions(draft,session){
    if(draft){
      for(const list of [draft.myTeam,draft.theirTeam]){
        if(Array.isArray(list))for(const row of list)if(Number.isSafeInteger(row?.championId)&&row.championId>0)this.matchChampions.add(row.championId);
      }
    }
    if(session?.gameData){
      for(const field of ['playerChampionSelections','teamOne','teamTwo']){
        const list=session.gameData[field];
        if(Array.isArray(list))for(const row of list)if(Number.isSafeInteger(row?.championId)&&row.championId>0)this.matchChampions.add(row.championId);
      }
    }
  }
  readSkinSlots(phase,draft,session){
    if(LOBBY_PHASES.has(phase)&&this.swiftplay.active){
      this.skinSlots.clear();
      for(const slot of this.swiftplay.slots)this.skinSlots.set(slot.championId,slot.skinSlot);
      return;
    }
    if(!SKIN_PHASES.has(phase)){this.skinSlots.clear();return;}
    // League can briefly omit a skin during the transition. Keep the last usable slot,
    // including a valid base selection (0), and prefer the match's final selection.
    if(draft){
      const slots=champSelectSkinSlots(draft);
      if(phase==='ChampSelect'&&Array.isArray(draft.myTeam)){
        const champions=new Set(draft.myTeam.map(row=>row?.championId));
        if(champions.has(this.sighting.champion))for(const champion of this.skinSlots.keys()){
          if(!champions.has(champion))this.skinSlots.delete(champion);
        }
      }
      for(const [champion,slot] of slots)this.skinSlots.set(champion,slot);
    }
    if(phase!=='ChampSelect')for(const [champion,slot] of gameflowSkinSlots(session,this.skinSlots,this.sighting.champion)){
      this.skinSlots.set(champion,slot);
    }
  }
  start(){
    this.events=this.listen(()=>this.poke());
    void this.poll({urgent:true});this.timer=setInterval(()=>void this.poll(),300);
  }
  stop(){this.stopped=true;clearInterval(this.timer);this.events?.stop();}
}
