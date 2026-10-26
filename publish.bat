@echo off
cd /d "%~dp0"
rem Uploads the data saved with the "publish" button so the GitHub Pages copy shows it.
if not exist "web\data\snapshot.json" (
  echo No published data found. First click "Publish" at the bottom of the local site.
  pause
  exit /b 1
)
git add web/data/snapshot.json
git commit -m "Update published data"
if errorlevel 1 echo Nothing new to publish - uploading anyway.
git push
if errorlevel 1 (
  echo.
  echo Upload failed. Check your internet connection / GitHub sign-in and try again.
  pause
  exit /b 1
)
echo.
echo Done. The GitHub Pages site updates within a minute or two.
pause
