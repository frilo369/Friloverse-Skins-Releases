@echo off
setlocal
pushd "%~dp0\..\.."
if not "%~1"=="" (
  node scripts\convert-phantom-export.mjs %*
) else (
  echo Convert FrYiLo Phantom's export into Friloverse's Riot skin database.
  echo Drag the snapshot folder here, or paste its path.
  set /p "target=Phantom export folder, snapshot or phantom-latest.json: "
  set "target=%target:"=%"
  node scripts\convert-phantom-export.mjs --export="%target%"
)
set "result=%errorlevel%"
popd
if not "%result%"=="0" echo Conversion finished with unsupported packages or an error. See the report above.
pause
exit /b %result%
