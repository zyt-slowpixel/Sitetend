@echo off
rem The model saved in Sitetend to run with (its id in the model menu). Set MODEL before running to use another.
if not defined MODEL set MODEL=openai
setlocal
cd /d "%~dp0..\.."
set "NODE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not exist eval\runs mkdir eval\runs
if not defined NODE (echo Node.js not found > eval\runs\items5.txt & exit /b 1)
echo Running (about 5-8 minutes). Results: eval\runs\items5.txt
echo === the open-source template sites again (the ones hit by the API outage) === > eval\runs\items5.txt
"%NODE%" tools\eval.mjs --model %MODEL% --set multi --site sites/ext- --json >> eval\runs\items5.txt 2>&1
echo === done === >> eval\runs\items5.txt
echo Done. You can close this window.
pause
