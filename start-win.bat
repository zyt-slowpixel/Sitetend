@echo off
setlocal
cd /d "%~dp0"
title Sitetend

call :findnode
if not defined NODE goto install
call :version
if %MAJOR% LSS 22 goto install
goto run

rem ---------------------------------------------------------------- Node.js is missing or too old: offer to install it
:install
echo.
echo  Sitetend needs Node.js (free, from nodejs.org) to run.
if defined NODE (echo  The Node.js on this computer is too old. Sitetend needs version 22 or newer.) else (echo  It is not installed on this computer yet.)
echo.
where winget >nul 2>&1 || goto manual
choice /c YN /m " Install it now? It takes about a minute (Windows may ask for permission)"
if errorlevel 2 goto manual
echo.
if defined NODE (
  winget upgrade --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements
) else (
  winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements
)
set "NODE="
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE call :findnode
if not defined NODE goto manual
call :version
if %MAJOR% LSS 22 goto manual
echo.
echo  Node.js is ready.
goto run

:manual
echo.
echo  Opening the Node.js download page. Install the version marked "LTS",
echo  then double-click start-win.bat again.
start "" https://nodejs.org/en/download
pause
exit /b 1

rem ---------------------------------------------------------------- start
:run
echo  Starting Sitetend... your browser will open and this window will close.
echo  To quit later: the Sitetend icon in the taskbar tray, or Settings ^> Quit Sitetend.
"%NODE%" bin\sitetend.mjs --launch %*
if errorlevel 1 (
  echo.
  echo  Sitetend did not start. Details: %USERPROFILE%\.sitetend\sitetend.log
  pause
  exit /b 1
)
exit /b 0

rem ---------------------------------------------------------------- helpers
:findnode
rem PATH first, then the usual install folders (a freshly installed Node is not on PATH until you sign in again).
set "NODE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"
if not defined NODE if defined NVM_SYMLINK if exist "%NVM_SYMLINK%\node.exe" set "NODE=%NVM_SYMLINK%\node.exe"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Volta\bin\node.exe" set "NODE=%LOCALAPPDATA%\Volta\bin\node.exe"
if not defined NODE if exist "%ProgramFiles%\Volta\node.exe" set "NODE=%ProgramFiles%\Volta\node.exe"
exit /b 0

:version
set "MAJOR="
for /f "tokens=1 delims=v." %%v in ('"%NODE%" -v') do set "MAJOR=%%v"
if not defined MAJOR set "MAJOR=0"
exit /b 0
