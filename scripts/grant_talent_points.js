#!/usr/bin/env node
// scripts/grant_talent_points.js — Devolve pontos de talento LIVRES a uma conta.
//
// Por que existe: até a coluna `talent_points` entrar, os pontos livres (os que
// voltam de um reset ou de uma devolução avulsa) viviam SÓ na memória do
// processo. Quem resetou a árvore e não gastou tudo antes do próximo restart do
// servidor perdeu o saldo: o banco guardava a árvore zerada (o reset salva isso)
// e o saldo livre em lugar nenhum. Não há como reconstruir o número — o extrato
// só registra a compra que saiu em moeda, não a devolução — então a reposição é
// manual, com o valor que o jogador informar.
//
// Uso:
//   node scripts/grant_talent_points.js <nomeDaConta> <quantidade>
//
// Exemplo:
//   node scripts/grant_talent_points.js Bagatinha 300
//
// O valor é SOMADO ao saldo atual (aditivo). Rodar duas vezes concede duas
// vezes — confira o saldo que ele imprime antes de repetir.
//
// ⚠️  A CONTA NÃO PODE ESTAR LOGADA. O servidor mantém o jogador em memória e
//     regrava tudo a cada 15s (batchSave); com a conta conectada, a gravação do
//     servidor sobrescreve o que este script escreveu e os pontos somem sem
//     erro nenhum aparecer. Desconecte antes de rodar.
//
// A escrita é de UMA coluna (db.addTalentPoints), e não um `_flush`: o objeto
// que o `loadOrCreate` devolve tem o formato do `_parse`, não o do jogador em
// memória, e mandá-lo ao `_flush` apaga canhões equipados, velas, tripulação e
// navio ativo em silêncio. Ver a nota no próprio addTalentPoints.

'use strict';
require('dotenv').config();

const db = require('../managers/db-manager');

const ACCOUNT_NAME = process.argv[2];
const AMOUNT       = Math.floor(Number(process.argv[3]));

async function main() {
  if (!ACCOUNT_NAME || !(AMOUNT > 0)) {
    console.error('Uso: node scripts/grant_talent_points.js <nomeDaConta> <quantidade>');
    process.exit(1);
  }

  await db.init();   // garante que a coluna talent_points existe

  const r = await db.addTalentPoints(ACCOUNT_NAME, AMOUNT);
  if (!r) {
    console.error(`❌ Conta "${ACCOUNT_NAME}" não existe.`);
    process.exit(1);
  }

  console.log(`✅ "${ACCOUNT_NAME}": +${AMOUNT} ponto(s) de talento livre(s).`);
  console.log(`   Livres: ${r.antes} → ${r.depois}`);
  console.log('   (os pontos já gastos na árvore continuam onde estavam — o');
  console.log('    painel soma os dois para validar uma build guardada)');
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Erro ao conceder pontos de talento:', err);
  process.exit(1);
});
