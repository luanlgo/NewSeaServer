// managers/wreck-manager.js — Ruínas saqueáveis da Zona Vermelha (PvP)
//
// Quando um jogador morre num mapa com pvpZone 'red' (qualquer causa: PvP,
// arauto, aura, DoT), ele perde WRECK_GOLD_PCT do ouro na hora e uma ruína
// (naufrágio) nasce no ponto da morte com esse ouro dentro. Qualquer jogador
// pode saquear com F (msg loot_wreck) dentro de LOOT_RANGE durante o TTL;
// depois disso o ouro se perde e a ruína some.
//
// Protocolo:
//   server → mapa:   wreck_spawn   {id, x, z, gold, ownerName, ttlMs}
//   server → mapa:   wreck_removed {id, looted, looterId?, looterName?}
//   server → vítima: wreck_gold_lost {amount, gold}
//   server → looter: wreck_looted  {amount, gold} (+ currency_update implícito)
//   client → server: loot_wreck    {wreckId}
'use strict';

const { pvpZoneAtLeast } = require('../constants/maps');

const WRECK_TTL_MS   = 10000;  // ruína fica 10 s no mar
const WRECK_GOLD_PCT = 0.10;   // vítima perde 10% do ouro ao afundar
const LOOT_RANGE     = 60;     // distância máxima do barco até a ruína p/ saquear

class WreckManager {
  /**
   * @param {Function} sendTo   — sendTo(ws, msg) do utils/helpers
   * @param {Function} addEvent — broadcast bufferizado por mapa do server.js
   */
  constructor(sendTo, addEvent) {
    this.sendTo   = sendTo;
    this.addEvent = addEvent;
    this.wrecks   = new Map();   // id → {id, mapLevel, x, z, gold, ownerName, expiresAt}
    this._seq     = 1;
  }

  /**
   * Chame em TODO caminho onde um jogador morre (projétil, ataque, aura, DoT).
   *
   * ── A conta do ouro mora aqui, o recipiente nem sempre ─────────────────────
   * Quanto a vítima perde é decisão deste arquivo e de mais nenhum —
   * WRECK_GOLD_PCT é a penalidade de morte da zona vermelha, uma só. O que o
   * espólio de abordagem mudou foi ONDE esse ouro vai parar: numa zona Red ele
   * entra num destroço de 1 hora que exige vencer uma batalha
   * (managers/spoil-manager.js), e a ruína de 10 segundos não é criada. Uma
   * segunda porcentagem aqui dobraria a penalidade de morte sem que nenhum dos
   * dois arquivos dissesse isso.
   *
   * @param {Function|null} onSpoilZone  recebe (player, loss) e devolve true se
   *        absorveu o naufrágio — nesse caso não nasce ruína.
   */
  onPlayerDeath(player, onSpoilZone = null) {
    if (!player || player.isNPC) return;
    const lvl = player.mapLevel || 1;
    // `>= red` e não `=== 'red'`: uma zona futura mais severa herda a regra em
    // vez de silenciosamente parar de dropar ouro.
    if (!pvpZoneAtLeast(lvl, 'red')) return;

    const loss = Math.floor((player.gold || 0) * WRECK_GOLD_PCT);
    if (loss <= 0) return;

    player.gold = (player.gold || 0) - loss;
    this.sendTo(player.ws, { type: 'wreck_gold_lost', amount: loss, gold: player.gold });
    this.journal?.ledger(player, 'wreck_death', { gold: -loss });

    // Zona de espólio: o pote vai para o destroço de 1h em vez da ruína de 10s.
    if (onSpoilZone && onSpoilZone(player, loss)) return;

    const id = `wreck_${this._seq++}`;
    const wreck = {
      id, mapLevel: lvl,
      x: player.x, z: player.z,
      gold: loss,
      ownerName: player.name,
      expiresAt: Date.now() + WRECK_TTL_MS,
    };
    this.wrecks.set(id, wreck);
    this.addEvent({
      type: 'wreck_spawn',
      id, x: wreck.x, z: wreck.z,
      gold: loss, ownerName: player.name, ttlMs: WRECK_TTL_MS,
    }, lvl);
    console.log(`⚓ Ruína ${id}: ${player.name} dropou ${loss} de ouro no mapa ${lvl}`);
  }

  /** Handler do loot_wreck — valida mapa/vida/distância e credita o ouro. */
  tryLoot(player, wreckId) {
    if (!player || player.dead) return;
    const w = this.wrecks.get(wreckId);
    if (!w) return;                                     // já saqueada/expirada
    if ((player.mapLevel || 1) !== w.mapLevel) return;
    if (Date.now() > w.expiresAt) return;               // update() vai limpar
    if (Math.hypot(player.x - w.x, player.z - w.z) > LOOT_RANGE) return;

    this.wrecks.delete(wreckId);
    player.gold = (player.gold || 0) + w.gold;
    this.journal?.ledger(player, 'wreck_loot', { gold: w.gold }, { target: w.ownerName || '' });

    this.sendTo(player.ws, { type: 'wreck_looted', amount: w.gold, gold: player.gold });
    this.sendTo(player.ws, { type: 'currency_update', gold: player.gold, dobroes: player.dobroes, reward: { type: 'gold', amount: w.gold } });
    this.addEvent({
      type: 'wreck_removed', id: wreckId,
      looted: true, looterId: player.id, looterName: player.name,
    }, w.mapLevel);
    console.log(`⚓ Ruína ${wreckId}: saqueada por ${player.name} (+${w.gold} ouro)`);
  }

  /** Expira ruínas — chamar a cada tick do game loop. */
  update(now) {
    if (this.wrecks.size === 0) return;
    for (const [id, w] of this.wrecks) {
      if (now > w.expiresAt) {
        this.wrecks.delete(id);
        this.addEvent({ type: 'wreck_removed', id, looted: false }, w.mapLevel);
      }
    }
  }

  /** Ruínas ativas de um mapa — enviadas no init/map_transition p/ quem entra no meio do TTL. */
  snapshot(mapLevel) {
    const now = Date.now();
    const out = [];
    this.wrecks.forEach(w => {
      if (w.mapLevel === mapLevel && now < w.expiresAt) {
        out.push({ id: w.id, x: w.x, z: w.z, gold: w.gold, ownerName: w.ownerName, ttlMs: w.expiresAt - now });
      }
    });
    return out;
  }
}

module.exports = { WreckManager, WRECK_TTL_MS, WRECK_GOLD_PCT, LOOT_RANGE };
