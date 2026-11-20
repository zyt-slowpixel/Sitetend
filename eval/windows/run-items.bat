@echo off
rem The model saved in Sitetend to run with (its id in the model menu). Set MODEL before running to use another.
if not defined MODEL set MODEL=openai
setlocal
cd /d "%~dp0..\.."
set "NODE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not exist eval\runs mkdir eval\runs
if not defined NODE (echo Node.js not found > eval\runs\items.txt & exit /b 1)
echo New-item evaluation running (about 20-30 minutes). Results: eval\runs\items.txt
echo === run 1: all sets (old 131 + 16 new-item cases), reviewer on === > eval\runs\items.txt
"%NODE%" tools\eval.mjs --model %MODEL% --json >> eval\runs\items.txt 2>&1
echo. >> eval\runs\items.txt
echo === run 2: new-item cases again, reviewer on === >> eval\runs\items.txt
"%NODE%" tools\eval.mjs --model %MODEL% --set items --json >> eval\runs\items.txt 2>&1
echo === done === >> eval\runs\items.txt
echo Done. You can close this window.
pause
