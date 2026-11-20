@echo off
setlocal
cd /d "%~dp0..\.."
set "NODE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not exist eval\runs mkdir eval\runs
if not defined NODE (echo Node.js not found > eval\runs\haiku-log.txt & exit /b 1)
echo Low-cost check with Claude Haiku: every test set (291 cases), twice, reviewer on.
echo Needs an Anthropic API key saved in Sitetend (model menu: Claude Haiku). Expected about $1 in all; each run stops by itself at $1.50.
echo About 40 minutes. You can leave it running.
echo Results: eval\REPORT-haiku.md   (log: eval\runs\haiku-log.txt)
echo started %date% %time% > eval\runs\haiku-log.txt
for %%r in (1 2) do (
  echo === Haiku run %%r, all sets, reviewer on === >> eval\runs\haiku-log.txt
  "%NODE%" tools\eval.mjs --model claude-haiku --json --tag haiku --max-dollars 1.5 --price-in 0.1 --price-out 0.5 >> eval\runs\haiku-log.txt 2>&1
)
"%NODE%" tools\eval-report.mjs --tag haiku --md eval\REPORT-haiku.md >> eval\runs\haiku-log.txt 2>&1
echo finished %date% %time% >> eval\runs\haiku-log.txt
echo Done. Open eval\REPORT-haiku.md. You can close this window.
pause
