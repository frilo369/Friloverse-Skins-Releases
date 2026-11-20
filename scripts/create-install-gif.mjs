// Squirrel shows this while the plain setup runs; its default is a green spinner.
// A navy panel with the gold star, written as an uncompressed GIF.
import {writeFile} from 'node:fs/promises';

const WIDTH=268,HEIGHT=167,SHADES=8,NAVY=[6,17,27],GOLD=[255,211,112];
const palette=Array.from({length:SHADES},(_,shade)=>NAVY.map((channel,index)=>Math.round(channel+(GOLD[index]-channel)*shade/(SHADES-1))));

// A four-pointed gold star, measured at four points per pixel.
function inStar(x,y){
  const radius=46,dx=Math.abs(x-WIDTH/2),dy=Math.abs(y-HEIGHT/2);
  return Math.pow(dx/radius,.5)+Math.pow(dy/radius,.5)<=1;
}
const pixels=[];
for(let y=0;y<HEIGHT;y++)for(let x=0;x<WIDTH;x++){
  let hits=0;
  for(const [ox,oy] of [[.25,.25],[.75,.25],[.25,.75],[.75,.75]])if(inStar(x+ox,y+oy))hits++;
  pixels.push(Math.round(hits/4*(SHADES-1)));
}

// LZW with a clear code often enough that every code stays nine bits long.
const CLEAR=256,END=257,codes=[];
pixels.forEach((pixel,index)=>{if(index%250===0)codes.push(CLEAR);codes.push(pixel);});
codes.push(END);
const packed=[];let bits=0,count=0;
for(const code of codes){
  bits|=code<<count;count+=9;
  while(count>=8){packed.push(bits&255);bits>>=8;count-=8;}
}
if(count)packed.push(bits&255);
const blocks=[];
for(let at=0;at<packed.length;at+=255){const part=packed.slice(at,at+255);blocks.push(part.length,...part);}

const word=value=>[value&255,value>>8];
const table=[];for(let index=0;index<256;index++)table.push(...(palette[index]??[0,0,0]));
const gif=Buffer.from([
  ...Buffer.from('GIF89a','latin1'),...word(WIDTH),...word(HEIGHT),0xf7,0,0,...table,
  0x2c,0,0,0,0,...word(WIDTH),...word(HEIGHT),0,8,...blocks,0,0x3b
]);
await writeFile('scripts/installing.gif',gif);
console.log(`scripts/installing.gif: ${gif.length} bytes`);
