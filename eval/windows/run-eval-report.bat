@echo off
rem The model saved in Sitetend to run with (its id in the model menu). Set MODEL before running to use another.
if not defined MODEL set MODEL=openai
setlocal
cd /d "%~dp0..\.."
set "NODE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not exist eval\runs mkdir eval\runs
if not defined NODE (echo Node.js not found > eval\runs\report-log.txt & exit /b 1)
echo Evaluation for the report: the three newest held-out sets (70 cases), the model %MODEL%.
echo 3 runs with the reviewer on, 1 run with it off. About 1 to 1.5 hours. You can leave it running.
echo Results: eval\REPORT.md   (log: eval\runs\report-log.txt)
echo started %date% %time% > eval\runs\report-log.txt
for %%r in (1 2 3) do for %%s in (ext5 ext6 ext7) do (
  echo === run %%r, reviewer on: %%s === >> eval\runs\report-log.txt
  "%NODE%" tools\eval.mjs --model %MODEL% --set %%s --json >> eval\runs\report-log.txt 2>&1
)
for %%s in (ext5 ext6 ext7) do (
  echo === reviewer off: %%s === >> eval\runs\report-log.txt
  "%NODE%" tools\eval.mjs --model %MODEL% --set %%s --no-review --json >> eval\runs\report-log.txt 2>&1
)
"%NODE%" tools\eval-report.mjs >> eval\runs\report-log.txt 2>&1
echo finished %date% %time% >> eval\runs\report-log.txt
echo Done. Open eval\REPORT.md. You can close this window.
pause
