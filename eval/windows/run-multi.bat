@echo off
rem The model saved in Sitetend to run with (its id in the model menu). Set MODEL before running to use another.
if not defined MODEL set MODEL=openai
setlocal
cd /d "%~dp0..\.."
set "NODE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not exist eval\runs mkdir eval\runs
if not defined NODE (echo Node.js not found > eval\runs\multi.txt & exit /b 1)
echo 20-site evaluation running (about 15-25 minutes). Results: eval\runs\multi.txt
echo === all sets, reviewer on === > eval\runs\multi.txt
"%NODE%" tools\eval.mjs --model %MODEL% --json >> eval\runs\multi.txt 2>&1
echo. >> eval\runs\multi.txt
echo === 18 new sites, reviewer off === >> eval\runs\multi.txt
"%NODE%" tools\eval.mjs --model %MODEL% --set multi --no-review --json >> eval\runs\multi.txt 2>&1
echo === done === >> eval\runs\multi.txt
echo Done. You can close this window.
pause
