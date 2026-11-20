@echo off
setlocal
cd /d "%~dp0..\.."
echo === Start a clean history on GitHub ===
echo.
echo This replaces all earlier commits of Sitetend with ONE new commit of the current files,
echo made as zyt-slowpixel, and overwrites the history on GitHub.
echo Your files are not changed. The earlier commits will no longer be on GitHub's main branch.
echo.
where git >nul 2>&1 || (echo Git was not found. & pause & exit /b 1)

rem Only with the private identity, or the new commit would carry the Gmail address again.
for /f "delims=" %%i in ('git config --global user.email 2^>nul') do set "GE=%%i"
echo %GE% | findstr /i /c:"@users.noreply.github.com" >nul || (echo Git still uses "%GE%". Run set-git-identity.bat first. & pause & exit /b 1)
echo Commits will be made as: zyt-slowpixel ^<%GE%^>
echo.
set /p "OK=Type YES to continue: "
if /i not "%OK%"=="YES" (echo Nothing changed. & pause & exit /b 0)

call :fresh "%~dp0..\.." "https://github.com/zyt-slowpixel/Sitetend.git" "Sitetend 1.1.0"
if errorlevel 1 goto failed
echo.
echo Done. The repository now starts from one commit by zyt-slowpixel: https://github.com/zyt-slowpixel/Sitetend
pause
exit /b 0

:failed
echo.
echo Something failed. Copy the messages above for troubleshooting. Your files are unchanged.
pause
exit /b 1

rem ---- %1 folder, %2 repository address, %3 commit message
:fresh
echo.
echo --- %~1
if not exist "%~1\.git" (echo Not a Git folder: %~1 & exit /b 1)
pushd "%~1"
git checkout --orphan sitetend-clean || (popd & exit /b 1)
git rm -r -q --cached --ignore-unmatch docs/archive docs/TEST_TODO_WINDOWS.md README.zh-CN.md "docs/*.md" >nul 2>&1
git add -A
rem Mac / Linux start files must stay executable (Windows does not record this by itself).
git update-index --chmod=+x start-mac.command start-linux.sh >nul 2>&1
git commit -q -m "%~3" || (popd & exit /b 1)
git branch -D main
git branch -m main
git remote set-url origin %~2 2>nul || git remote add origin %~2
git push -f -u origin main || (popd & exit /b 1)
rem Drop the old commits from this computer too.
git reflog expire --expire=now --all
git gc --prune=now -q
git log --format="    now: %%h %%an <%%ae> %%s"
popd
exit /b 0
