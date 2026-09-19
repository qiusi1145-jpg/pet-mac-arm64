@echo off
rem ============================================================
rem  One-click packaging entry. Keep this file ASCII-only:
rem  all paths (incl. the Chinese folder name) resolve via %~dp0
rem  at runtime, so no Chinese literals are needed here.
rem ============================================================
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found in PATH. Please install Node.js LTS first.
  pause
  exit /b 1
)
cd /d "%~dp0.."
node "%~dp0build.js"
set BUILD_EC=%ERRORLEVEL%
echo.
if "%BUILD_EC%"=="0" (
  echo [DONE] Build finished successfully. Output is in the "out" folder.
) else (
  echo [FAILED] build.js exited with code %BUILD_EC%. Read the log above.
)
pause
