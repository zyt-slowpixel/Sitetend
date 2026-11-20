@echo off
rem The model saved in Sitetend to run with (its id in the model menu). Set MODEL before running to use another.
if not defined MODEL set MODEL=openai
setlocal
cd /d "%~dp0..\.."
set "NODE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not exist eval\runs mkdir eval\runs
set "OUT=eval\runs\final.txt"
if not defined NODE (echo Node.js not found > %OUT% & exit /b 1)
echo Final test batch (about 40 minutes). Results: %OUT%
echo === 1/5 all sets, reviewer on (repeat 2) === > %OUT%
"%NODE%" tools\eval.mjs --model %MODEL% --json >> %OUT% 2>&1
echo === 2/5 all sets, reviewer on (repeat 3) === >> %OUT%
"%NODE%" tools\eval.mjs --model %MODEL% --json >> %OUT% 2>&1
echo === 3/5 18 new sites, reviewer off (repeat 2) === >> %OUT%
"%NODE%" tools\eval.mjs --model %MODEL% --set multi --no-review --json >> %OUT% 2>&1
echo === 4/5 18 new sites, reviewer off (repeat 3) === >> %OUT%
"%NODE%" tools\eval.mjs --model %MODEL% --set multi --no-review --json >> %OUT% 2>&1
echo === 5/5 reviewer planted-error test === >> %OUT%
"%NODE%" tools\reviewer-planted.mjs --model %MODEL% --json >> %OUT% 2>&1
echo === done === >> %OUT%
echo Done. You can close this window.
pause
