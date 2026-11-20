@echo off
rem The model saved in Sitetend to run with (its id in the model menu). Set MODEL before running to use another.
if not defined MODEL set MODEL=openai
setlocal
cd /d "%~dp0..\.."
set "NODE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE (echo Node.js not found > eval\runs\latest.txt & exit /b 1)
echo Running evaluation with the model %MODEL% (reviewer on, then off). This window closes by itself.
echo === reviewer on === > eval\runs\latest.txt
"%NODE%" tools\eval.mjs --model %MODEL% --json >> eval\runs\latest.txt 2>&1
echo. >> eval\runs\latest.txt
echo === reviewer off === >> eval\runs\latest.txt
"%NODE%" tools\eval.mjs --model %MODEL% --json --no-review >> eval\runs\latest.txt 2>&1
echo === done === >> eval\runs\latest.txt
