// Read-only process snapshots avoid launching tasklist for every late pick.
const koffi=require('koffi');
const kernel=koffi.load('kernel32.dll');
const ENTRY=koffi.struct('FriloverseProcessEntry',{
  dwSize:'uint32',cntUsage:'uint32',th32ProcessID:'uint32',th32DefaultHeapID:'uintptr_t',
  th32ModuleID:'uint32',cntThreads:'uint32',th32ParentProcessID:'uint32',
  pcPriClassBase:'int32',dwFlags:'uint32',szExeFile:koffi.array('uint16',260)
});
const snapshot=kernel.func('void * __stdcall CreateToolhelp32Snapshot(uint32 flags, uint32 processId)');
// Reuse the native buffer: decoding a 260-element JS array on every process, on every
// guard tick, used most of the polling interval. Only the PID/name fields are needed.
const first=kernel.func('bool __stdcall Process32FirstW(void *snapshot, void *entry)');
const next=kernel.func('bool __stdcall Process32NextW(void *snapshot, void *entry)');
const lastError=kernel.func('uint32 __stdcall GetLastError()');
const close=kernel.func('bool __stdcall CloseHandle(void *handle)');
const openProcess=kernel.func('void * __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)');
const queryImage=kernel.func('bool __stdcall QueryFullProcessImageNameW(void *handle, uint32 flags, void *buf, uint32 *size)');
const ntdll=koffi.load('ntdll.dll');
const queryInfo=ntdll.func('int32 __stdcall NtQueryInformationProcess(void *handle, uint32 cls, void *buf, uint32 len, uint32 *retLen)');
const PROCESS_QUERY_LIMITED_INFORMATION=0x1000,PROCESS_CMDLINE_INFO=60;

const NAME_OFFSET=koffi.offsetof(ENTRY,'szExeFile'),PID_OFFSET=koffi.offsetof(ENTRY,'th32ProcessID');
function snapshotRows(visit){
  const handle=snapshot(2,0); // TH32CS_SNAPPROCESS
  if(!handle||BigInt.asIntN(64,koffi.address(handle))===-1n)throw new Error('Could not snapshot Windows processes.');
  try{
    const entry=Buffer.alloc(koffi.sizeof(ENTRY));entry.writeUInt32LE(entry.length);
    let system=false;
    if(!first(handle,entry))throw new Error('Could not enumerate Windows processes.');
    do{
      let end=NAME_OFFSET;
      while(end<NAME_OFFSET+520&&entry.readUInt16LE(end)!==0)end+=2;
      if(end===NAME_OFFSET+520)throw new Error('Invalid Windows process name.');
      const name=entry.toString('utf16le',NAME_OFFSET,end).toLowerCase();
      if(name==='system')system=true;
      visit(entry.readUInt32LE(PID_OFFSET),name);
    }while(next(handle,entry));
    if(lastError()!==18||!system)throw new Error('Incomplete Windows process snapshot.');
  }finally{close(handle);}
}
function processNames(){
  const names=new Set();snapshotRows((_pid,name)=>names.add(name));return names;
}
/** Every process, with its lower-case name. */
function listProcesses(){
  const rows=[];snapshotRows((pid,name)=>rows.push({pid,name}));return rows;
}
/** Full executable path of `pid` using PROCESS_QUERY_LIMITED_INFORMATION only (Vanguard-safe). */
function queryProcessImage(pid){
  if(!Number.isInteger(pid)||pid<=0)return null;
  const handle=openProcess(PROCESS_QUERY_LIMITED_INFORMATION,false,pid);
  if(!handle)return null;
  try{
    const buf=Buffer.alloc(2048),size=[1024];
    if(!queryImage(handle,0,buf,size))return null;
    return buf.toString('utf16le',0,size[0]*2)||null;
  }finally{close(handle);}
}
/** Command line of `pid` via NtQueryInformationProcess(ProcessCommandLineInformation=60), zero PROCESS_VM_READ. */
function queryProcessCmdline(pid){
  if(!Number.isInteger(pid)||pid<=0)return null;
  const handle=openProcess(PROCESS_QUERY_LIMITED_INFORMATION,false,pid);
  if(!handle)return null;
  try{
    const ret=[0];
    let size=4096;
    for(let attempt=0;attempt<2;attempt++){
      const buf=Buffer.alloc(size);
      const status=queryInfo(handle,PROCESS_CMDLINE_INFO,buf,size,ret);
      if(status===0){
        const byteLen=buf.readUInt16LE(0);
        // UNICODE_STRING on 64-bit Windows: u16 Length, u16 MaximumLength, u32 pad, u64 Buffer ptr.
        // The string payload sits inside `buf` immediately after the 16-byte UNICODE_STRING header.
        const headerSize=process.arch==='x64'||process.arch==='arm64'?16:8;
        if(byteLen>0&&headerSize+byteLen<=buf.length)return buf.toString('utf16le',headerSize,headerSize+byteLen);
        return '';
      }
      if(ret[0]>size&&ret[0]<=256*1024)size=ret[0];
      else break;
    }
    return null;
  }finally{close(handle);}
}
module.exports={processNames,listProcesses,queryProcessImage,queryProcessCmdline};
