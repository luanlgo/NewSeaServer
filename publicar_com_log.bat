@echo off
:: -- Wrapper de diagnostico do publicar.bat -----------------------------------
:: Roda o publicar.bat normal, mas grava TUDO em publicar_log.txt e segura a
:: janela no final aconteca o que acontecer. Use este por duplo clique quando o
:: publicar fechar sozinho: o log sobrevive mesmo que a janela suma.
::
:: `call` e essencial: sem ele, chamar um .bat de dentro de outro TRANSFERE o
:: controle e nunca volta - o que, por sinal, e um jeito de um script "sumir".

cd /d "%~dp0"
set LOG=%~dp0publicar_log.txt

echo Gravando em: %LOG%
echo.

call "%~dp0publicar.bat" > "%LOG%" 2>&1
set RC=%ERRORLEVEL%

echo.
echo ================================================
echo  publicar.bat terminou com codigo: %RC%
echo  Log completo em: %LOG%
echo ================================================
echo.
echo  ---- ultimas linhas do log ----
powershell -NoProfile -Command "Get-Content '%LOG%' -Tail 25"
echo  -------------------------------
echo.
pause
