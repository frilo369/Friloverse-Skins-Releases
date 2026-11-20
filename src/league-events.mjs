import WebSocket from 'ws';

// What League's client tells without being asked: its phase and its draft.
export const TOPICS=[
  'OnJsonApiEvent_lol-gameflow_v1_gameflow-phase',
  'OnJsonApiEvent_lol-champ-select_v1_session',
];
// Extra topics for Swiftplay / lobby-pick modes (subscribed by GuideWatcher).
export const LOBBY_TOPICS=[
  'OnJsonApiEvent_lol-lobby_v2_lobby',
  'OnJsonApiEvent_lol-lobby_v2_lobby_matchmaking_search-state',
];
const SUBSCRIBE=5,EVENT=8,RETRY=2000,PING_MS=20000,PONG_MS=10000;

/** The client's own event socket, on this PC only. Its certificate is Riot's self-signed one. */
export function socketRequest(client){
  return {url:`wss://127.0.0.1:${client.port}/`,protocol:'wamp',options:{
    headers:{Authorization:`Basic ${Buffer.from(`riot:${client.password}`).toString('base64')}`},
    rejectUnauthorized:false,handshakeTimeout:3000,perMessageDeflate:false,maxPayload:8*1024*1024,
  }};
}
function openSocket(client){
  const {url,protocol,options}=socketRequest(client);
  return new WebSocket(url,protocol,options);
}

/**
 * League's client says when its phase or its draft changes, so nothing waits for the next look
 * (owner's request, 2026-11-11: the end of the draft was seen 0.2 to 0.7 s late). It only says
 * that something changed: what changed is read the usual way, and the usual looks go on, so a
 * socket that is down, or silent, costs nothing but that delay. Outgoing, to 127.0.0.1 only.
 * The client's password is never logged.
 */
export class LeagueEvents{
  constructor(onEvent,{open=openSocket,now=Date.now,retry=RETRY,pingMs=PING_MS,pongMs=PONG_MS,topics=TOPICS}={}){
    Object.assign(this,{onEvent,open,now,retry,pingMs,pongMs,topics});
    this.socket=null;this.key='';this.live=false;this.retryAt=0;this.stopped=false;
    this.pingTimer=null;this.pongTimer=null;
  }
  /** The client that just answered: listen to it, unless that is already so. */
  use(client){
    if(this.stopped||!Number.isInteger(client?.port)||!client.password)return;
    const key=`${client.port}:${client.password}`;
    if(this.key===key&&(this.socket||this.now()<this.retryAt))return;
    this.drop();
    this.key=key;this.retryAt=this.now()+this.retry;
    let socket;
    try{socket=this.open(client);}catch{return;}
    this.socket=socket;
    socket.on('open',()=>{
      if(this.socket!==socket)return;
      try{for(const topic of this.topics)socket.send(JSON.stringify([SUBSCRIBE,topic]));}catch{return;}
      this.live=true;
      if(typeof socket.ping==='function'&&this.pingMs>0){
        this.pingTimer=setInterval(()=>{
          if(this.socket!==socket)return;
          try{socket.ping();}catch{this.drop();return;}
          clearTimeout(this.pongTimer);
          this.pongTimer=setTimeout(()=>{if(this.socket===socket)this.drop();},this.pongMs);
          this.pongTimer.unref?.();
        },this.pingMs);
        this.pingTimer.unref?.();
      }
      // Whatever changed while nobody listened.
      this.onEvent('open');
    });
    socket.on('pong',()=>{clearTimeout(this.pongTimer);this.pongTimer=null;});
    socket.on('message',data=>{
      if(this.socket!==socket)return;
      let message;
      try{message=JSON.parse(String(data));}catch{return;}
      if(Array.isArray(message)&&message[0]===EVENT&&this.topics.includes(message[1]))this.onEvent(message[1],message[2]?.data);
    });
    // A refusal or a lost client ends in 'close' too.
    socket.on('error',()=>{});
    socket.on('close',()=>{if(this.socket===socket)this.drop();});
  }
  drop(){
    clearInterval(this.pingTimer);this.pingTimer=null;
    clearTimeout(this.pongTimer);this.pongTimer=null;
    const socket=this.socket;
    this.socket=null;this.live=false;
    if(!socket)return;
    try{if(socket.terminate)socket.terminate();else socket.close();}catch{/* Already gone. */}
  }
  stop(){this.stopped=true;this.drop();}
}
