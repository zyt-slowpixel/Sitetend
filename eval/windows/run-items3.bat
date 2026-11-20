@echo off
rem The model saved in Sitetend to run with (its id in the model menu). Set MODEL before running to use another.
if not defined MODEL set MODEL=openai
setlocal
cd /d "%~dp0..\.."
set "NODE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not exist eval\runs mkdir eval\runs
if not defined NODE (echo Node.js not found > eval\runs\items3.txt & exit /b 1)
echo Running (about 20-25 minutes). Results: eval\runs\items3.txt
echo === run A: 85 multi-site cases, reviewer on === > eval\runs\items3.txt
"%NODE%" tools\eval.mjs --model %MODEL% --set multi --json >> eval\runs\items3.txt 2>&1
echo. >> eval\runs\items3.txt
echo === run B: new-item cases, reviewer on === >> eval\runs\items3.txt
"%NODE%" tools\eval.mjs --model %MODEL% --set items --json >> eval\runs\items3.txt 2>&1
echo. >> eval\runs\items3.txt
echo === run C: planted wrong cards (does the reviewer still catch them?) === >> eval\runs\items3.txt
"%NODE%" tools\reviewer-planted.mjs --model %MODEL% --json >> eval\runs\items3.txt 2>&1
echo === done === >> eval\runs\items3.txt
echo Done. You can close this window.
pause
