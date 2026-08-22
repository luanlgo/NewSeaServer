// utils/talent-effects.js
// Tradução dos 120 talentos em multiplicadores de jogo. Sem I/O, sem WebSocket,
// sem DB — só lê `player.tal` (o mapa stat → total que aggregateTalentStats
// monta em talent-logic.js) e devolve números.
//
// ── Por que este arquivo existe ──────────────────────────────────────────────
// Os stats são 120 e os pontos de aplicação são ~15 (dano do projétil, dano
// recebido, movimento, espólio, relíquia, regen…). Espalhar 120 leituras de
// `player.tal[...]` pelos managers deixaria cada fórmula ilegível e sem teste.
// Aqui cada FAMÍLIA de stats vira uma função pura, e o manager chama uma linha.
//
// ── Unidades ─────────────────────────────────────────────────────────────────
// `player.tal[stat]` guarda o total JÁ na unidade exibida na UI:
//   unit 'pct' / 'redpct' / 'chance' → PONTOS PERCENTUAIS (10 níveis × 2 = 20)
//   unit 'flat'                      → valor bruto
// Por isso quase tudo aqui passa por `_p()`, que divide por 100.
//
// ── Como os bônus se somam ───────────────────────────────────────────────────
// Dentro de uma família os percentuais são ADITIVOS e viram um multiplicador só
// (1 + soma). Multiplicar 12 fontes entre si explodiria: com 1200 pontos, doze
// bônus de +20% multiplicativos dão 8,9× em vez dos 3,4× aditivos. Aditivo
// também é o que o texto do talento promete quando diz "+2% de dano por nível".
//
// ── Talentos de efeito DUPLO ─────────────────────────────────────────────────
// Quatro talentos prometem duas coisas com um `perLevel` só. A segunda metade
// sai de uma razão fixa sobre o total, anotada em cada um:
//   def_coracaoabissal  +3% vida   e +1% redução   → redução = tal / 3
//   def_espiritovento   +2% veloc. e +1% esquiva   → esquiva = tal / 2
//   atk_furiakraken     +5% dano   e −2% redução   → penalidade = tal × 0,4
//   atk_sobrecarga      +3% dano   e +1% mana      → custo = tal / 3
//
// ── Os três que NÃO moram aqui ───────────────────────────────────────────────
// `max_hp_flat` e `max_hp_flat_2` são somados por recalcMaxHp() e `cannon_slots`
// por calcMaxCannons() — os dois já existiam antes das árvores e mexem em
// estado persistente do jogador, não em uma fórmula de momento. O teste de
// cobertura em __tests__/talent-effects.test.js conhece essa exceção.

'use strict';

// Fora de combate para efeito de talento. O servidor usa 6s (troca de
// dificuldade) e 8s (cura passiva, pet) em lugares diferentes; aqui vale um
// número só para que "em combate" signifique a mesma coisa nos 15 talentos que
// dependem disso.
const OUT_OF_COMBAT_MS = 8000;

// Tetos de sanidade. Com 1200 pontos dá para empilhar bem mais do que o jogo
// aguenta: sem teto a redução de dano passa de 100% e o alvo vira imortal.
const MAX_DR          = 0.85;
const MAX_DODGE       = 0.60;
const MAX_CRIT_CHANCE = 0.95;
const MAX_SLOW_RESIST  = 0.90;

// Janelas dos bônus temporários (ms).
const BURST_MS      = 3000;   // atk_arrancada
const KILL_SPEED_MS = 5000;   // atk_ventania
const RELIC_SPEED_MS = 4000;  // atk_impulsoarcano
const SENTINEL_MS   = 5000;   // def_sentinela
const SECOND_WIND_CD_MS = 60000; // def_segundofolego
const SLOW_ON_HIT_MS    = 2000;  // atk_miralonga (Rasga-Velame)

// Limites de acúmulo.
const FRENZY_MAX_STACKS   = 5;   // atk_frenesi
const KILLSTREAK_MAX      = 3;   // atk_carnificina
const SENTINEL_MAX_STACKS = 5;   // def_sentinela

// ── Acesso cru ───────────────────────────────────────────────────────────────

/** Total do stat em pontos percentuais → fração (20 → 0.20). */
function _p(player, key) {
  return ((player && player.tal && player.tal[key]) || 0) / 100;
}

/** Total do stat na unidade bruta (flat). */
function _f(player, key) {
  return (player && player.tal && player.tal[key]) || 0;
}

function _clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

/**
 * Igual a `_p`, mas anota no coletor que ESTE talento realmente contribuiu.
 *
 * A barra de status da HUD precisa saber quais talentos estão valendo agora, e
 * a condição de cada um já mora aqui dentro (`if (ctx.targetIsBoss) …`). Reler
 * essas condições num segundo módulo criaria duas cópias que divergem no
 * primeiro rebalanceamento — então quem sabe a resposta é quem já a calcula.
 *
 * `procs` é opcional: sem ele nada é coletado e o custo é uma comparação.
 * Ver utils/talent-status.js, o único consumidor.
 */
function _pc(player, key, procs) {
  const v = _p(player, key);
  if (v !== 0 && procs) procs.push(key);
  return v;
}

/** Está em combate agora? */
function inCombat(player, now = Date.now()) {
  return (now - ((player && player.lastCombatTime) || 0)) < OUT_OF_COMBAT_MS;
}

// ── Dano CAUSADO ─────────────────────────────────────────────────────────────

/**
 * Multiplicador único de dano do atacante, já com tudo que depende do contexto.
 * Substitui o antigo `1 + talentDamageBonus`, que só cobria damage_pct.
 *
 * @param {object} attacker
 * @param {object} ctx
 * @param {boolean} [ctx.targetIsPlayer]
 * @param {boolean} [ctx.targetIsNPC]
 * @param {boolean} [ctx.targetIsBoss]
 * @param {number}  [ctx.targetHpFrac]   0..1 — abaixo de 0,30 liga o execute
 * @param {boolean} [ctx.targetHasCC]    lento ou atordoado
 * @param {number}  [ctx.dist]           distância até o alvo (unidades)
 * @param {boolean} [ctx.isFirstHit]     primeiro acerto neste alvo (emboscada)
 * @param {number}  [ctx.attackerHpFrac] 0..1
 * @param {boolean} [ctx.isFullSalvo]    disparou a bordada inteira
 * @param {boolean} [ctx.isSpecialAmmo]  munição diferente da bala de ferro
 * @param {boolean} [ctx.isRam]          dano de colisão
 * @param {boolean} [ctx.isAoe]          dano em área de relíquia
 * @returns {number} multiplicador (1.0 = sem bônus)
 */
function outgoingDamageMult(attacker, ctx = {}, procs = null) {
  if (!attacker || !attacker.tal) return 1.0;

  let add = _p(attacker, 'damage_pct') + _p(attacker, 'damage_final_pct');

  if (ctx.targetIsNPC)    add += _pc(attacker, 'damage_vs_npc_pct', procs);
  if (ctx.targetIsPlayer) add += _pc(attacker, 'damage_vs_player_pct', procs);
  if (ctx.targetIsBoss)   add += _pc(attacker, 'damage_vs_boss_pct', procs);
  if (ctx.targetHasCC)    add += _pc(attacker, 'damage_vs_cc_pct', procs);
  if (ctx.isFirstHit)     add += _pc(attacker, 'opener_pct', procs);
  if (ctx.isFullSalvo)    add += _pc(attacker, 'salvo_damage_pct', procs);
  if (ctx.isSpecialAmmo)  add += _pc(attacker, 'ammo_damage_pct', procs);
  if (ctx.isRam)          add += _pc(attacker, 'ram_damage_pct', procs);
  if (ctx.isAoe)          add += _pc(attacker, 'aoe_damage_pct', procs);

  if (typeof ctx.targetHpFrac === 'number' && ctx.targetHpFrac <= 0.30) {
    add += _pc(attacker, 'execute_pct', procs);
  }
  if (typeof ctx.attackerHpFrac === 'number' && ctx.attackerHpFrac <= 0.30) {
    add += _pc(attacker, 'damage_low_hp_pct', procs);
  }
  if (typeof ctx.dist === 'number' && ctx.dist <= 100) {
    add += _pc(attacker, 'damage_close_pct', procs);
  }

  // Fúria do Kraken: só a metade boa entra aqui (a penalidade de redução mora
  // em incomingDamage).
  add += _p(attacker, 'kraken_fury_pct');

  // Acúmulos que duram enquanto o combate durar.
  add += _p(attacker, 'frenzy_pct')     * (attacker._frenzyStacks     || 0);
  add += _p(attacker, 'killstreak_pct') * (attacker._killstreakStacks || 0);

  return Math.max(0.05, 1 + add);
}

/** Fração da defesa do alvo que o atacante ignora (atk_perfurante). */
function armorPen(attacker) {
  return _clamp(_p(attacker, 'armor_pen_pct'), 0, 0.95);
}

// ── Crítico ──────────────────────────────────────────────────────────────────

/** Chance de crítico do canhão, somando o talento e a corrente da Cascata. */
function critChance(attacker, base = 0) {
  if (!attacker || !attacker.tal) return base;
  const chain = attacker._critChainBonus || 0;
  return _clamp(base + _p(attacker, 'crit_chance') + chain, 0, MAX_CRIT_CHANCE);
}

/** Multiplicador do crítico (base do canhão + talentos). */
function critMult(attacker, base = 1.5, attackerHpFrac = 1, procs = null) {
  if (!attacker || !attacker.tal) return base;
  let add = _pc(attacker, 'crit_damage_pct', procs);
  if (attackerHpFrac > 0.80) add += _pc(attacker, 'crit_damage_high_hp', procs);
  return base + add;
}

/**
 * Registra o resultado de um sorteio de crítico para a Cascata (atk_cascata):
 * um crítico aumenta a chance do PRÓXIMO tiro; o tiro seguinte consome o bônus.
 */
function noteCritRoll(attacker, wasCrit) {
  if (!attacker || !attacker.tal) return;
  attacker._critChainBonus = wasCrit ? _p(attacker, 'crit_chain_pct') : 0;
}

/** Chance de o projétil atravessar e pegar um segundo alvo (atk_balacorrente). */
function pierceChance(attacker) {
  return _clamp(_p(attacker, 'pierce_chance'), 0, 1);
}

/** Chance de uma segunda salva de graça (atk_tiroduplo). */
function doubleShotChance(attacker) {
  return _clamp(_p(attacker, 'double_shot_chance'), 0, 1);
}

/**
 * DoT de Óleo Incendiário (atk_incendiario): fração do golpe por tique, 3s.
 * Devolve null quando o jogador não tem o talento.
 */
function burnDot(attacker, dmg) {
  const pct = _p(attacker, 'burn_pct');
  if (pct <= 0 || dmg <= 0) return null;
  return { dmg: Math.max(1, Math.round(dmg * pct)), tick: 1000, dur: 3000, effect: 'fire' };
}

// ── Dano RECEBIDO ────────────────────────────────────────────────────────────

/**
 * Redução total de dano do alvo, 0..MAX_DR, já descontada a perfuração do
 * atacante.
 *
 * @param {object} target
 * @param {object} ctx
 * @param {boolean} [ctx.fromNPC]
 * @param {boolean} [ctx.fromPlayer]
 * @param {boolean} [ctx.isAoe]
 * @param {boolean} [ctx.isRelic]
 * @param {boolean} [ctx.isCrit]
 * @param {boolean} [ctx.isDot]
 * @param {boolean} [ctx.isStill]    alvo parado
 * @param {number}  [ctx.allyCount]  aliados do grupo por perto
 * @param {boolean} [ctx.inParty]
 * @param {number}  [ctx.pen]        perfuração do atacante (0..1)
 */
function damageReduction(target, ctx = {}, procs = null) {
  if (!target || !target.tal) return 0;

  let dr = _p(target, 'damage_reduction_pct') + _p(target, 'damage_reduction_pct_2');

  if (ctx.fromNPC)    dr += _pc(target, 'reduction_vs_npc_pct', procs);
  if (ctx.fromPlayer) dr += _pc(target, 'reduction_vs_player_pct', procs);
  if (ctx.isAoe)      dr += _pc(target, 'reduction_aoe_pct', procs);
  if (ctx.isRelic)    dr += _pc(target, 'reduction_relic_pct', procs);
  if (ctx.isCrit)     dr += _pc(target, 'crit_taken_reduction', procs);
  if (ctx.isDot)      dr += _pc(target, 'dot_reduction_pct', procs);
  if (ctx.isStill)    dr += _pc(target, 'reduction_still_pct', procs);

  if (ctx.inParty) dr += _pc(target, 'reduction_per_ally_pct', procs) * (ctx.allyCount || 0);
  else             dr += _pc(target, 'reduction_solo_pct', procs);

  // Coração do Abismo: a metade de redução é 1/3 do total declarado (+3% vida
  // por nível, +1% de redução).
  dr += _p(target, 'abyssal_heart_pct') / 3;

  // Sentinela: cada golpe recebido nos últimos 5s soma uma pilha.
  dr += _p(target, 'reduction_after_hit_pct') * (target._sentinelStacks || 0);

  dr = _clamp(dr, -2.0, MAX_DR);

  // Fúria do Kraken cobra 1,2 ponto de redução por nível (0,4 do total
  // declarado, que é +3% de dano) — DEPOIS do teto, de propósito.
  //
  // Cobrando antes, a penalidade sumia para quem mais tinha como pagá-la: um
  // build de anel 5 em Defesa soma ~140% de redução crua, o teto corta em 85%, e
  // os 20 pontos do Kraken cabiam inteiros nos 55 de folga. O resultado era +50%
  // de dano de graça exatamente para o tanque — o oposto da troca que o texto
  // promete. Depois do teto, os 20 pontos sempre doem.
  dr = Math.max(-2.0, dr - _p(target, 'kraken_fury_pct') * 0.4);
  if (ctx.pen > 0 && dr > 0) dr *= (1 - _clamp(ctx.pen, 0, 0.95));
  return dr;
}

/**
 * Corte PLANO da Carapaça de Kraken, em pontos de vida.
 *
 * O talento declara uma fração da vida MÁXIMA de quem apanha, não um número
 * fixo: assim o mesmo nó vale a mesma coisa no barco de 200 e no de 70k, e
 * continua valendo quando o mapa seguinte dobrar o dano de todo mundo. Ver a
 * nota em constants/talents.js.
 */
function flatReduction(target) {
  if (!target || !target.tal || !target.maxHp) return 0;
  return target.maxHp * _p(target, 'flat_reduction_pct');
}

/**
 * Aplica redução percentual + redução plana (def_carapaca) a um golpe.
 * @returns {number} dano final, nunca abaixo de 1 se o golpe original era > 0
 */
function applyDamageReduction(target, dmg, ctx = {}) {
  if (dmg <= 0) return dmg;
  const dr = damageReduction(target, ctx);
  return Math.max(1, Math.round(dmg * (1 - dr) - flatReduction(target)));
}

/** Chance de desviar totalmente de um tiro (def_esquiva + def_alvodificil + vento). */
function dodgeChance(target, isMoving = false, procs = null) {
  if (!target || !target.tal) return 0;
  let c = _p(target, 'dodge_chance');
  if (isMoving) c += _pc(target, 'dodge_moving_chance', procs);
  // Espírito do Vento: +1% de esquiva por nível = metade do total declarado.
  c += _p(target, 'wind_spirit_pct') / 2;
  return _clamp(c, 0, MAX_DODGE);
}

/** Dano devolvido ao atacante (def_espinhos). */
function thornsDamage(target, dmgTaken) {
  const pct = _p(target, 'thorns_pct');
  return pct > 0 ? Math.round(dmgTaken * pct) : 0;
}

/** Vida roubada pelo atacante (def_sanguessuga). */
function lifestealAmount(attacker, dmgDealt) {
  const pct = _p(attacker, 'lifesteal_pct');
  return pct > 0 ? Math.round(dmgDealt * pct) : 0;
}

/**
 * Mana ganha ao levar um golpe (def_absorcao) — valor PLANO, independente do
 * tamanho do golpe.
 *
 * Era fração do dano, e nessa forma o talento nunca teve significado: a barra
 * de mana tem ~20 pontos e um golpe tira dezenas de milhares, então qualquer
 * percentagem enchia tudo. Ver a nota em constants/talents.js.
 */
function manaOnHit(target) {
  return _f(target, 'mana_on_hit_flat');
}

/** Chance de sobreviver a um golpe fatal com 1 de vida (def_teimosia). */
function deathSaveChance(target) {
  return _clamp(_p(target, 'death_save_chance'), 0, 1);
}

/**
 * Segundo Fôlego (def_segundofolego): cura ao cruzar 25% de vida, 1× por minuto.
 * @returns {number} quanto curar (0 = não dispara agora)
 */
function secondWindHeal(target, now = Date.now()) {
  const pct = _p(target, 'second_wind_pct');
  if (pct <= 0 || !target.maxHp) return 0;
  if (target.hp <= 0 || target.hp > target.maxHp * 0.25) return 0;
  if (now - (target._secondWindAt || 0) < SECOND_WIND_CD_MS) return 0;
  target._secondWindAt = now;
  return Math.round(target.maxHp * pct);
}

// ── Vida, cura e regeneração ─────────────────────────────────────────────────

/** Bônus percentual de vida máxima sobre o HP BASE do navio (def_reforcado + abismo). */
function maxHpPctBonus(player) {
  return _p(player, 'max_hp_pct') + _p(player, 'abyssal_heart_pct');
}

/** Multiplicador de cura recebida (def_recuperacao). */
function healingReceivedMult(player) {
  return 1 + _p(player, 'healing_received_pct');
}

/**
 * Vida regenerada por segundo, somando as três fontes contextuais.
 * def_calafate é flat; def_bombeamento só abaixo de 40%; def_reparo só fora
 * de combate — e os dois últimos são percentuais da vida máxima.
 */
function hpRegenPerSec(player, now = Date.now(), procs = null) {
  if (!player || !player.tal || !player.maxHp) return 0;
  let regen = _f(player, 'hp_regen_flat');
  const frac = player.hp / player.maxHp;
  if (frac < 0.40) regen += player.maxHp * _pc(player, 'hp_regen_low_pct', procs);
  if (!inCombat(player, now)) regen += player.maxHp * _pc(player, 'repair_out_combat_pct', procs);
  return regen;
}

// ── Mana ─────────────────────────────────────────────────────────────────────

/** Mana máxima extra (res_reservatorio). */
function maxManaBonus(player) {
  return _f(player, 'max_mana_flat');
}

/** Multiplicador da regeneração de mana, com o bônus de fora de combate. */
function manaRegenMult(player, now = Date.now(), procs = null) {
  let m = 1 + _p(player, 'mana_regen_pct');
  if (!inCombat(player, now)) m += _pc(player, 'mana_out_combat_pct', procs);
  return m;
}

/** Mana ganha por abate (res_colheita). */
function manaOnKill(player) {
  return _f(player, 'mana_on_kill');
}

// ── Relíquias ────────────────────────────────────────────────────────────────

/** Multiplicador do dano de relíquia (atk_focoarcano + atk_sobrecarga). */
function relicDamageMult(player) {
  return 1 + _p(player, 'relic_damage_pct') + _p(player, 'relic_overload_pct');
}

/** Chance EXTRA de crítico de relíquia (atk_vidente). */
function relicCritBonus(player) {
  return _p(player, 'relic_crit_chance');
}

/**
 * Custo de mana da relíquia. A Sobrecarga Arcana cobra +1% por nível (1/3 do
 * total declarado) e a Economia Arcana desconta.
 */
function relicManaCostMult(player) {
  const overload = _p(player, 'relic_overload_pct') / 3;
  return Math.max(0.10, 1 + overload - _p(player, 'relic_mana_cost_pct'));
}

/** Multiplicador do tempo de recarga da relíquia (res_ritual). */
function relicCooldownMult(player) {
  return Math.max(0.20, 1 - _p(player, 'relic_cooldown_pct'));
}

/** Multiplicador do tempo de conjuração (atk_conjuracao). */
function relicCastMult(player) {
  return Math.max(0.20, 1 - _p(player, 'relic_cast_pct'));
}

/** Multiplicador do alcance das relíquias (atk_bracolongo). */
function relicRangeMult(player) {
  return 1 + _p(player, 'relic_range_pct');
}

/** Escudo concedido ao usar uma relíquia (def_barreira), em pontos de vida. */
function relicShieldAmount(player) {
  const pct = _p(player, 'shield_on_relic_pct');
  return pct > 0 && player.maxHp ? Math.round(player.maxHp * pct) : 0;
}

// ── Canhão ───────────────────────────────────────────────────────────────────

/** Multiplicador do tempo de recarga do canhão (atk_polvoraseca). */
function reloadMult(player) {
  return Math.max(0.20, 1 - _p(player, 'reload_pct'));
}

/**
 * Rasga-Velame (atk_miralonga): lentidão que cada acerto de canhão gruda no
 * alvo. Devolve a INTENSIDADE em fração (0,10 = −10% de velocidade); a duração
 * é fixa, em SLOW_ON_HIT_MS.
 *
 * Curta de propósito: o nó cheio vale −10%, e é a cadência do canhão que
 * mantém o efeito de pé. Parar de atirar solta o alvo em 2s.
 */
function slowOnHit(player) {
  return _p(player, 'slow_on_hit_pct');
}

// ── Movimento ────────────────────────────────────────────────────────────────

/**
 * Multiplicador de velocidade do navio.
 *
 * @param {object} player
 * @param {object} ctx
 * @param {number}  [ctx.now]
 * @param {boolean} [ctx.withCurrent]   navegando a favor da corrente
 * @param {number}  [ctx.partyBonus]    bônus vindo de aliados (já em fração)
 */
function speedMult(player, ctx = {}, procs = null) {
  if (!player || !player.tal) return 1.0;
  const now = ctx.now || Date.now();
  let add = _p(player, 'speed_pct');

  add += inCombat(player, now) ? _pc(player, 'speed_in_combat_pct', procs)
                               : _pc(player, 'speed_out_combat_pct', procs);

  if (player.maxHp && player.hp / player.maxHp <= 0.30) add += _pc(player, 'speed_low_hp_pct', procs);
  if (now - (player._moveStartedAt || 0) < BURST_MS)    add += _pc(player, 'burst_speed_pct', procs);
  if (now - (player._lastKillAt   || 0) < KILL_SPEED_MS) add += _pc(player, 'speed_on_kill_pct', procs);
  if (now - (player._lastRelicAt  || 0) < RELIC_SPEED_MS) add += _pc(player, 'speed_on_relic_pct', procs);

  // Espírito do Vento: a metade de velocidade é o total declarado (+2%/nível).
  add += _p(player, 'wind_spirit_pct');
  add += ctx.partyBonus || 0;

  return Math.max(0.10, 1 + add);
}

/** Bônus de velocidade que este jogador DOA ao grupo por perto (res_esquadra). */
function partySpeedAura(player) {
  return _p(player, 'party_speed_pct');
}

/** Multiplicador da velocidade de giro (def_leme + atk_deriva em alta). */
function turnRateMult(player, atFullSpeed = false) {
  let add = _p(player, 'turn_speed_pct');
  if (atFullSpeed) add += _p(player, 'turn_while_fast_pct');
  return 1 + add;
}

/** Fração da perda de velocidade em curva que o casco liso evita (def_cascoliso). */
function dragReduction(player) {
  return _clamp(_p(player, 'drag_reduction_pct'), 0, 0.95);
}

/** Multiplicador da aceleração (res_impulso). */
function accelMult(player) {
  return 1 + _p(player, 'accel_pct');
}

/** Multiplicador do tempo de frenagem (def_ancoragem) — menor é mais rápido. */
function stopTimeMult(player) {
  return Math.max(0.20, 1 - _p(player, 'stop_time_pct'));
}

/** Multiplicador da velocidade de ré (def_marchare). */
function reverseSpeedMult(player) {
  return 1 + _p(player, 'reverse_speed_pct');
}

/** Fração da penalidade de velocidade do clima que o jogador ignora (res_ventoproprio). */
function weatherResist(player) {
  return _clamp(_p(player, 'weather_speed_pct'), 0, 1);
}

// ── Controle de grupo ────────────────────────────────────────────────────────

/** Multiplicador da DURAÇÃO de atordoamento/lentidão sofridos (def_vontade). */
function ccDurationMult(player) {
  return Math.max(0.10, 1 - _p(player, 'cc_resist_pct'));
}

/** Multiplicador da INTENSIDADE das lentidões sofridas (def_escorregadio). */
function slowStrengthMult(player) {
  return Math.max(1 - MAX_SLOW_RESIST, 1 - _p(player, 'slow_resist_pct'));
}

/** Lentidão aplicada em quem navega no rastro deste jogador (atk_rastro). */
function wakeSlow(player) {
  return _clamp(_p(player, 'slow_pursuers_pct'), 0, 0.75);
}

// ── Espólio e economia ───────────────────────────────────────────────────────

// Tesouro do Abismo soma em ouro, dobrão e XP de uma vez.
const _ABYSSAL = new Set(['gold', 'dobrao', 'xp']);

/**
 * Multiplicador de um tipo de ganho.
 * @param {string} kind gold|dobrao|xp|xp_boss|rare|relic_drop|wreck|fishing|
 *                      mission|bounty|pet_food|party_loot
 */
function lootMult(player, kind) {
  if (!player || !player.tal) return 1.0;
  const KEY = {
    gold:         'gold_drop_pct',
    dobrao:       'dobrao_drop_pct',
    xp:           'xp_drop_pct',
    xp_boss:      'xp_boss_pct',
    rare:         'rare_drop_pct',
    relic_drop:   'relic_drop_pct',
    wreck:        'wreck_loot_pct',
    fishing:      'fishing_yield_pct',
    mission:      'mission_reward_pct',
    bounty:       'bounty_pct',
    pet_food:     'pet_food_pct',
    party_loot:   'party_loot_pct',
  }[kind];
  if (!KEY) return 1.0;

  let add = _p(player, KEY);
  if (_ABYSSAL.has(kind)) add += _p(player, 'abyssal_treasure_pct');
  // XP de chefe recebe também o bônus geral de XP.
  if (kind === 'xp_boss') add += _p(player, 'xp_drop_pct') + _p(player, 'abyssal_treasure_pct');
  return Math.max(0, 1 + add);
}

/** Chance de dobrar o ouro de um espólio (res_veiadeouro). */
function goldDoubleChance(player) {
  return _clamp(_p(player, 'gold_double_chance'), 0, 1);
}

/** Chance de dobrar os dobrões de um espólio (res_cofreduplo). */
function dobraoDoubleChance(player) {
  return _clamp(_p(player, 'dobrao_double_chance'), 0, 1);
}

/** Multiplicador do preço nas lojas (res_negociante). */
function shopPriceMult(player) {
  return Math.max(0.30, 1 - _p(player, 'shop_discount_pct'));
}

/** Multiplicador da penalidade de morte (res_seguro). */
function deathPenaltyMult(player) {
  return Math.max(0, 1 - _p(player, 'death_penalty_pct'));
}

/** Espaços extras de porão (res_porao). */
function inventorySlotBonus(player) {
  return _f(player, 'inventory_slots');
}

// ── Piratas e espólio ────────────────────────────────────────────────────────
// Os oito nós de tripulação do anel 2 ao 5 da árvore de Recurso. Quem consome:
// PirateManager (porão e RUN), SpoilManager (abordagem e saque) e o handler de
// compra de pirata (preço).

/**
 * Capacidade EXTRA de porão para piratas (res_alistamento + res_capitania).
 *
 * O flat entra direto e o percentual incide sobre a capacidade BASE do navio,
 * que o PirateManager passa em `baseCapacity`. Fazer o percentual incidir sobre
 * o total já somado faria os dois talentos se multiplicarem — e o texto de cada
 * um promete somar.
 */
function pirateCapacityBonus(player, baseCapacity = 0) {
  return Math.floor(_f(player, 'pirate_capacity_flat')
                  + baseCapacity * _p(player, 'pirate_capacity_pct'));
}

/**
 * Força a MAIS na ofensiva dos piratas do jogador ao abordar
 * (res_abordagem + a metade ofensiva do res_almirante).
 */
function pirateBattlePowerPct(player) {
  return _p(player, 'pirate_power_pct') + _p(player, 'pirate_command_pct');
}

/**
 * Defesa a MAIS dos piratas do jogador quando o espólio DELE é abordado
 * (res_muralha). Lido no momento da criação do espólio: é o capitão que
 * afundou quem paga por ter treinado a tripulação, não quem vai abordar.
 */
function pirateDefensePct(player) {
  return _p(player, 'pirate_defense_pct');
}

/**
 * Quanto as baixas do jogador encolhem na abordagem (res_disciplina).
 * Teto em 80%: uma tripulação imortal esvaziaria o risco da zona Red.
 */
function pirateCasualtyReductionPct(player) {
  return _clamp(_p(player, 'pirate_casualty_pct'), 0, 0.80);
}

/**
 * Multiplicador do consumo de RUN (res_destilaria). Piso em 25% — a tripulação
 * nunca bebe de graça.
 */
function runUpkeepMult(player) {
  return Math.max(0.25, 1 - _p(player, 'run_upkeep_pct'));
}

/**
 * Fração a MAIS saqueada de um espólio
 * (res_saqueador + a metade de saque do res_almirante).
 */
function spoilLootPct(player) {
  return _p(player, 'wreck_loot_pct') + _p(player, 'pirate_command_pct');
}

/** Multiplicador do preço de contratar um pirata (res_recrutador). */
function piratePriceMult(player) {
  return Math.max(0.30, 1 - _p(player, 'pirate_price_pct'));
}

// ── Diversos ─────────────────────────────────────────────────────────────────

/** Multiplicador do tempo de renascimento (def_retorno). */
function respawnTimeMult(player) {
  return Math.max(0.20, 1 - _p(player, 'respawn_time_pct'));
}

/** Milissegundos EXTRA de invulnerabilidade após renascer (def_tregua). */
function respawnImmunityBonus(player) {
  return _f(player, 'respawn_immunity_ms');
}

/** Multiplicador do alcance de visão (res_nevoa / res_noturno). */
function visionMult(player, kind) {
  if (kind === 'fog')   return 1 + _p(player, 'fog_vision_pct');
  if (kind === 'night') return 1 + _p(player, 'night_vision_pct');
  return 1.0;
}

/** Multiplicador do alcance em que as criaturas percebem o jogador (def_sombra). */
function stealthRangeMult(player) {
  return Math.max(0.20, 1 - _p(player, 'stealth_range_pct'));
}

/** Multiplicador da recarga das passagens antigas (res_passagem). */
function archCooldownMult(player) {
  return Math.max(0.10, 1 - _p(player, 'arch_cooldown_pct'));
}

/** Multiplicador da recarga do impulso/dash (atk_bordolivre). */
function dashCooldownMult(player) {
  return Math.max(0.10, 1 - _p(player, 'dash_cooldown_pct'));
}

// ── Estado de combate (os acúmulos) ──────────────────────────────────────────
//
// Frenesi e Carnificina acumulam ENQUANTO O COMBATE DURAR — não têm relógio
// próprio. Quem zera as duas é `tickCombatState`, quando o jogador sai de
// combate. Sentinela tem janela própria de 5s porque o texto dela promete isso.

/** Um acerto do jogador: soma pilha de Frenesi. */
function onHitDealt(player) {
  if (!player || !player.tal) return;
  if (_p(player, 'frenzy_pct') <= 0) return;
  player._frenzyStacks = Math.min(FRENZY_MAX_STACKS, (player._frenzyStacks || 0) + 1);
}

/** Um abate do jogador: soma pilha de Carnificina e marca a Ventania. */
function onKill(player, now = Date.now()) {
  if (!player || !player.tal) return;
  player._lastKillAt = now;
  if (_p(player, 'killstreak_pct') > 0) {
    player._killstreakStacks = Math.min(KILLSTREAK_MAX, (player._killstreakStacks || 0) + 1);
  }
}

/** Um golpe recebido: soma pilha de Sentinela (janela própria de 5s). */
function onHitTaken(player, now = Date.now()) {
  if (!player || !player.tal) return;
  if (_p(player, 'reduction_after_hit_pct') <= 0) return;
  player._sentinelStacks = Math.min(SENTINEL_MAX_STACKS, (player._sentinelStacks || 0) + 1);
  player._sentinelUntil  = now + SENTINEL_MS;
}

/** Uso de relíquia: marca o Impulso Arcano. */
function onRelicUsed(player, now = Date.now()) {
  if (player) player._lastRelicAt = now;
}

/** Saiu da imobilidade: marca a janela da Arrancada. */
function onMoveStart(player, now = Date.now()) {
  if (player) player._moveStartedAt = now;
}

/**
 * Chamado no tique do jogo. Expira o que tem relógio e zera o que depende de
 * estar em combate.
 */
function tickCombatState(player, now = Date.now()) {
  if (!player) return;
  if (player._sentinelStacks && now >= (player._sentinelUntil || 0)) {
    player._sentinelStacks = 0;
  }
  if (!inCombat(player, now)) {
    if (player._frenzyStacks)     player._frenzyStacks = 0;
    if (player._killstreakStacks) player._killstreakStacks = 0;
    if (player._openerHit)        player._openerHit = null;
    if (player._critChainBonus)   player._critChainBonus = 0;
  }
}

/**
 * Emboscada (atk_emboscada): é o PRIMEIRO acerto neste alvo no combate atual?
 * Marca o alvo como já atingido e devolve true uma única vez.
 */
function consumeOpener(player, targetId) {
  if (!player || !player.tal || _p(player, 'opener_pct') <= 0) return false;
  if (!player._openerHit) player._openerHit = new Set();
  if (player._openerHit.has(targetId)) return false;
  player._openerHit.add(targetId);
  return true;
}

module.exports = {
  // constantes úteis para quem consome
  OUT_OF_COMBAT_MS, MAX_DR, MAX_DODGE, FRENZY_MAX_STACKS, KILLSTREAK_MAX,
  SENTINEL_MAX_STACKS, SECOND_WIND_CD_MS, SLOW_ON_HIT_MS,
  BURST_MS, KILL_SPEED_MS, RELIC_SPEED_MS, SENTINEL_MS,
  inCombat,
  // dano causado
  outgoingDamageMult, armorPen, critChance, critMult, noteCritRoll,
  pierceChance, doubleShotChance, burnDot,
  // dano recebido
  damageReduction, applyDamageReduction, dodgeChance, thornsDamage,
  lifestealAmount, manaOnHit, deathSaveChance, secondWindHeal, flatReduction,
  // vida e mana
  maxHpPctBonus, healingReceivedMult, hpRegenPerSec,
  maxManaBonus, manaRegenMult, manaOnKill,
  // relíquias e canhão
  relicDamageMult, relicCritBonus, relicManaCostMult, relicCooldownMult,
  relicCastMult, relicRangeMult, relicShieldAmount, reloadMult,
  // movimento
  speedMult, partySpeedAura, turnRateMult, dragReduction, accelMult,
  stopTimeMult, reverseSpeedMult, weatherResist,
  // CC
  ccDurationMult, slowStrengthMult, wakeSlow, slowOnHit,
  // economia
  lootMult, goldDoubleChance, dobraoDoubleChance, shopPriceMult,
  deathPenaltyMult, inventorySlotBonus,
  // piratas e espólio
  pirateCapacityBonus, pirateBattlePowerPct, pirateDefensePct,
  pirateCasualtyReductionPct, runUpkeepMult, spoilLootPct, piratePriceMult,
  // diversos
  respawnTimeMult, respawnImmunityBonus, visionMult, stealthRangeMult,
  archCooldownMult, dashCooldownMult,
  // estado
  onHitDealt, onKill, onHitTaken, onRelicUsed, onMoveStart,
  tickCombatState, consumeOpener,
};
