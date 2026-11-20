@echo off
rem The model saved in Sitetend to run with (its id in the model menu). Set MODEL before running to use another.
if not defined MODEL set MODEL=openai
setlocal
cd /d "%~dp0..\.."
set "NODE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE (echo Node.js not found > eval\runs\reviewer-study.txt & exit /b 1)
if not exist eval\runs mkdir eval\runs
echo Reviewer study running (about 10 minutes). Results: eval\runs\reviewer-study.txt
echo === A: the model %MODEL% writes the cards, reviewer only scores them === > eval\runs\reviewer-study.txt
"%NODE%" tools\eval.mjs --model %MODEL% --reviewer-study --json >> eval\runs\reviewer-study.txt 2>&1
echo. >> eval\runs\reviewer-study.txt
echo === B: offline rule mode writes the cards (more mistakes), the model %MODEL% reviewer scores them === >> eval\runs\reviewer-study.txt
"%NODE%" tools\eval.mjs --model %MODEL% --reviewer-study --study-generator rule --json >> eval\runs\reviewer-study.txt 2>&1
echo === done === >> eval\runs\reviewer-study.txt
echo Done. You can close this window.
pause
