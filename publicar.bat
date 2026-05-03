@echo off
setlocal enabledelayedexpansion
title Sea of Code — Publicar Build

echo.
echo  =========================================
echo    Sea of Code — Publicar Nova Versao
echo  =========================================
echo.

:: ── Versao ───────────────────────────────────────────────────────────────────
set /p VERSION="  Versao (ex: 0.2.0): "
if "%VERSION%"=="" (
    echo  ERRO: versao nao pode ser vazia.
    pause & exit /b 1
)

:: ── Pasta do build ───────────────────────────────────────────────────────────
set DEFAULT_BUILD=C:\Work\NewSeaGodot\builds\windows
set /p BUILD_DIR="  Pasta do build [%DEFAULT_BUILD%]: "
if "%BUILD_DIR%"=="" set BUILD_DIR=%DEFAULT_BUILD%

if not exist "%BUILD_DIR%" (
    echo  ERRO: pasta nao encontrada: %BUILD_DIR%
    pause & exit /b 1
)

:: ── (Opcional) Exportar o jogo via Godot headless ────────────────────────────
echo.
set /p DO_EXPORT="  Exportar o jogo pelo Godot agora? (s/n): "
if /i "%DO_EXPORT%"=="s" (
    set GODOT_EXE=
    for %%G in (
        "C:\Program Files\Godot\Godot_v4.6.1-stable_win64.exe"
        "C:\Program Files\Godot\Godot.exe"
        "C:\tools\godot\Godot.exe"
    ) do (
        if exist %%G (
            if "!GODOT_EXE!"=="" set GODOT_EXE=%%~G
        )
    )
    if "!GODOT_EXE!"=="" (
        set /p GODOT_EXE="  Caminho do Godot.exe: "
    )
    echo.
    echo  Exportando com Godot headless...
    if not exist "%BUILD_DIR%" mkdir "%BUILD_DIR%"
    "!GODOT_EXE!" --headless --path "C:\Work\NewSeaGodot" ^
        --export-release "Windows Desktop" "%BUILD_DIR%\SeaOfCode.exe"
    if errorlevel 1 (
        echo  ERRO ao exportar. Verifique o preset "Windows Desktop" no Godot.
        pause & exit /b 1
    )
    echo  Exportacao concluida!
)

:: ── Verifica se os arquivos do build existem ─────────────────────────────────
echo.
echo  Verificando arquivos do build...
set FOUND=0
if exist "%BUILD_DIR%\SeaOfCode.exe" (echo   [OK] SeaOfCode.exe & set /a FOUND+=1)
if exist "%BUILD_DIR%\SeaOfCode.pck" (echo   [OK] SeaOfCode.pck & set /a FOUND+=1)
if %FOUND%==0 (
    echo  ERRO: nenhum arquivo encontrado em %BUILD_DIR%
    pause & exit /b 1
)

:: ── Calcula hashes e atualiza launcher-manifest.json ─────────────────────────
echo.
echo  Calculando SHA-256 e atualizando manifest...
node "%~dp0scripts\publish.js" %VERSION% "%BUILD_DIR%"
if errorlevel 1 (
    echo  ERRO ao rodar publish.js
    pause & exit /b 1
)

:: ── Editar changelog no Notepad ───────────────────────────────────────────────
echo.
echo  Abrindo launcher-manifest.json para voce editar o changelog...
echo  (Feche o Notepad quando terminar)
echo.
notepad "%~dp0launcher-manifest.json"
echo  Changelog salvo.

:: ── Git commit + push do manifest ────────────────────────────────────────────
echo.
set /p DO_GIT="  Commitar e enviar manifest para o servidor? (s/n): "
if /i "%DO_GIT%"=="s" (
    cd /d "%~dp0"
    git add launcher-manifest.json
    git commit -m "release: v%VERSION%"
    git push
    if errorlevel 1 (
        echo  AVISO: git push falhou. Envie manualmente.
    ) else (
        echo  Manifest enviado!
    )
)

:: ── GitHub Release ────────────────────────────────────────────────────────────
echo.
echo  Criando GitHub Release v%VERSION%...
where gh >nul 2>&1
if errorlevel 1 (
    echo  gh CLI nao encontrado. Abrindo GitHub no navegador...
    echo  Faca upload manual dos arquivos abaixo:
    if exist "%BUILD_DIR%\SeaOfCode.exe" echo    - %BUILD_DIR%\SeaOfCode.exe
    if exist "%BUILD_DIR%\SeaOfCode.pck" echo    - %BUILD_DIR%\SeaOfCode.pck
    echo.
    start https://github.com/luanlgo/NewSea/releases/new?tag=v%VERSION%
) else (
    set UPLOAD_FILES=
    if exist "%BUILD_DIR%\SeaOfCode.exe" set UPLOAD_FILES=!UPLOAD_FILES! "%BUILD_DIR%\SeaOfCode.exe"
    if exist "%BUILD_DIR%\SeaOfCode.pck" set UPLOAD_FILES=!UPLOAD_FILES! "%BUILD_DIR%\SeaOfCode.pck"

    gh release create "v%VERSION%" !UPLOAD_FILES! ^
        --repo luanlgo/NewSea ^
        --title "Sea of Code v%VERSION%" ^
        --notes "Build %VERSION% — veja launcher-manifest.json para o changelog."
    if errorlevel 1 (
        echo  AVISO: erro ao criar release. Tente manualmente:
        echo  https://github.com/luanlgo/NewSea/releases/new
    ) else (
        echo  Release criado! Os jogadores vao receber o update automaticamente.
    )
)

:: ── Fim ───────────────────────────────────────────────────────────────────────
echo.
echo  =========================================
echo    v%VERSION% publicada com sucesso!
echo  =========================================
echo.
pause
