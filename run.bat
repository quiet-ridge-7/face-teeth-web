@echo off
cd /d "%~dp0"
if "%PORT%"=="" set PORT=8782
echo Starting the local server on http://localhost:%PORT% (this PC only).
echo Close this window to stop it.
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:%PORT%"
python -m http.server %PORT% --bind 127.0.0.1
