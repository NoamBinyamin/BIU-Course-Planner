@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Uploads the data saved with "פרסום לגרסה המקוונת" so GitHub Pages shows it.
if not exist "web\data\snapshot.json" (
  echo לא נמצא קובץ נתונים. קודם לוחצים "פרסום לגרסה המקוונת" בתחתית האתר המקומי.
  pause
  exit /b 1
)
git add web/data/snapshot.json
git commit -m "עדכון נתוני המערכת" || echo אין שינויים חדשים לפרסום.
git push
echo.
echo הנתונים הועלו. האתר בגיטהאב יתעדכן תוך דקה-שתיים.
pause
