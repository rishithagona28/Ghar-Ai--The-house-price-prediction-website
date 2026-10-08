@echo off
cd /d "%~dp0"
echo Starting GharAI...
echo Leave this window open while you use the app. Close it to stop GharAI.
echo.
rem open the browser a few seconds after the server starts loading
start "" cmd /c "timeout /t 6 >nul & start http://localhost:8000"
".venv\Scripts\python.exe" -m uvicorn backend.main:app --port 8000
echo.
echo GharAI stopped.
pause
