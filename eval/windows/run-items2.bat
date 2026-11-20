@echo off
rem The model saved in Sitetend to run with (its id in the model menu). Set MODEL before running to use another.
if not defined MODEL set MODEL=openai
setlocal
cd /d "%~dp0..\.."
set "NODE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not exist eval\runs mkdir eval\runs
if not defined NODE (echo Node.js not found > eval\runs\items2.txt & exit /b 1)
echo Running (about 15-20 minutes). Results: eval\runs\items2.txt
echo === run A: new-item cases, reviewer on === > eval\runs\items2.txt
"%NODE%" tools\eval.mjs --model %MODEL% --set items --json >> eval\runs\items2.txt 2>&1
echo. >> eval\runs\items2.txt
echo === run B: new-item cases again, reviewer on === >> eval\runs\items2.txt
"%NODE%" tools\eval.mjs --model %MODEL% --set items --json >> eval\runs\items2.txt 2>&1
echo. >> eval\runs\items2.txt
echo === run C: 85 multi-site cases (regression check), reviewer on === >> eval\runs\items2.txt
"%NODE%" tools\eval.mjs --model %MODEL% --set multi --json >> eval\runs\items2.txt 2>&1
echo === done === >> eval\runs\items2.txt
echo Done. You can close this window.
pause
