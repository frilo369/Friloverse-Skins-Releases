// The editing connection to LTK Manager: two private Windows pipes instead of a network port.
// Friloverse holds one end of each before LTK Manager exists, and a pipe made for one
// connection takes no second one, so no other program can join, whoever it runs as.
const koffi=require('koffi');
const net=require('node:net');
const {randomBytes}=require('node:crypto');
const kernel=koffi.load('kernel32.dll');
const createNamedPipe=kernel.func('void * __stdcall CreateNamedPipeW(str16 name, uint32 openMode, uint32 pipeMode, uint32 maxInstances, uint32 outSize, uint32 inSize, uint32 timeout, void *security)');
const setHandleInformation=kernel.func('bool __stdcall SetHandleInformation(void *handle, uint32 mask, uint32 flags)');
const closeHandle=kernel.func('bool __stdcall CloseHandle(void *handle)');

// Both ways and the only one of its name; bytes, and never a client from another PC.
const DUPLEX_FIRST_INSTANCE=0x00080003,BYTES_LOCAL_ONLY=0x00000008,INHERIT=1,BUFFER=1<<16,CONNECT_WAIT=3000;

/** The browser's end of one pipe, and Friloverse's end already connected to it. */
async function pipe(label){
  const name=`\\\\.\\pipe\\friloverse-ltk-${label}-${randomBytes(16).toString('hex')}`;
  const handle=createNamedPipe(name,DUPLEX_FIRST_INSTANCE,BYTES_LOCAL_ONLY,1,BUFFER,BUFFER,0,null);
  if(!handle||BigInt.asIntN(64,koffi.address(handle))===-1n)throw new Error('LTK Manager\'s private connection could not be made.');
  const socket=net.connect(name);socket.on('error',()=>{});
  try{
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('LTK Manager\'s private connection could not be opened.')),CONNECT_WAIT);
      socket.once('connect',()=>{clearTimeout(timer);resolve();});
      socket.once('error',error=>{clearTimeout(timer);reject(error);});
    });
  }catch(error){socket.destroy();closeHandle(handle);throw error;}
  return {handle,socket};
}

/**
 * `browserArguments` tells LTK Manager's WebView2 to take its commands from these pipes.
 * `share()` just before starting LTK Manager and `release()` just after: only a program
 * started in between receives the browser's ends.
 */
async function openDebugPipes(){
  const toBrowser=await pipe('in');
  let fromBrowser;
  try{fromBrowser=await pipe('out');}
  catch(error){toBrowser.socket.destroy();closeHandle(toBrowser.handle);throw error;}
  let handles=[toBrowser.handle,fromBrowser.handle];
  const release=()=>{for(const handle of handles)closeHandle(handle);handles=[];};
  return {
    send:toBrowser.socket,receive:fromBrowser.socket,
    browserArguments:`--remote-debugging-pipe --remote-debugging-io-pipes=${koffi.address(toBrowser.handle)},${koffi.address(fromBrowser.handle)}`,
    get open(){return !toBrowser.socket.destroyed&&!fromBrowser.socket.destroyed&&toBrowser.socket.writable;},
    share(){for(const handle of handles)if(!setHandleInformation(handle,INHERIT,INHERIT))throw new Error('LTK Manager\'s private connection could not be handed over.');},
    release,
    close(){release();toBrowser.socket.destroy();fromBrowser.socket.destroy();},
  };
}
module.exports={openDebugPipes};
