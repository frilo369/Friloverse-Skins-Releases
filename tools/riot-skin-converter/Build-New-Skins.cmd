@echo off
setlocal
pushd "%~dp0\..\.."
echo Building new League skins with FrYiLo Phantom, then converting them for Friloverse.
echo This reads League and writes only to Friloverse's own folders.
node scripts\convert-phantom-export.mjs --phantom %*
set "result=%errorlevel%"
popd
if not "%result%"=="0" echo Building or conversion finished with unsupported packages or an error. See the report above.
pause
exit /b %result%
