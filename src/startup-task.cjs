// Starting with Windows, for an elevated Friloverse. Windows skips a Run-key program that needs
// the consent prompt, and asking at every logon would be a nuisance, so an elevated Friloverse
// keeps a logon task that runs with the highest rights instead (only an elevated process may
// create one). The task points at Squirrel's stable stub, like the Run entry did, so updates keep it valid.
const {execFile}=require('node:child_process');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {randomBytes}=require('node:crypto');

const TASK='Friloverse Skins';
const escapeXml=text=>String(text).replace(/[<>&"']/g,char=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'})[char]);

/** The task definition. No time limit and no battery rules: schtasks' defaults would end the app after 3 days. */
function taskXml({exe,user,args='--startup'}){
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Starts Friloverse in the tray when you sign in.</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${escapeXml(user)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${escapeXml(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec><Command>${escapeXml(exe)}</Command><Arguments>${escapeXml(args)}</Arguments></Exec></Actions>
</Task>
`;
}

const run=(args,exec=execFile)=>new Promise((resolve,reject)=>exec('schtasks.exe',args,{windowsHide:true,timeout:15000},(error,stdout)=>error?reject(error):resolve(String(stdout||''))));

function currentUser(env=process.env){
  const name=os.userInfo().username;
  return env.USERDOMAIN?`${env.USERDOMAIN}\\${name}`:name;
}

/** Whether the task exists and already runs `exe` with the highest rights. */
async function taskCurrent(exe,{exec=execFile}={}){
  try{
    const xml=await run(['/Query','/TN',TASK,'/XML'],exec);
    return xml.includes(escapeXml(exe))&&/HighestAvailable/.test(xml);
  }catch{return false;}
}

/** Makes sure the logon task for `exe` exists (`enabled`) or is gone. Throws when Windows refuses. */
async function syncTask({exe,enabled,user=currentUser(),exec=execFile,dir=os.tmpdir()}){
  if(!enabled){
    try{await run(['/Delete','/TN',TASK,'/F'],exec);}catch{/* It was not there. */}
    return 'removed';
  }
  if(await taskCurrent(exe,{exec}))return 'kept';
  const file=path.join(dir,`friloverse-task-${randomBytes(6).toString('hex')}.xml`);
  // schtasks reads its definition as UTF-16 with a byte-order mark.
  await fs.writeFile(file,Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from(taskXml({exe,user}),'utf16le')]));
  try{await run(['/Create','/TN',TASK,'/XML',file,'/F'],exec);}
  finally{await fs.unlink(file).catch(()=>{});}
  return 'created';
}

module.exports={TASK,taskXml,taskCurrent,syncTask,currentUser};
