@echo off
setlocal
cd /d "%~dp0..\.."
echo === Upload Sitetend to GitHub (private repository) ===
echo.
where git >nul 2>&1 || (echo Git was not found. Install it from https://git-scm.com and run this again. & pause & exit /b 1)

rem Git needs a name and email for commits (only asked once).
for /f "delims=" %%i in ('git config --global user.name 2^>nul') do set "GN=%%i"
if not defined GN set /p "GN=Your name for Git commits: "
if not defined GN (echo A name is needed. & pause & exit /b 1)
git config --global user.name "%GN%"
for /f "delims=" %%i in ('git config --global user.email 2^>nul') do set "GE=%%i"
if not defined GE set /p "GE=Your GitHub email for Git commits: "
if not defined GE (echo An email is needed. & pause & exit /b 1)
git config --global user.email "%GE%"

if not exist .git (git init -b main || (echo git init failed & pause & exit /b 1))
rem The repository address (after the account was renamed to zyt-slowpixel, an older copy is pointed at the new one).
git remote get-url origin >nul 2>&1 && git remote set-url origin https://github.com/zyt-slowpixel/Sitetend.git || git remote add origin https://github.com/zyt-slowpixel/Sitetend.git

rem Local-only notes (Chinese documentation, internal history, personal test checklist, evaluation logs) stay on this computer.
git rm -r -q --cached --ignore-unmatch docs/archive docs/TEST_TODO_WINDOWS.md README.zh-CN.md "docs/*.md" eval/runs >nul 2>&1
git add -A
rem Mac / Linux start files must stay executable (Windows does not record this by itself).
git update-index --chmod=+x start-mac.command start-linux.sh >nul 2>&1
rem A fixed English message: %DATE% is written in the language of Windows.
git commit -m "Update Sitetend" || echo (nothing new to commit)
echo.
echo Uploading... A GitHub sign-in window may open the first time; sign in there.
git push -u origin main
if errorlevel 1 (echo. & echo Upload failed. The message above says what went wrong. & pause & exit /b 1)
echo.
echo Done: https://github.com/zyt-slowpixel/Sitetend
pause
