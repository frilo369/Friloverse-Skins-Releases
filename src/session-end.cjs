// Windows does not emit before-quit during logoff/shutdown. Do not veto shutdown:
// release the native guard immediately and attempt restoration while Windows allows it.
function sessionEndHandler({stop,restore,onError=()=>{}}){
  let started=false;
  return ()=>{
    if(started)return;
    started=true;
    try{stop();}catch(error){onError(error);}
    void Promise.resolve().then(restore).catch(onError);
  };
}
module.exports={sessionEndHandler};
