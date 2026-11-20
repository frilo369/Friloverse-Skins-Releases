import {partyVersionError} from '../shared/party-version.mjs';
import {modSelectionIdentity} from './party-mods.mjs';
import {DISBANDED_CLOSE, KICKED_CLOSE} from '../party-relay/src/protocol.mjs';
const PARTY_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CREATE_COLLISION_ATTEMPTS = 5;
const LINK_CHECK = 10000, LINK_SILENCE = 10000;
/** A party name has to fit beside the icon it is drawn with. */
export const MAX_MEMBER_NAME = 12;

export function normalizePartyCode(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function createPartyCode(randomValues = values => crypto.getRandomValues(values)) {
  const values = randomValues(new Uint8Array(4));
  return Array.from(values, value => PARTY_ALPHABET[value % PARTY_ALPHABET.length]).join('');
}

function normalizedRelative(relative) {
  return String(relative ?? '').replaceAll('\\', '/').replace(/^\/+/, '').toLowerCase();
}

/** One member's skins as a comparable value, whatever order they were sent in. */
function skinsIdentity(skins) {
  return JSON.stringify([...skins]
    .map(skin => [skin.championId, skin.source, normalizedRelative(skin.relative), skin.sha ?? ''])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0]))));
}

export function samePartySelections(leftSkins,leftMods,rightSkins,rightMods) {
  return skinsIdentity(leftSkins)===skinsIdentity(rightSkins)
    && modSelectionIdentity(leftMods)===modSelectionIdentity(rightMods);
}

/** A skin as the party names it. A custom skin also carries Git's name for its
 * contents: the same skin has another file name on a PC that got it from the
 * shared collection, and the contents are what find it there. */
export function makeSkinKey(championId, file) {
  const key = {
    source: file.source,
    championId,
    relative: normalizedRelative(file.relative),
  };
  if(file.source === 'custom' && typeof file.sha === 'string' && /^[0-9a-f]{40}$/.test(file.sha)) key.sha = file.sha;
  return key;
}

export function resolveSkinKey(groups, key) {
  if(!key || (key.source !== 'official' && key.source !== 'custom')) return null;
  // The official and custom catalogues each contain this champion. Search for
  // the exact file in both instead of stopping at the first champion entry.
  const relative = normalizedRelative(key.relative);
  const needsContents = key.source === 'custom' && typeof key.sha === 'string' && /^[0-9a-f]{40}$/.test(key.sha);
  for(const champion of groups) {
    if(champion.id !== key.championId) continue;
    const file = champion.files.find(candidate =>
      candidate.source === key.source && normalizedRelative(candidate.relative) === relative
      && (!needsContents || candidate.sha === key.sha)
    );
    if(file) return {champion,file};
  }
  // The same custom skin under another file name: the contents decide.
  if(needsContents) {
    for(const champion of groups) {
      if(champion.id !== key.championId) continue;
      const file = champion.files.find(candidate => candidate.source === 'custom' && candidate.sha === key.sha);
      if(file) return {champion,file};
    }
  }
  return null;
}

/** One skin key as the log writes it: `MasterYi custom:master yi/ghostface.fantome`. */
export function describeSkinKey(key) {
  return `${key?.championId ?? '?'} ${key?.source ?? '?'}:${normalizedRelative(key?.relative)}`;
}

/**
 * The party's selection as this member can apply it. `usable` holds, by
 * champion, the skins found in this member's library; `skipped` the keys whose
 * file this member does not have; and `keepOwn` the champions whose party pick
 * was skipped, where this member keeps the skin of their own they already have
 * rather than being left with nothing for that champion.
 */
export function resolvePartySelection(desired, groups) {
  const usable = new Map();
  const skipped = [];
  for (const [championId, key] of desired) {
    const match = resolveSkinKey(groups, key);
    if (match) usable.set(championId, match);
    else skipped.push(key);
  }
  const keepOwn = new Set(skipped.map(key => key?.championId).filter(championId => typeof championId === 'string'));
  return {usable, skipped, keepOwn};
}

/** Two release numbers compared part by part: 5.26.0 is newer than 5.9.0.
 * `null` when either is not a release number. */
export function compareVersions(left, right) {
  const parse = value => /^\d+(\.\d+){0,3}$/.test(String(value ?? '')) ? String(value).split('.').map(Number) : null;
  const a = parse(left), b = parse(right);
  if (!a || !b) return null;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

/** The newest release named in a party refusal that is newer than this app's,
 * or '' when the refusal names none. A party on a newer release is joined by
 * updating, so the caller offers the update. */
export function newerPartyVersion(message, mine) {
  let newest = '';
  for (const [version] of String(message ?? '').matchAll(/\b\d+\.\d+\.\d+\b/g)) {
    if (compareVersions(version, mine) > 0 && (!newest || compareVersions(version, newest) > 0)) newest = version;
  }
  return newest;
}

/** When a member's skin database was committed, out of the version the relay
 * carries (`2026-09-27T14:24:11Z~6550e69c67ea`). */
export function databaseVersionDate(version) {
  const date = String(version ?? '').split('~')[0];
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(date) ? date : '';
}

/** The newest app and database anyone in the party has, among those who said. */
function newestInParty(members) {
  let app = '', db = '';
  for (const member of members) {
    if (member?.app && (!app || compareVersions(member.app, app) > 0)) app = member.app;
    const date = databaseVersionDate(member?.db);
    if (date && date > databaseVersionDate(db)) db = member.db;
  }
  return { app, db };
}

/** Whether this member runs an older app, or has an older skin database, than
 * someone else in the party. A version a member did not report is not counted
 * against them - an older build that cannot say is told by the relay instead. */
export function memberBehind(member, members) {
  const newest = newestInParty(members);
  return {
    app: Boolean(member?.app && newest.app && compareVersions(newest.app, member.app) > 0),
    db: Boolean(databaseVersionDate(member?.db) && databaseVersionDate(newest.db) > databaseVersionDate(member.db)),
  };
}

/** What this player is behind the party on, with the versions to say so, or
 * `null` when they are level with everyone. */
export function partyVersionGaps(members, selfId) {
  const list = Array.isArray(members) ? members : [];
  const me = list.find(member => member?.id === selfId);
  if (!me) return null;
  const behind = memberBehind(me, list);
  if (!behind.app && !behind.db) return null;
  const newest = newestInParty(list);
  return {
    app: behind.app ? { mine: me.app, newest: newest.app } : null,
    db: behind.db ? { mine: databaseVersionDate(me.db), newest: databaseVersionDate(newest.db) } : null,
  };
}

export function partyMemberIsReady(member, roundReadyMemberIds = new Set()) {
  return Boolean(member?.ready || roundReadyMemberIds?.has?.(member?.id));
}

/** One entry per member id, keeping the last one a message listed. */
export function uniqueMembers(members) {
  const byId = new Map();
  for (const member of Array.isArray(members) ? members : []) {
    if(member?.id) byId.set(member.id, member);
  }
  return [...byId.values()];
}

export function shouldResetPartyAfterGame(partyStatus, patcherRunning, resetPending = false) {
  return partyStatus !== 'idle' && patcherRunning && !resetPending;
}

/** Exactly-once claim, so two paths that race can never both act. */
export function createOnceGuard() {
  let used = false;
  return {
    get used() { return used; },
    claim() { if(used) return false; used = true; return true; },
    reset() { used = false; },
  };
}

/** Phases where the client holds no live match to reconnect to. */
const MATCH_OVER_PHASES = ['None','Lobby','Matchmaking','ReadyCheck','ChampSelect','FailedToLaunch','WaitingForStats','PreEndOfGame','EndOfGame','TerminatedInError'];

/** Whether the client still holds a match the player can reconnect to. */
export function hasLiveMatch(phase) {
  if(typeof phase !== 'string' || !phase) return false;
  return !MATCH_OVER_PHASES.includes(phase);
}

/** Whether the client still holds a game its player could be watching or rejoining.
 *
 * `GameStart` is the loading screen, which the client opens before the game
 * process has loaded anything: a process that disappears there has been quit, not
 * finished, and the difference is the whole point of the question.
 */
export function gameInProgress(phase) {
  return ['InProgress','GameStart','Reconnect'].includes(phase);
}

/** Whether a game exit leaves the round open for one member to force a patch.
 *
 * A game still in progress is a process that died mid-match or on the loading
 * screen. That is the one exit a member can act on, and it matters most when the
 * overlay never went live - that is the patch that has to be forced.
 */
export function shouldOfferPartyReconnect({partyStatus, gamePhase}) {
  if(partyStatus === 'idle') return false;
  return gameInProgress(gamePhase);
}

/** `Reconnect` is LCU's authoritative signal that League still owns a match
 * while no game process is attached. Recovery applies to solo users too; tying
 * this gate to Party Mode was why Force Patch disappeared for them. */
export function shouldEnterReconnectWindow({gamePhase, reconnectWindow, recoveryHandled=false}) {
  return !reconnectWindow && !recoveryHandled && gamePhase === 'Reconnect';
}

export function createPartyReconnectToken() {
  const bytes=new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');
}

/** The relay accepts this shape for the private identity of one member. A saved
 * value from an older build may not match it, and the fallback must. */
export function validPartyMemberId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{8,64}$/.test(value);
}

export function createPartyMemberId() {
  const uuid=globalThis.crypto?.randomUUID?.();
  if(validPartyMemberId(uuid)) return uuid;
  if(!globalThis.crypto?.getRandomValues) {
    return `member-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`;
  }
  const bytes=new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');
}

export class PartyClient {
  constructor({endpoint, clientId, reconnectToken = createPartyReconnectToken(), WebSocketImpl = globalThis.WebSocket, codeFactory = () => createPartyCode(), now = () => performance.now(), onDiagnostic = (_message) => {}, onChange = (_state) => {}, onSnapshot = (_skins,_authoritative,_revision,_mods) => {}, onReady = () => {}, onPatchStart = (_sequence) => {}, onEnded = (_reason) => {}}) {
    this.endpoint = endpoint.replace(/\/$/, '');
    this.clientId = clientId;
    this.reconnectToken = reconnectToken;
    this.WebSocketImpl = WebSocketImpl;
    this.codeFactory = codeFactory;
    this.now = now;
    this.onDiagnostic = onDiagnostic;
    this.onChange = onChange;
    this.onSnapshot = onSnapshot;
    this.onReady = onReady;
    this.onPatchStart = onPatchStart;
    this.onEnded = onEnded;
    this.socket = null;
    this.retryTimer = null;
    this.deliveryTimer = null;
    this.retryCount = 0;
    this.intentionalClose = false;
    this.createAttempts = 0;
    this.session = null;
    this.joinedRoom = false;
    this.state = {status:'idle', code:'', members:[], error:'', revision:0, patchSequence:0};
    this.clientRevision = 0;
    /* The champion this member is playing. The relay lets their pick for it win
       over anyone else's, so a friend's leftover pick cannot replace it. */
    this.playing = null;
    this.roomRevision = 0;
    this.preparationRevision = null;
    this.preparationSupported = false;
    this.launchSupported = false;
    this.launchAttempt = null;
    this.launchAgreement = null;
    this.sentLaunchMessage = new Map();
    this.sentPreparation = '';
    this.sentPreparationAt = 0;
    this.confirmedPreparation = '';
    this.localSkins = new Map();
    this.localMods = [];
    this.pendingSnapshot = null;
    /* The last skins the relay confirmed for this member, and the member
       revision the relay reported when this connection opened. */
    this.acknowledged = {revision:0, identity:'', playing:null};
    this.relayClientRevision = 0;
    /* The app and skin database this member runs, which the party compares. */
    this.meta = {app:'', db:''};
  }

  /** Say which app and skin database this member runs. Sent at once when the
   * party is connected, and with the next connection otherwise. */
  setMeta(meta) {
    const next = {app:String(meta?.app ?? ''), db:String(meta?.db ?? '')};
    if (next.app === this.meta.app && next.db === this.meta.db) return false;
    this.meta = next;
    if(this.state.status !== 'connected' || !this.socket || this.socket.readyState !== 1) return true;
    try {
      this.socket.send(JSON.stringify({type:'member-meta',...this.meta}));
    } catch {
      try { this.socket.close(); } catch { }
    }
    return true;
  }

  snapshot() { return {...this.state,members:[...this.state.members]}; }

  setState(change) {
    if(Array.isArray(change.members) && this.launchAgreement && this.launchAttempt) {
      change={...change,members:change.members.map(member=>{
        const report=this.launchAgreement.members.find(candidate=>candidate.id===member.id);
        return report?{...member,preparation:report.preparation}:member;
      })};
    }
    this.state = {...this.state,...change};
    this.onChange(this.snapshot());
  }

  create(code, name, icon) { this.connect(code,name,icon,'create'); }
  join(code, name, icon) { this.connect(code,name,icon,'join'); }

  connect(code, name, icon, mode) {
    if(!this.endpoint) throw new Error('Party service is not configured yet.');
    if(!this.WebSocketImpl) throw new Error('Party connections are unavailable on this system.');
    // Checked before anything is torn down or stored, so a refused code leaves
    // no half-made session behind it.
    const session = {code:normalizePartyCode(code),name:String(name).trim().slice(0,MAX_MEMBER_NAME),icon:String(icon ?? '').replace(/[^0-9]/g,'').slice(0,10),mode};
    if(!/^[A-Z0-9]{4}$/.test(session.code)) throw new Error('Enter a valid 4-character party code.');
    if(!session.name) throw new Error('Enter your party name.');
    this.leave(false);
    this.intentionalClose = false;
    this.createAttempts = 0;
    this.roomRevision = 0;
    this.preparationRevision = null;
    this.preparationSupported = false;
    this.sentPreparation = '';
    this.confirmedPreparation = '';
    this.state.patchSequence = 0;
    this.joinedRoom = false;
    this.acknowledged = {revision:0, identity:'', playing:null};
    this.relayClientRevision = 0;
    this.session = session;
    this.open();
  }

  open() {
    if(!this.session || this.intentionalClose) return;
    clearTimeout(this.retryTimer);
    this.setState({status:this.retryCount ? 'reconnecting' : 'connecting',code:this.session.code,members:this.retryCount ? this.state.members : [],error:this.retryCount ? this.state.error : ''});
    const url = new URL(`${this.endpoint}/party/${this.session.code}`);
    url.searchParams.set('mode',this.session.mode);
    url.searchParams.set('member',this.clientId);
    url.searchParams.set('name',this.session.name);
    if(this.session.icon) url.searchParams.set('icon',this.session.icon);
    // The public member ID identifies a contribution; only this private token
    // authorizes replacing its connection. It is never part of room messages.
    url.searchParams.set('protocol','5');
    url.searchParams.set('reconnect',this.reconnectToken);
    if(this.meta.app) url.searchParams.set('app',this.meta.app);
    if(this.meta.db) url.searchParams.set('db',this.meta.db);
    const socket = new this.WebSocketImpl(url.toString());
    this.socket = socket;
    this.watchLink(socket);
    let opened = false;
    socket.onopen = () => { opened = true; };
    socket.onmessage = event => {
      if(this.socket === socket) this.handleMessage(event.data);
    };
    socket.onerror = () => {
      if(this.socket === socket) {
        this.onDiagnostic('WebSocket error; party service could not be reached');
        this.setState({error:'Could not reach the party service.'});
      }
    };
    socket.onclose = event => {
      if(this.socket !== socket) return;
      this.onDiagnostic(`WebSocket closed: code=${event.code} intentional=${this.intentionalClose}`);
      this.socket = null;
      if(this.intentionalClose || !this.session) return;
      if(event.code === 4009 && this.session.mode === 'create' && this.createAttempts < CREATE_COLLISION_ATTEMPTS) {
        this.createAttempts += 1;
        this.session = {...this.session,code:this.codeFactory()};
        this.open();
        return;
      }
      // The host removed this member or closed the party: never rejoin it.
      if(event.code === KICKED_CLOSE || event.code === DISBANDED_CLOSE) {
        this.leave();
        this.onEnded(event.reason || (event.code === KICKED_CLOSE ? 'The host removed you from the party.' : 'The host left, so the party was closed.'));
        return;
      }
      if(event.code === 4001 || event.code === 4003 || event.code === 4004 || event.code === 4009 || event.code === 4010 || event.code === 4011) {
        const message = event.reason || (event.code === 4001 ? 'This party connection was replaced by a newer one. Rejoin to continue.' : event.code === 4003 ? 'Party is full.' : event.code === 4004 ? 'Party not found.' : event.code === 4010 ? 'Update FrYiLoCo to join this party.' : event.code === 4011 ? 'Party reconnect credential was rejected. Rejoin after the old connection expires.' : 'That party code is already in use.');
        this.session = null;
        this.setState({status:'idle',members:[],error:message});
        return;
      }
      // Only reset reconnect backoff once a connection stays alive past Cloudflare's 100 s idle window.
      if(this.connectedAt && this.now() - this.connectedAt >= 300000) this.retryCount = 0;
      this.connectedAt = 0;
      this.retryCount += 1;
      // Keep the last room visible until ready replaces it with the relay's current members.
      this.setState({status:'reconnecting',error:opened ? 'Connection lost. Reconnecting…' : 'Could not reach the party service. Retrying…'});
      const baseDelay = Math.min(1000 * 2 ** (this.retryCount - 1), 30000);
      const jitter = 0.75 + Math.random() * 0.5;
      const delay = Math.round(baseDelay * jitter);
      this.retryTimer = setTimeout(() => this.open(),delay);
    };
  }

  /** A link can die with nothing said: this member then keeps showing the room as it last
   * heard it, with joiners missing and leavers still there, until something else breaks. A ping
   * nobody answers ends the connection, and the reconnect brings the whole room again. Only a
   * relay already seen answering is held to it, so one that never does costs nothing. */
  watchLink(socket) {
    clearInterval(this.linkTimer);
    if(typeof socket.ping !== 'function' || typeof socket.on !== 'function') return;
    let pingedAt = 0;
    socket.on('pong',() => { pingedAt = 0; this.pongsWork = true; });
    const timer = setInterval(() => {
      if(this.socket !== socket) { clearInterval(timer); return; }
      if(socket.readyState !== 1) return;
      const now = this.now();
      if(pingedAt && this.pongsWork && now-pingedAt >= LINK_SILENCE) {
        clearInterval(timer);
        this.onDiagnostic('party link silent; reconnecting');
        socket.terminate();
        return;
      }
      try { socket.ping(); if(!pingedAt) pingedAt = now; } catch { }
    },LINK_CHECK);
    timer.unref?.();
    this.linkTimer = timer;
  }

  handleMessage(raw) {
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    if(!message || typeof message !== 'object' || Array.isArray(message)) return;
    // Old relays also reach this check. Ignore stale views before enforcing
    // admission, so a delayed prior snapshot cannot evict a current party.
    if(['ready','presence','snapshot','patch-start'].includes(message.type)
      && Array.isArray(message.members) && this.meta.app
      && (!Number.isSafeInteger(message.revision) || message.revision>=this.roomRevision)
      && (message.type!=='patch-start' || message.sequence>this.state.patchSequence)) {
      const error=partyVersionError(this.meta.app,uniqueMembers(message.members));
      if(error) { this.leave(); this.setState({error}); return; }
    }
    if(message.type === 'ready' || message.type === 'presence') {
      if(message.type==='ready') { this.launchSupported=message.launchSupported===true; this.preparationSupported=message.preparationSupported===true; this.preparationRevision=null; this.sentPreparation=''; this.confirmedPreparation=''; }
      const resumed = message.type === 'ready' && this.joinedRoom;
      const previousPatchSequence = this.state.patchSequence;
      if(message.type === 'ready') {
        this.connectedAt = this.now();
        if(this.session) this.session.mode = 'join';
        if(Number.isSafeInteger(message.clientRevision)) {
          this.clientRevision=Math.max(this.clientRevision,message.clientRevision);
          this.relayClientRevision=message.clientRevision;
        }
      }
      const revision=Number.isSafeInteger(message.revision) ? message.revision : this.roomRevision;
      if(revision < this.roomRevision) return;
      this.roomRevision=Math.max(this.roomRevision,revision);
      if(Number.isSafeInteger(message.patchSequence)) this.state.patchSequence=Math.max(this.state.patchSequence,message.patchSequence);
      if(message.type==='presence' && Number.isSafeInteger(message.preparationRevision)) this.preparationRevision=message.preparationRevision;
      this.setState({status:'connected',members:uniqueMembers(message.members),error:'',revision:this.roomRevision,patchSequence:this.state.patchSequence});
      if(message.type === 'ready') {
        this.preparationRevision=message.preparationRevision??0;
        this.joinedRoom = true;
        // A reconnect replaces the previous room view, including removals. A
        // first join still preserves personal picks until their sync is acked.
        this.onSnapshot(Array.isArray(message.skins) ? message.skins : [],resumed,this.roomRevision,Array.isArray(message.mods) ? message.mods : []);
        if(this.launchAttempt) this.sendLaunch({type:'launch-begin',attempt:this.launchAttempt});
        this.onReady();
        this.flushPending();
        // A reconnect can land after the relay broadcast patch-start. The
        // ready snapshot is authoritative, so a higher sequence finishes that
        // round locally instead of silently consuming it as already handled.
        if(resumed && this.state.patchSequence > previousPatchSequence) {
          this.onPatchStart(this.state.patchSequence);
        }
      }
    } else if(message.type === 'snapshot') {
      const revision=Number.isSafeInteger(message.revision) ? message.revision : this.roomRevision;
      this.acknowledge(message.ack);
      if(revision < this.roomRevision) return;
      this.roomRevision=revision;
      const skins=Array.isArray(message.skins) ? message.skins : [];
      if(Number.isSafeInteger(message.patchSequence)) this.state.patchSequence=Math.max(this.state.patchSequence,message.patchSequence);
      this.setState({members:uniqueMembers(Array.isArray(message.members) ? message.members : this.state.members),revision,patchSequence:this.state.patchSequence});
      // onChange may render the old local preparation before onSnapshot queues
      // the new room. Keep that report on the old revision, where it is ignored.
      this.preparationRevision=message.preparationRevision??this.preparationRevision??0;
      this.onSnapshot(skins,true,revision,Array.isArray(message.mods) ? message.mods : []);
    } else if(message.type === 'patch-start' && Number.isSafeInteger(message.sequence)) {
      if(message.sequence <= this.state.patchSequence) return;
      this.state.patchSequence=message.sequence;
      this.setState({members:uniqueMembers(Array.isArray(message.members) ? message.members : this.state.members),patchSequence:message.sequence});
      this.onPatchStart(message.sequence);
    } else if(message.type === 'launch-agreement') {
      this.receiveLaunchAgreement(message);
    } else if(message.type === 'error') {
      this.setState({error:String(message.message ?? 'Party error.')});
    }
    if(['ready','presence','snapshot'].includes(message.type)) {
      const own=Array.isArray(message.members)?message.members.find(member=>member?.id===this.clientId):null;
      const key=`${message.preparationRevision}:${own?.preparation}`;
      if(own && Number.isSafeInteger(message.preparationRevision) && key===this.sentPreparation && key!==this.confirmedPreparation) {
        this.confirmedPreparation=key;
        this.onDiagnostic(`preparation confirmed by relay: revision=${message.preparationRevision} state=${own.preparation}`);
      }
    }
  }

  sendSkin(skin) {
    if(!this.session) return false;
    this.localSkins.set(skin.championId,skin);
    return this.sendSnapshot([...this.localSkins.values()]);
  }

  removeSkin(championId) {
    if(!this.session) return false;
    this.localSkins.delete(championId);
    return this.sendSnapshot([...this.localSkins.values()]);
  }

  sendSnapshot(skins, mods = this.localMods) {
    if(!this.session) return false;
    this.localSkins=new Map(skins.map(skin=>[skin.championId,skin]));
    this.localMods=[...mods];
    this.clientRevision += 1;
    this.pendingSnapshot={type:'sync',clientRevision:this.clientRevision,skins:[...this.localSkins.values()],mods:[...this.localMods],playing:this.playing};
    this.flushPending();
    return true;
  }

  /** Say which champion this member is playing, or none. A change is sent with
   * the member's skins, unless `send` is false because a snapshot follows. */
  setPlaying(championId, send = true) {
    const playing = typeof championId === 'string' && championId ? championId : null;
    if(playing === this.playing) return false;
    this.playing = playing;
    return send ? this.sendSnapshot([...this.localSkins.values()]) : false;
  }

  /** Send this member's skins after a (re)connect only when the relay may not
   * hold them. A blip keeps the member's state on the relay, and a new revision
   * of the same skins would clear the member's ready in the last seconds of a
   * loadout window. */
  resync(skins, mods = this.localMods) {
    if(!this.session) return false;
    const unchanged = !this.pendingSnapshot
      && this.acknowledged.revision > 0
      && this.relayClientRevision >= this.acknowledged.revision
      && skinsIdentity(skins) === this.acknowledged.identity
      && modSelectionIdentity(mods) === (this.acknowledged.mods ?? '[]')
      && this.playing === this.acknowledged.playing;
    if(!unchanged) return this.sendSnapshot(skins,mods);
    this.localSkins=new Map(skins.map(skin=>[skin.championId,skin]));
    this.localMods=[...mods];
    return false;
  }

  clearSkins() {
    if(!this.session) return false;
    return this.sendSnapshot([],[]);
  }

  beginLaunch(attempt=crypto.randomUUID()) {
    this.endLaunch();
    this.launchAttempt=attempt;
    this.sendLaunch({type:'launch-begin',attempt});
  }

  endLaunch() {
    this.launchAttempt=null;
    this.launchAgreement=null;
    this.sentLaunchMessage.clear();
  }

  sendLaunch(message,refresh=false) {
    if(!this.launchSupported || this.state.status!=='connected' || this.socket?.readyState!==1) return false;
    const key=JSON.stringify(message),last=this.sentLaunchMessage.get(key);
    if(refresh && last!==undefined && this.now()-last<1200) return true;
    try {
      this.socket.send(key);
      this.sentLaunchMessage.set(key,this.now());
      return true;
    } catch {try {this.socket.close();} catch {} return false;}
  }

  requestLaunchFallback(members) {
    if(!this.launchAttempt || this.pendingSnapshot || !Number.isSafeInteger(this.preparationRevision)) return;
    this.sendLaunch({type:'launch-fallback',attempt:this.launchAttempt,revision:this.preparationRevision,members},true);
  }

  setLaunchPreparation(state) {
    if(!this.launchAgreement || !this.launchAttempt) return;
    this.sendLaunch({type:'launch-preparation',attempt:this.launchAttempt,sequence:this.launchAgreement.sequence,state},true);
  }

  receiveLaunchAgreement(message) {
    if(!this.launchAttempt || message.attempts?.[this.clientId]!==this.launchAttempt
      || !Number.isSafeInteger(message.sequence) || message.sequence<=0 || !Number.isSafeInteger(message.revision)
      || !Array.isArray(message.members) || !Array.isArray(message.participants)
      || !Array.isArray(message.skins) || !Array.isArray(message.mods)) return;
    const previous=this.launchAgreement;
    if(previous) {
      // Only preparation reports may change an accepted immutable certificate.
      const identity=value=>JSON.stringify([value.sequence,value.revision,value.attempts,value.clientRevisions,value.participants,value.skins,value.mods,value.members.map(member=>member.id)]);
      if(identity(previous)!==identity(message)) return;
    }
    this.launchAgreement={...message,invalidLocal:message.clientRevisions?.[this.clientId]!==this.clientRevision};
    if(!this.launchAgreement.invalidLocal) this.acknowledge({memberId:this.clientId,clientRevision:message.clientRevisions[this.clientId]});
    this.state.patchSequence=Math.max(this.state.patchSequence,message.sequence);
    this.setState({members:this.state.members});
    if(!previous) this.onDiagnostic(`launch agreement: round=${message.sequence} revision=${message.revision} degraded=${Boolean(message.degraded)} participants=${message.participants.length}`);
  }

  /** Remove another member. Only the host may; the relay refuses anyone else
   * and any removal while a match is starting. */
  kick(memberId) {
    if(this.state.status !== 'connected' || !this.socket || this.socket.readyState !== 1) return false;
    try {
      this.socket.send(JSON.stringify({type:'kick',member:String(memberId)}));
      return true;
    } catch {
      return false;
    }
  }

  setReady(ready) {
    if(this.state.status !== 'connected' || !this.socket || this.socket.readyState !== 1) return false;
    try {
      this.socket.send(JSON.stringify({type:'ready-state',ready:Boolean(ready),...(this.launchSupported && this.launchAttempt?{attempt:this.launchAttempt}:{})}));
      return true;
    } catch {
      try { this.socket.close(); } catch { }
      return false;
    }
  }

  setPreparation(state, {refresh = false} = {}) {
    if(!this.preparationSupported || !Number.isSafeInteger(this.preparationRevision) || this.state.status!=='connected' || this.socket?.readyState!==1) return;
    const key=`${this.preparationRevision}:${state}`;
    const repeated=this.sentPreparation===key;
    // The launch controller requests a fresh room confirmation while its build
    // barrier is pending. Bound retransmission; never start a readiness round.
    if(repeated && (!refresh || this.now()-this.sentPreparationAt<1200)) return;
    try {
      this.socket.send(JSON.stringify({type:'preparation',revision:this.preparationRevision,state}));
      if(!repeated) this.confirmedPreparation='';
      this.sentPreparation=key;
      this.sentPreparationAt=this.now();
      this.onDiagnostic(`preparation ${repeated?'refresh':'sent'}: revision=${this.preparationRevision} state=${state} relayEcho=${this.state.members.find(member=>member.id===this.clientId)?.preparation??'not reported'}`);
    } catch {
      this.sentPreparation='';
      this.onDiagnostic(`preparation send failed: revision=${this.preparationRevision} state=${state}`);
      try { this.socket.close(); } catch { }
    }
  }

  setIcon(icon) {
    if(!this.session) return false;
    const clean=String(icon ?? '').replace(/[^0-9]/g,'').slice(0,10);
    this.session={...this.session,icon:clean};
    if(this.state.status !== 'connected' || !this.socket || this.socket.readyState !== 1) return true;
    try {
      this.socket.send(JSON.stringify({type:'member-icon',icon:clean}));
    } catch {
      try { this.socket.close(); } catch { }
    }
    return true;
  }

  flushPending() {
    clearTimeout(this.deliveryTimer);
    if(this.state.status !== 'connected' || !this.socket || this.socket.readyState !== 1) return;
    try {
      if(this.pendingSnapshot) this.socket.send(JSON.stringify(this.pendingSnapshot));
    } catch {
      try { this.socket.close(); } catch { }
      return;
    }
    if(this.pendingSnapshot) {
      this.deliveryTimer=setTimeout(()=>this.flushPending(),1200);
      this.deliveryTimer?.unref?.();
    }
  }

  acknowledge(ack) {
    if(ack?.memberId !== this.clientId || !Number.isSafeInteger(ack.clientRevision)) return;
    if(this.pendingSnapshot && ack.clientRevision >= this.pendingSnapshot.clientRevision) {
      this.acknowledged={revision:this.pendingSnapshot.clientRevision, identity:skinsIdentity(this.pendingSnapshot.skins), mods:modSelectionIdentity(this.pendingSnapshot.mods), playing:this.pendingSnapshot.playing};
      this.pendingSnapshot=null;
    }
    if(!this.pendingSnapshot) clearTimeout(this.deliveryTimer);
  }

  leave(reset = true) {
    this.endLaunch();
    this.intentionalClose = true;
    clearInterval(this.linkTimer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.deliveryTimer);
    this.retryCount = 0;
    this.session = null;
    this.pendingSnapshot=null;
    const socket = this.socket;
    this.socket = null;
    if(socket && socket.readyState === 1) {
      try { socket.send(JSON.stringify({type:'leave'})); } catch { }
    }
    if(socket && socket.readyState < 2) socket.close(1000,'Left party');
    if(reset) {
      this.joinedRoom = false;
      this.setState({status:'idle',code:'',members:[],error:'',revision:0,patchSequence:0});
    }
  }
}
