// Player libraries must survive Squirrel removing or replacing its install folder.
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const INSTALL='friloverse-skins',DATA='friloverse-skins-data';
const databaseRoot=local=>path.join(local,DATA,'Database');

function info(file){try{return fs.lstatSync(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
function directory(file){
  const item=info(file);
  if(item&&(!item.isDirectory()||item.isSymbolicLink()))throw new Error(`Database migration cannot use this folder: ${file}`);
  return item;
}
// Move missing entries, never replace an existing file or follow a link. On a failed move
// the source stays in place and the next start resumes before opening any library.
function moveMissing(from,to){
  directory(from);directory(to);
  for(const name of fs.readdirSync(from)){
    const source=path.join(from,name),target=path.join(to,name),item=info(source),existing=info(target);
    if(item.isSymbolicLink()||existing?.isSymbolicLink())throw new Error(`Database migration cannot follow a link: ${source}`);
    if(!existing)fs.renameSync(source,target);
    else if(item.isDirectory()&&existing.isDirectory())moveMissing(source,target);
  }
}
function migrateDatabase(local){
  if(!local||!path.isAbsolute(local))throw new Error('The local application data folder could not be found.');
  const from=path.join(local,INSTALL,'Database'),to=databaseRoot(local);
  directory(path.dirname(from));directory(path.dirname(to));directory(to);
  if(!directory(from))return {root:to,recovered:null};
  fs.mkdirSync(path.dirname(to),{recursive:true});
  if(!info(to)){fs.renameSync(from,to);return {root:to,recovered:null};}
  moveMissing(from,to);
  // Keep both versions of conflicts. Even empty legacy directories stay in this archive;
  // no player's file is deleted, and an uninstall cannot reach this sibling folder.
  const recovered=path.join(path.dirname(to),`Database-recovered-${randomUUID()}`);
  fs.renameSync(from,recovered);
  return {root:to,recovered};
}
module.exports={databaseRoot,migrateDatabase};
