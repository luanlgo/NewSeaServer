@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title Sea of Code — Publicar Build
cd /d "%~dp0"

echo.
echo  ╔══════════════════════════════════════════╗
echo  ║   Sea of Code — Publicar nova versao     ║
echo  ╚══════════════════════════════════════════╝
echo.

:: ── Lê versão atual do manifest (via PowerShell) ─────────────────────────────
for /f "usebackq delims=" %%v in (
  `powershell -NoProfile -Command "(Get-Content 'launcher-manifest.json' | ConvertFrom-Json).version"`
) do set CURRENT_VER=%%v

if "!CURRENT_VER!"=="" (
  echo [ERRO] Nao foi possivel ler launcher-manifest.json
  pause & exit /b 1
)

:: ── Incrementa patch (major.minor.PATCH++) ───────────────────────────────────
for /f "tokens=1,2,3 delims=." %%a in ("!CURRENT_VER!") do (
  set VER_MAJ=%%a
  set VER_MIN=%%b
  set VER_PAT=%%c
)
set /a VER_PAT_NEW=!VER_PAT!+1
set NEW_VER=!VER_MAJ!.!VER_MIN!.!VER_PAT_NEW!

echo  Versao atual : !CURRENT_VER!
echo  Nova versao  : !NEW_VER!
echo.
echo  Pressione Enter para aceitar, ou digite outra versao (ex: 0.3.0):
set /p CUSTOM_VER="  > "
if not "!CUSTOM_VER!"=="" set NEW_VER=!CUSTOM_VER!

:: ── Pasta do build ────────────────────────────────────────────────────────────
set DEFAULT_BUILD=C:\Work\NewSeaGodot\builds\windows
echo.
echo  Pasta do build (Enter para padrao):
echo    %DEFAULT_BUILD%
set /p BUILD_DIR="  > "
if "!BUILD_DIR!"=="" set BUILD_DIR=%DEFAULT_BUILD%

:: ── (Opcional) Exportar via Godot headless ───────────────────────────────────
echo.
set /p DO_EXPORT="  Exportar o jogo pelo Godot agora? (s/n): "
if /i "!DO_EXPORT!"=="s" (
  set GODOT_EXE=
  for %%G in (
    "C:\Program Files\Godot\Godot_v4.6.1-stable_win64.exe"
    "C:\Program Files\Godot\Godot.exe"
    "C:\tools\godot\Godot.exe"
  ) do if exist %%~G (if "!GODOT_EXE!"=="" set GODOT_EXE=%%~G)

  if "!GODOT_EXE!"=="" (
    set /p GODOT_EXE="  Caminho do Godot.exe: "
  )
  echo.
  echo  Exportando com Godot headless...
  if not exist "!BUILD_DIR!" mkdir "!BUILD_DIR!"
  "!GODOT_EXE!" --headless --path "C:\Work\NewSeaGodot" ^
    --export-release "Windows Desktop" "!BUILD_DIR!\SeaOfCode.exe"
  if errorlevel 1 (
    echo [ERRO] Falha ao exportar. Verifique o preset "Windows Desktop" no Godot.
    pause & exit /b 1
  )
  echo  Exportacao concluida!
)

:: ── Verifica arquivos do build ────────────────────────────────────────────────
echo.
echo  Verificando arquivos...
if not exist "!BUILD_DIR!\SeaOfCode.exe" (
  echo [ERRO] SeaOfCode.exe nao encontrado em: !BUILD_DIR!
  echo        Exporte o projeto Godot antes de publicar.
  pause & exit /b 1
)
if not exist "!BUILD_DIR!\SeaOfCode.pck" (
  echo [ERRO] SeaOfCode.pck nao encontrado em: !BUILD_DIR!
  pause & exit /b 1
)
echo   [OK] SeaOfCode.exe
echo   [OK] SeaOfCode.pck

:: ── Calcula SHA-256 e atualiza manifest ──────────────────────────────────────
echo.
echo  Calculando SHA-256 e atualizando manifest...
node scripts\publish.js !NEW_VER! "!BUILD_DIR!"
if errorlevel 1 (
  echo [ERRO] publish.js falhou.
  pause & exit /b 1
)

:: ── Edita changelog no Notepad ───────────────────────────────────────────────
echo.
echo  Abrindo launcher-manifest.json para editar o changelog...
echo  (Feche o Notepad quando terminar)
notepad launcher-manifest.json
echo  Changelog salvo.

:: ── Git commit + push do manifest ────────────────────────────────────────────
echo.
set /p DO_GIT="  Commitar e enviar manifest (s/n)? "
if /i "!DO_GIT!"=="s" (
  git add launcher-manifest.json
  git commit -m "release: v!NEW_VER!"
  git push
  if errorlevel 1 (
    echo  AVISO: git push falhou. Envie o manifest manualmente.
  ) else (
    echo  Manifest enviado!
  )
)

:: ── GitHub Release ────────────────────────────────────────────────────────────
echo.
echo  Criando GitHub Release v!NEW_VER!...
where gh >nul 2>&1
if errorlevel 1 (
  echo  gh CLI nao encontrado. Abra o link manualmente e faca upload de:
  echo    - !BUILD_DIR!\SeaOfCode.exe
  echo    - !BUILD_DIR!\SeaOfCode.pck
  echo.
  start https://github.com/luanlgo/NewSea/releases/new
) else (
  gh release create "v!NEW_VER!" ^
    "!BUILD_DIR!\SeaOfCode.exe" ^
    "!BUILD_DIR!\SeaOfCode.pck" ^
    --repo luanlgo/NewSea ^
    --title "Sea of Code v!NEW_VER!" ^
    --notes "Build !NEW_VER! — veja launcher-manifest.json para o changelog."
  if errorlevel 1 (
    echo  AVISO: erro ao criar release. Tente manualmente.
    start https://github.com/luanlgo/NewSea/releases/new
  ) else (
    echo  Release criado! Jogadores vao receber o update automaticamente.
  )
)

:: ── Deploy no servidor de producao ──────────────────────────────────────────
echo.
set /p DO_DEPLOY="  Atualizar servidor de producao via SSH? (s/n): "
if /i "!DO_DEPLOY!"=="s" (
  echo  Conectando em root@164.163.9.91...
  ssh root@164.163.9.91 "cd ~/NewSeaServer && git pull"
  if errorlevel 1 (
    echo  AVISO: SSH falhou. Atualize o servidor manualmente:
    echo    ssh root@164.163.9.91
    echo    cd ~/NewSeaServer ^&^& git pull
  ) else (
    echo  Servidor atualizado! Manifest v!NEW_VER! ativo.
  )
)

:: ── Fim ───────────────────────────────────────────────────────────────────────
echo.
echo  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo    v!NEW_VER! publicada com sucesso!
echo  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo.
pause
