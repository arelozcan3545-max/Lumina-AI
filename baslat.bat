@echo off
chcp 65001 >nul
title Lumina AI Engine - Baslatici
color 0b

echo ============================================================
echo               LUMINA AI ENGINE v3.0 (Enterprise)
echo       Duygusal, Zeki, Coklu Ajan ve Smart UI Destekli
echo ============================================================
echo.

REM Python kontrolü ve yerel yol tespiti
where python >nul 2>nul
if %errorlevel% neq 0 (
    if exist "%LOCALAPPDATA%\Programs\Python\Python311\python.exe" (
        set "PATH=%LOCALAPPDATA%\Programs\Python\Python311;%LOCALAPPDATA%\Programs\Python\Python311\Scripts;%PATH%"
    ) else if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" (
        set "PATH=%LOCALAPPDATA%\Programs\Python\Python312;%LOCALAPPDATA%\Programs\Python\Python312\Scripts;%PATH%"
    ) else if exist "%LOCALAPPDATA%\Programs\Python\Python310\python.exe" (
        set "PATH=%LOCALAPPDATA%\Programs\Python\Python310;%LOCALAPPDATA%\Programs\Python\Python310\Scripts;%PATH%"
    )
)

echo [1/2] Lumina AI Backend Sunucusu Baslatiliyor...
echo       Adres: http://127.0.0.1:8000
echo.

start "" "index.html"

echo [2/2] Arayuz acildi. Sunucu loglari asagidadir:
echo.
python -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload

pause
