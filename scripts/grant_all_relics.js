#!/usr/bin/env node
// scripts/grant_all_relics.js — Concede à conta indicada UMA cópia de cada
// relíquia que ela ainda não tem, SEM tocar em mais nada.
//
// Por que existe, se já há o seed_test_account.js: aquele script RESETA a conta
// inteira (ouro, navios, talentos, mapa, canhões) para o estado de teste. Quando
// só se quer testar as relíquias novas numa conta que já foi jogada, resetar
// joga fora o progresso. Este aqui é aditivo e idempotente — rodar duas vezes
// não duplica nada.
//
// Uso:
//   node scripts/grant_all_relics.js [nomeDaConta]      (padrão: adm)
//
// ⚠️  A CONTA NÃO PODE ESTAR LOGADA. O servidor mantém o jogador em memória e
//     regrava o inventário periodicamente (batchSave, 15s) — se ela estiver
//     conectada, a gravação do servidor sobrescreve o que este script escreveu
//     e as relíquias somem sem erro nenhum aparecer. Desconecte antes de rodar.

'use strict';
require('dotenv').config();

const db = require('../managers/db-manager');
const { RELIC_DEFS } = require('../constants');

const ACCOUNT_NAME = process.argv[2] || 'adm';

async function main() {
  await db.init();

  const player = await db.loadOrCreate(ACCOUNT_NAME);
  if (!player.inventory) player.inventory = {};
  const owned = player.inventory.relics || [];
  const ownedIds = new Set(owned.map(r => r.relicId));

  const missing = Object.keys(RELIC_DEFS).filter(id => !ownedIds.has(id));
  if (missing.length === 0) {
    console.log(`✅ "${ACCOUNT_NAME}" já tem as ${ownedIds.size} relíquias — nada a fazer.`);
    process.exit(0);
  }

  // instanceId com timestamp: não colide com os `rl_seed_*` do seed nem com os
  // `rl_<ts>_<rand>` que o drop de NPC gera.
  const stamp = Date.now();
  const added = missing.map((relicId, i) => ({
    instanceId: `rl_grant_${stamp}_${i}`,
    relicId,
    rarity: RELIC_DEFS[relicId].rarity,
  }));

  player.inventory.relics = owned.concat(added);

  // _flush urgente (não o batchSave): grava TODOS os campos na hora, inclusive
  // rare_ships. O batchSave omite rare_ships de propósito — ver db-manager.js.
  await db._flush(player);

  console.log(`✅ "${ACCOUNT_NAME}": +${added.length} relíquia(s) concedida(s).`);
  console.log(`   Total agora: ${player.inventory.relics.length} (${Object.keys(RELIC_DEFS).length} definidas)`);
  const byRarity = {};
  for (const a of added) byRarity[a.rarity] = (byRarity[a.rarity] || 0) + 1;
  console.log('   Novas por raridade:',
    Object.entries(byRarity).map(([r, n]) => `${r} ${n}`).join(', '));
  console.log(`   Concedidas: ${added.map(a => a.relicId).join(', ')}`);
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Erro ao conceder relíquias:', err);
  process.exit(1);
});
