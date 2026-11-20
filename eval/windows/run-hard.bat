@echo off
rem The model saved in Sitetend to run with (its id in the model menu). Set MODEL before running to use another.
if not defined MODEL set MODEL=openai
setlocal
cd /d "%~dp0..\.."
set "NODE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not exist eval\runs mkdir eval\runs
if not defined NODE (echo Node.js not found > eval\runs\hard.txt & exit /b 1)
echo 17 harder cases on the new sites, the model %MODEL%, 1 run (about 5-10 minutes). Results: eval\runs\hard.txt
echo === harder cases (ext4), reviewer on === > eval\runs\hard.txt
"%NODE%" tools\eval.mjs --model %MODEL% --set ext4 --json >> eval\runs\hard.txt 2>&1
echo === done === >> eval\runs\hard.txt
echo Done. You can close this window.
pause
