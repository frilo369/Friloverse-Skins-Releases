export function shortcutFromEvent(event){
  if(event.repeat||event.isComposing)return null;
  const code=event.code;
  if(!/^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4])|Arrow(Up|Down|Left|Right)|Numpad([0-9]|Add|Subtract|Multiply|Divide|Decimal|Enter)|Space|Tab|Enter|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash)$/.test(code))return null;
  const mods=[];if(event.ctrlKey)mods.push('Ctrl');if(event.altKey)mods.push('Alt');if(event.shiftKey)mods.push('Shift');if(event.metaKey)mods.push('Super');
  return [...mods,code].join('+');
}
const keys={ArrowUp:[0x26,'Up'],ArrowDown:[0x28,'Down'],ArrowLeft:[0x25,'Left'],ArrowRight:[0x27,'Right'],Space:[0x20,'Space'],Tab:[9,'Tab'],Enter:[13,'Return'],Backspace:[8,'Backspace'],Delete:[46,'Delete'],Insert:[45,'Insert'],Home:[36,'Home'],End:[35,'End'],PageUp:[33,'PageUp'],PageDown:[34,'PageDown'],Backquote:[0xc0,'`'],Minus:[0xbd,'-'],Equal:[0xbb,'='],BracketLeft:[0xdb,'['],BracketRight:[0xdd,']'],Backslash:[0xdc,'\\'],Semicolon:[0xba,';'],Quote:[0xde,"'"],Comma:[0xbc,','],Period:[0xbe,'.'],Slash:[0xbf,'/'],NumpadAdd:[0x6b,'numadd'],NumpadSubtract:[0x6d,'numsub'],NumpadMultiply:[0x6a,'nummult'],NumpadDivide:[0x6f,'numdiv'],NumpadDecimal:[0x6e,'numdec'],NumpadEnter:[13,'numenter']};
export function parseShortcut(value){
  if(typeof value!=='string')return null;
  const pieces=value.split('+'),code=pieces.pop(),mods=pieces;
  if(new Set(mods).size!==mods.length||mods.some(mod=>!['Ctrl','Alt','Shift','Super'].includes(mod)))return null;
  let entry=keys[code];
  if(/^Key[A-Z]$/.test(code))entry=[code.charCodeAt(3),code.slice(3)];
  if(/^Digit[0-9]$/.test(code))entry=[code.charCodeAt(5),code.slice(5)];
  if(/^Numpad[0-9]$/.test(code))entry=[0x60+Number(code.slice(6)),`num${code.slice(6)}`];
  if(/^F([1-9]|1[0-9]|2[0-4])$/.test(code))entry=[0x6f+Number(code.slice(1)),code];
  if(!entry)return null;
  return {key:entry[0],modifiers:mods,accelerator:[...mods,entry[1]].join('+')};
}
export const shortcutLabel=value=>String(value||'F1').replace(/Key([A-Z])/g,'$1').replace(/Digit([0-9])/g,'$1').replace(/Super/g,'Win');
export function systemHotkeyWord(binding){
  if(binding?.key!==0x70||binding.modifiers.includes('Super'))return null;
  let flags=0;
  if(binding.modifiers.includes('Shift'))flags|=1;
  if(binding.modifiers.includes('Ctrl'))flags|=2;
  if(binding.modifiers.includes('Alt'))flags|=4;
  return (flags<<8)|binding.key;
}
