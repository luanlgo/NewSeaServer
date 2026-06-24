@echo off
setlocal enabledelayedexpansion
title Sea of Code - Publicar Build
cd /d "%~dp0"

echo.
echo  ==========================================
echo     Sea of Code - Publicar nova versao
echo  ==========================================
echo.

for /f "usebackq delims=" %%v in (
  `powershell -NoProfile -Command "(Get-Content 'launcher-manifest.json' | ConvertFrom-Json).version"`
) do set CURRENT_VER=%%v

if "!CURRENT_VER!"=="" (
  echo [ERRO] Nao foi possivel ler launcher-manifest.json
  pause & exit /b 1
)

for /f "tokens=1,2,3 delims=." %%a in ("!CURRENT_VER!") do (
  set VER_MAJ=%%a
  set VER_MIN=%%b
  set VER_PAT=%%c
)
set /a VER_PAT_NEW=!VER_PAT!+1
set NEW_VER=!VER_MAJ!.!VER_MIN!.!VER_PAT_NEW!

echo  Versao atual : !CURRENT_VER!
echo  Nova versao  : !NEW_VER!  (Enter para confirmar, ou digite outra ex: 0.3.0)
set /p CUSTOM_VER="  > "
if not "!CUSTOM_VER!"=="" set NEW_VER=!CUSTOM_VER!
echo  Publicando v!NEW_VER!...

set BUILD_DIR=C:\Work\NewSeaGodot\builds\windows

echo.
set /p DO_EXPORT="  Exportar o jogo agora? (s/n): "
if /i "!DO_EXPORT!"=="s" (
  set GODOT_EXE=C:\Users\luang\Downloads\Godot_v4.6.1-stable_win64.exe\Godot_v4.6.1-stable_win64.exe
  echo  Exportando com Godot headless...
  "!GODOT_EXE!" --headless --path "C:\Work\NewSeaGodot" --export-release "Windows Desktop" "!BUILD_DIR!\SeaOfCode.exe"
  if errorlevel 1 (
    echo [ERRO] Falha ao exportar.
    pause & exit /b 1
  )
  echo  Exportacao concluida!
)

echo.
echo  Verificando arquivos...
if not exist "!BUILD_DIR!\SeaOfCode.exe" (
  echo [ERRO] SeaOfCode.exe nao encontrado em: !BUILD_DIR!
  pause & exit /b 1
)
echo   [OK] SeaOfCode.exe
if exist "!BUILD_DIR!\SeaOfCode.pck" (
  echo   [OK] SeaOfCode.pck
) else (
  echo   [INFO] PCK embutido no exe.
)

echo.
echo  Calculando SHA-256 e atualizando manifest...
node scripts\publish.js !NEW_VER! "!BUILD_DIR!"
if errorlevel 1 (
  echo [ERRO] publish.js falhou.
  pause & exit /b 1
)

echo.
echo  Gerando changelog dos commits recentes...
for /f "usebackq delims=" %%t in (
  `git describe --tags --abbrev=0 2^>nul`
) do set LAST_TAG=%%t

if "!LAST_TAG!"=="" (
  set GIT_LOG_CMD=git log --oneline -10 --pretty=format:"%%s"
) else (
  set GIT_LOG_CMD=git log !LAST_TAG!..HEAD --oneline --pretty=format:"%%s"
)

powershell -NoProfile -Command ^
  "$ver = '!NEW_VER!'; ^
   $lastTag = '!LAST_TAG!'; ^
   $range = if ($lastTag) { '$lastTag..HEAD' } else { '-10' }; ^
   $logs = git log $(if ($lastTag) { \"$lastTag..HEAD\" } else { '-10' }) --pretty=format:'%%s' 2>$null; ^
   $entries = @(\"[v$ver] - $(Get-Date -Format 'yyyy-MM-dd')\") + $logs; ^
   $json = Get-Content 'launcher-manifest.json' | ConvertFrom-Json; ^
   $json.changelog = $entries; ^
   $json | ConvertTo-Json -Depth 5 | Set-Content 'launcher-manifest.json' -Encoding UTF8; ^
   Write-Host '  [OK] Changelog gerado com' $entries.Count 'entradas.'"

echo.
echo  Commitando manifest...
git add launcher-manifest.json
git commit -m "release: v!NEW_VER!"
git push
if errorlevel 1 (
  echo  AVISO: git push falhou.
) else (
  echo  Manifest enviado!
)

echo.
echo  Criando GitHub Release v!NEW_VER!...
where gh >nul 2>&1
if errorlevel 1 (
  echo  gh CLI nao encontrado. Faca upload manual em:
  echo    https://github.com/luanlgo/NewSeaGodot/releases/new
) else (
  set GH_FILES="!BUILD_DIR!\SeaOfCode.exe"
  if exist "!BUILD_DIR!\SeaOfCode.pck" set GH_FILES=!GH_FILES! "!BUILD_DIR!\SeaOfCode.pck"
  gh release create "v!NEW_VER!" !GH_FILES! --repo luanlgo/NewSeaGodot --title "Sea of Code v!NEW_VER!" --notes "Build !NEW_VER!"
  if errorlevel 1 (
    echo  AVISO: erro ao criar release.
  ) else (
    echo  Release criado!
  )
)

echo.
set /p TEM_SERVER="  Teve alteracoes no servidor? (s/n): "
if /i "!TEM_SERVER!"=="s" (
  ssh root@164.163.9.91 "cd ~/NewSeaServer && git pull && pm2 restart server"
  if errorlevel 1 (
    echo  AVISO: SSH falhou.
  ) else (
    echo  Servidor atualizado!
  )
)

echo.
echo  ==========================================
echo    v!NEW_VER! publicada com sucesso!
echo  ==========================================
echo.
pause