@echo off
rem Portable launcher - double-click to run, no Node.js needed.
rem All data (assets/settings) lives in .\data - the whole folder is movable.
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
