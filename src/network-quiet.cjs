// Web pages can open WebRTC sockets that wait for incoming traffic, and on a new
// program path (every update has one) Windows answers with a firewall prompt.
// Real case: adverts on the MetaSRC guide page, seconds after a game starts.
// Friloverse only makes outgoing connections, so it needs none of these sockets.
function quietNetwork(app){
  app.commandLine.appendSwitch('disable-features','WebRtcHideLocalIpsWithMdns');
  app.on('web-contents-created',(_event,contents)=>contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp'));
}
module.exports={quietNetwork};
