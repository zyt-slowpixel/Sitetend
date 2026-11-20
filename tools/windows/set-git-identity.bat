@echo off
setlocal
echo === Use your GitHub username and a private email for Git commits ===
echo.
echo Every commit records an author name and email, and anyone who can see the repository can read them.
echo This sets them to your GitHub username and GitHub's private "noreply" address, so your real name and
echo Gmail address are not shown in new commits.
echo.
echo Your private address (from GitHub, Settings, Emails) is filled in below.
echo If GitHub ever shows a different one there:
echo   GitHub, top right avatar, Settings, Emails
echo   Turn on "Keep my email addresses private". The page then shows an address like
echo   12345678+zyt-slowpixel@users.noreply.github.com
echo.
where git >nul 2>&1 || (echo Git was not found. & pause & exit /b 1)
set "NE=335038095+zyt-slowpixel@users.noreply.github.com"
echo Address: %NE%
set /p "OTHER=Press Enter to use it, or paste a different noreply address: "
if defined OTHER set "NE=%OTHER%"
if not defined NE (echo Nothing entered; nothing changed. & pause & exit /b 1)
echo %NE% | findstr /i /c:"@users.noreply.github.com" >nul || (echo That does not look like a GitHub noreply address; nothing changed. & pause & exit /b 1)
git config --global user.name "zyt-slowpixel"
git config --global user.email "%NE%"
echo.
echo Done. New commits will show: zyt-slowpixel ^<%NE%^>
echo Commits made before this still show the old name and email.
pause
