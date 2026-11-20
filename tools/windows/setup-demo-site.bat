@echo off
setlocal
cd /d "%~dp0..\.."
set "DEST=%~dp0..\..\..\sitetend-demo-site"
set "REMOTE=https://github.com/zyt-slowpixel/sitetend-demo-site.git"
echo === Set up the demo website for the publish test ===
echo Folder: %DEST%
echo GitHub: %REMOTE%
echo.
where git >nul 2>&1 || (echo Git was not found. & pause & exit /b 1)
if exist "%DEST%" (echo The folder already exists. Delete or rename it first, then run this again. & pause & exit /b 1)

rem 1. The folder IS the website. Materials go in the hidden .sitetend folder (never uploaded).
mkdir "%DEST%" || (echo Could not create the folder. & pause & exit /b 1)
xcopy "demo-workspace\website\*" "%DEST%\" /E /I /Q >nul || (echo Copy failed. & pause & exit /b 1)
xcopy "demo-workspace\sources\*" "%DEST%\.sitetend\materials\" /E /I /Q >nul || (echo Copy failed. & pause & exit /b 1)
> "%DEST%\.gitignore" echo .sitetend/

rem 2. First upload of the website.
cd /d "%DEST%"
git init -b main >nul || (echo git init failed & pause & exit /b 1)
git add -A
git commit -m "Demo website (starting point)" >nul || (echo Commit failed. Run upload-to-github.bat once first so Git knows your name and email. & pause & exit /b 1)
git remote add origin %REMOTE%
echo Uploading... (a GitHub sign-in window may open)
git push -u origin main
if errorlevel 1 (echo. & echo Upload failed. Make sure the GitHub repository sitetend-demo-site exists and is empty, then try again (the message above says what went wrong). & pause & exit /b 1)
echo.
echo Done. Now in Sitetend: open the folder
echo   %DEST%
echo then Settings - Publish - Git, change a material, accept, and click Publish.
pause
