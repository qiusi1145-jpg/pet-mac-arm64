@echo off
rem Debug launcher: keeps a console open with [main] logs (PET_DEBUG=1).
cd /d "%~dp0"
set PET_DEBUG=1
"%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
pause
