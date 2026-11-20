@echo off
rem The model saved in Sitetend to run with (its id in the model menu). Set MODEL before running to use another.
if not defined MODEL set MODEL=openai
setlocal
cd /d "%~dp0..\.."
set "NODE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not exist eval\runs mkdir eval\runs
if not defined NODE (echo Node.js not found > eval\runs\new-sites.txt & exit /b 1)
echo 10 sites made by AI builders (Lovable, Bolt, v0, Replit, Angular, Flask, PHP...), the model %MODEL%, 2 runs (about 10-15 minutes). Results: eval\runs\new-sites.txt
echo === run 1, reviewer on: ext7 (AI builders, Angular, Flask, PHP) === > eval\runs\new-sites.txt
"%NODE%" tools\eval.mjs --model %MODEL% --set ext7 --json >> eval\runs\new-sites.txt 2>&1
echo. >> eval\runs\new-sites.txt
echo === run 2, reviewer on: ext7 === >> eval\runs\new-sites.txt
"%NODE%" tools\eval.mjs --model %MODEL% --set ext7 --json >> eval\runs\new-sites.txt 2>&1
echo === done === >> eval\runs\new-sites.txt
echo Done. You can close this window.
pause
