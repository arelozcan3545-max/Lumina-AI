@echo off
chcp 65001 >nul
title Lumina AI Engine - Baslatici
color 0b
setlocal
cd /d "%~dp0"

echo ============================================================
echo               LUMINA AI ENGINE v3.2 (Enterprise)
echo       Duygusal, Zeki, Coklu Ajan ve Smart UI Destekli
echo ============================================================
echo.

REM Python kontrolü ve yerel yol tespiti (.venv önceliklidir)
set "PYTHON=python"
if exist ".venv\Scripts\python.exe" (
    set "PYTHON=%CD%\.venv\Scripts\python.exe"
) else (
    where python >nul 2>nul
    if %errorlevel% neq 0 (
        if exist "%LOCALAPPDATA%\Programs\Python\Python311\python.exe" (
            set "PYTHON=%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
        ) else if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" (
            set "PYTHON=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
        ) else if exist "%LOCALAPPDATA%\Programs\Python\Python310\python.exe" (
            set "PYTHON=%LOCALAPPDATA%\Programs\Python\Python310\python.exe"
        )
    )
)

echo [1/3] Lumina AI Backend Sunucusu Baslatiliyor...
echo       Adres: http://127.0.0.1:8000
echo.
start "Lumina AI Backend" "%PYTHON%" -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload

echo [2/3] Statik Arayuz Sunucusu Baslatiliyor...
echo       Adres: http://localhost:5500
echo       NOT: Google ile giris icin localhost adresi kullanilmalidir.
echo.
start "Lumina AI Arayuz" "%PYTHON%" -m http.server 5500 --bind 127.0.0.1

echo [3/3] Tarayici aciliyor: http://localhost:5500/index.html
timeout /t 2 /nobreak >nul
start "" "http://localhost:5500/index.html"

echo.
echo ============================================================
echo  Lumina AI calisiyor.
echo  Kapatmak icin acilan Backend ve Arayuz pencerelerini kapat.
echo ============================================================
pause
endlocal
