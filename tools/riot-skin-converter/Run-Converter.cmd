@echo off
setlocal
pushd "%~dp0\..\.."
node scripts\convert-riot-database.mjs %*
set "result=%errorlevel%"
popd
if not "%result%"=="0" echo Conversion finished with unsupported archives or an error. See the report above.
pause
exit /b %result%
