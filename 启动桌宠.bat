@echo off
rem Deskpet launcher (ASCII only to avoid cmd codepage issues).
rem The app dir is passed as "%~dp0." -- it never ends in a backslash right
rem before the closing quote, so Windows cannot swallow the quote (that was
rem the cause of "Unable to find Electron app").
cd /d "%~dp0"
"%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
echo.
echo Deskpet closed. If there were red error lines above, copy them.
pause
