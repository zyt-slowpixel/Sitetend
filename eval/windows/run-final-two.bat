@echo off
rem The model saved in Sitetend to run with (its id in the model menu). Set MODEL before running to use another.
if not defined MODEL set MODEL=openai
setlocal
cd /d "%~dp0..\.."
set "NODE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not exist eval\runs mkdir eval\runs
if not defined NODE (echo Node.js not found > eval\runs\final-two-log.txt & exit /b 1)
echo Final evaluation: every test set (291 cases), twice, the model %MODEL%, reviewer on.
echo Each run stops by itself at $9, so both runs together stay under $20 (expected about $12).
echo About 50 minutes. You can leave it running.
echo Results: eval\REPORT-final.md   (log: eval\runs\final-two-log.txt)
echo started %date% %time% > eval\runs\final-two-log.txt
for %%r in (1 2) do (
  echo === final run %%r, all sets, reviewer on === >> eval\runs\final-two-log.txt
  "%NODE%" tools\eval.mjs --model %MODEL% --json --tag final --max-dollars 9 >> eval\runs\final-two-log.txt 2>&1
)
"%NODE%" tools\eval-report.mjs --tag final --md eval\REPORT-final.md >> eval\runs\final-two-log.txt 2>&1
echo finished %date% %time% >> eval\runs\final-two-log.txt
echo Done. Open eval\REPORT-final.md. You can close this window.
pause
