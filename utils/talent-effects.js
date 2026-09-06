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

// ── Sequência de acertos (atk_rastro + atk_bordolivre) ───────────────────────
// Os dois talentos leem a MESMA pilha (`player._streakStacks`): a sequência é
// uma só, o que muda é o que cada nó faz com ela. O `perLevel` dos dois é o
// TETO de pilhas (2 por nível); o valor de cada pilha é fixo e mora aqui.
//
// Fixo de propósito: se a pilha valesse também por nível, o nó cheio daria
// 20% × 20 pilhas = +400% de dano. Com o valor fixo, o teto é +40% — alto,
// mas do tamanho de um capstone, e só para quem encadeia 20 acertos sem errar.
const STREAK_PCT_PER_STACK = 0.02;
// Errar zera a sequência. É o que amarra estes dois no Pulso Firme (precisão):
// com 50% de mira, chegar a 20 pilhas é loteria; com 80%, é rotina.
const BLOCK_MAX = 0.50;

// Escudos (absorção de dano de verdade, não cura disfarçada).
const RELIC_SHIELD_MS     = 8000;   // def_barreira
const LOW_HP_SHIELD_MS    = 10000;  // def_cascoliso
const LOW_HP_SHIELD_CD_MS = 20000;  // piso entre dois disparos do Casco Duplo
const LOW_HP_SHIELD_AT    = 0.20;   // a vida que precisa ser cruzada para baixo

// Fração da vida com que se renasce sem nenhum talento (server.js usa a mesma).
const RESPAWN_HP_BASE = 0.10;

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

  // Cadência Mortal: a sequência de acertos, limitada pelo teto do próprio nó.
  const streakDmg = streakStacks(attacker, 'streak_damage_stacks');
  if (streakDmg > 0) {
    add += STREAK_PCT_PER_STACK * streakDmg;
    if (procs) procs.push('streak_damage_stacks');
  }

  return Math.max(0.05, 1 + add);
}

/**
 * Pilhas de sequência que VALEM para um dos dois nós.
 *
 * A pilha é compartilhada e cresce sem teto no atacante; cada nó só conta até
 * o próprio limite (`perLevel` 2 × nível). Guardar uma pilha por nó faria a
 * Broca Corsária e a Cadência Mortal contarem acertos separados — e o jogador
 * vê UMA sequência na tela.
 */
function streakStacks(player, key) {
  const teto = _f(player, key);
  if (teto <= 0) return 0;
  return Math.min(teto, player._streakStacks || 0);
}

/**
 * Registra o resultado de um tiro para a sequência (atk_rastro/atk_bordolivre).
 * Acertou soma uma pilha; errou zera. Chamado do projectile-manager, no mesmo
 * lugar em que a precisão do canhão é sorteada.
 */
function noteStreakShot(player, acertou) {
  if (!player) return;
  player._streakStacks = acertou ? (player._streakStacks || 0) + 1 : 0;
}

/**
 * Fração da defesa do alvo que o atacante ignora.
 *
 * Três fontes, todas aditivas: Bala Perfurante (`armor_pen_pct`), Ponta de Aço
 * (`armor_pen_pct_2`) e a sequência da Broca Corsária.
 */
function armorPen(attacker) {
  let pen = _p(attacker, 'armor_pen_pct') + _p(attacker, 'armor_pen_pct_2');
  pen += STREAK_PCT_PER_STACK * streakStacks(attacker, 'streak_pen_stacks');
  return _clamp(pen, 0, 0.95);
}

/**
 * Pontos percentuais de PRECISÃO que o talento soma ao canhão (atk_deriva).
 *
 * Em fração, para somar direto no `cannonAccuracy`. O teto do canhão mais a
 * pesquisa continua sendo o CANNON_ACCURACY_MAX (0,70) e este bônus entra
 * DEPOIS dele — quem já pesquisou a Mira Calibrada precisa ver o nó fazer
 * alguma coisa. O teto final é do recalcCannons (0,95).
 */
function cannonAccuracyBonus(player) {
  return _p(player, 'cannon_accuracy_pct');
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
 * @param {boolean} [ctx.fromTower]    torre de ilha (def_ancoragem)
 * @param {boolean} [ctx.fromNpcShip]  NPC que atira de canhão (def_marchare)
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

  if (ctx.fromNPC)     dr += _pc(target, 'reduction_vs_npc_pct', procs);
  if (ctx.fromPlayer)  dr += _pc(target, 'reduction_vs_player_pct', procs);
  if (ctx.fromTower)   dr += _pc(target, 'reduction_vs_tower_pct', procs);
  if (ctx.fromNpcShip) dr += _pc(target, 'reduction_vs_npc_ship_pct', procs);
  if (ctx.isRelic)     dr += _pc(target, 'reduction_relic_pct', procs);
  if (ctx.isCrit)     dr += _pc(target, 'crit_taken_reduction', procs);
  if (ctx.isDot)      dr += _pc(target, 'dot_reduction_pct', procs);
  if (ctx.isStill)    dr += _pc(target, 'reduction_still_pct', procs);

  if (ctx.inParty) dr += _pc(target, 'reduction_per_ally_pct', procs) * (ctx.allyCount || 0);
  else             dr += _pc(target, 'reduction_solo_pct', procs);

  // Coração do Abismo: o `perLevel` do talento é o bônus de VIDA (+3%/nível); a
  // redução sai dividindo. Era /3 (+1%/nível, 10% no talento cheio) e passou a
  // /6 para caber no teto de 5% por talento — mexer no perLevel teria levado o
  // bônus de vida junto, que não é o que se quis cortar.
  dr += _p(target, 'abyssal_heart_pct') / 6;

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

/**
 * Chance de BLOQUEAR o golpe inteiro (def_anteparo).
 *
 * Anulação, como a esquiva — e sorteada depois dela, com aviso próprio, para
 * o jogador conseguir dizer qual das duas o salvou. O teto de 50% é só
 * sanidade: o nó cheio vale 5%.
 */
function blockChance(target) {
  if (!target || !target.tal) return 0;
  return _clamp(_p(target, 'block_chance'), 0, BLOCK_MAX);
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

/**
 * Multiplicador de TODA cura recebida — curandeiro, bala de cura, relíquia,
 * Segundo Fôlego, regeneração.
 *
 * Três nós na mesma família, aditivos: Calafate (`_2`, sempre), Recuperação
 * (sempre) e Reparos de Emergência (só fora de combate). Os três eram outra
 * coisa até 09/2026 — regeneração plana e regeneração fora de combate — e
 * viraram multiplicador por decisão do Luang: a regeneração envelhecia (0,4 de
 * vida por segundo não se percebe num casco de 70k) e nada na árvore
 * valorizava quem investia em cura.
 */
function healingReceivedMult(player, now = Date.now(), procs = null) {
  if (!player || !player.tal) return 1;
  let add = _p(player, 'healing_received_pct') + _p(player, 'healing_received_pct_2');
  if (!inCombat(player, now)) add += _pc(player, 'healing_out_combat_pct', procs);
  return 1 + add;
}

/**
 * Vida regenerada por segundo.
 *
 * Sobrou UMA fonte: as Bombas de Porão, abaixo de 40% de vida. O Calafate
 * (regen plana) e os Reparos de Emergência (regen fora de combate) viraram
 * multiplicadores de cura — o jogo perdeu de propósito a regeneração passiva
 * acima de 40%, que era a moeda de troca da mudança.
 */
function hpRegenPerSec(player, now = Date.now(), procs = null) {
  if (!player || !player.tal || !player.maxHp) return 0;
  const frac = player.hp / player.maxHp;
  if (frac >= 0.40) return 0;
  return player.maxHp * _pc(player, 'hp_regen_low_pct', procs);
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

/**
 * Escudo concedido ao usar uma relíquia (def_barreira), em pontos de vida.
 *
 * ⚠️ Até 09/2026 o server.js somava isto direto no `hp`: era CURA, não escudo.
 * Quem estava com a vida cheia não ganhava nada, nada aparecia na tela e o
 * playtest resumiu em "nem percebi esse escudo". Hoje o valor vai para
 * `player.shield`, que absorve dano antes da vida e vence em RELIC_SHIELD_MS.
 */
function relicShieldAmount(player) {
  const pct = _p(player, 'shield_on_relic_pct');
  return pct > 0 && player.maxHp ? Math.round(player.maxHp * pct) : 0;
}

/**
 * Casco Duplo (def_cascoliso): escudo ao CRUZAR 20% de vida para baixo.
 *
 * Rearma quando a vida volta acima do limiar (`_lowShieldArmed`) e ainda tem um
 * piso de tempo, senão quem fica oscilando em torno de 20% ganharia escudo
 * infinito. Mesma forma do Segundo Fôlego, que já resolvia este problema.
 *
 * @returns {number} quanto de escudo erguer (0 = não dispara agora)
 */
function lowHpShieldAmount(target, now = Date.now()) {
  const pct = _p(target, 'low_hp_shield_pct');
  if (pct <= 0 || !target.maxHp || target.hp <= 0) return 0;
  const frac = target.hp / target.maxHp;
  if (frac > LOW_HP_SHIELD_AT) { target._lowShieldArmed = true; return 0; }
  if (target._lowShieldArmed === false) return 0;
  if (now - (target._lowShieldAt || 0) < LOW_HP_SHIELD_CD_MS) return 0;
  target._lowShieldArmed = false;
  target._lowShieldAt    = now;
  return Math.round(target.maxHp * pct);
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

/**
 * Multiplicador da velocidade de giro (def_leme).
 *
 * O `atFullSpeed` sobrou do atk_deriva, que somava manobra em velocidade
 * máxima e virou precisão de canhão. Ficou no argumento porque o
 * player-manager já sabe calcular a condição e um talento futuro pode querer
 * de novo — hoje ele não muda nada.
 */
function turnRateMult(player, _atFullSpeed = false) {
  return 1 + _p(player, 'turn_speed_pct');
}

// Saíram daqui quatro funções cujos talentos trocaram de função em 09/2026:
// dragReduction (def_cascoliso → escudo), accelMult (res_impulso → XP de pet),
// stopTimeMult (def_ancoragem → dano de torre) e reverseSpeedMult
// (def_marchare → dano de navio NPC). Junto foi a weatherResist, que nunca teve
// talento nem consumidor. O player-manager passou a usar as constantes cruas.

// ── Controle de grupo ────────────────────────────────────────────────────────

/** Multiplicador da DURAÇÃO de atordoamento/lentidão sofridos (def_vontade). */
function ccDurationMult(player) {
  return Math.max(0.10, 1 - _p(player, 'cc_resist_pct'));
}

/** Multiplicador da INTENSIDADE das lentidões sofridas (def_escorregadio). */
function slowStrengthMult(player) {
  return Math.max(1 - MAX_SLOW_RESIST, 1 - _p(player, 'slow_resist_pct'));
}

// ── Espólio e economia ───────────────────────────────────────────────────────

// Tesouro do Abismo soma em ouro, dobrão e XP de uma vez.
const _ABYSSAL = new Set(['gold', 'dobrao', 'xp']);

/**
 * ── O bônus de espólio da GUILDA saiu daqui (2026-09-06) ─────────────────────
 * Três skills da irmandade (+% de ouro, de dobrão e de XP para todo membro)
 * eram somadas neste funil. Elas foram aposentadas: as skills de guilda
 * passaram a fortalecer a GUILDA — nível, cofre e ilha — em vez de colar número
 * na ficha de quem entrasse numa guilda grande. Ver constants/guilds.js.
 *
 * O que continua chegando aqui é só talento, que é decisão de quem joga.
 */

/**
 * Multiplicador de um tipo de ganho.
 * @param {string} kind gold|dobrao|xp|xp_boss|rare|relic_drop|wreck|fishing|
 *                      mission|bounty|pet_food|party_loot
 */
function lootMult(player, kind) {
  if (!player) return 1.0;
  if (!player.tal) return 1.0;
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

/** Multiplicador do que a Mesa de Exploração devolve (res_colheita). */
function explorationLootMult(player) {
  return Math.max(1, 1 + _p(player, 'exploration_loot_pct'));
}

/** Chance de a Mesa de Exploração render uma rolagem extra (res_porao). */
function explorationDoubleChance(player) {
  return _clamp(_p(player, 'exploration_double_chance'), 0, 1);
}

/** Chance de um fragmento de mapa extra por abate (res_ventoproprio). */
function fragmentExtraChance(player) {
  return _clamp(_p(player, 'fragment_extra_chance'), 0, 1);
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

/** Milissegundos EXTRA de invulnerabilidade após renascer (def_tregua). */
function respawnImmunityBonus(player) {
  return _f(player, 'respawn_immunity_ms');
}

/**
 * Fração da vida máxima com que se renasce (def_retorno).
 *
 * O nó prometia "−3% no tempo de renascimento" e não há tempo de renascimento:
 * o painel de morte tem um botão e o `request_respawn` devolve o jogador na
 * hora. A promessa vizinha — voltar pronto para brigar — tinha onde caber: a
 * fração de vida do renascimento, que era 10% fixos.
 */
function respawnHpFrac(player) {
  return _clamp(RESPAWN_HP_BASE + _p(player, 'respawn_hp_pct'), RESPAWN_HP_BASE, 1);
}

/** Multiplicador do XP que o mascote ganha (res_impulso). */
function petXpMult(player) {
  return Math.max(1, 1 + _p(player, 'pet_xp_pct'));
}

/**
 * Desconto, em MILISSEGUNDOS, na recarga das relíquias do mascote
 * (res_lamparina). Valor plano em vez de percentual porque a recarga do pet já
 * é curta: −5 s no nó cheio se lê igual em toda relíquia, enquanto −50%
 * valeria quase nada nas baratas e demais nas caras.
 */
function petRelicCooldownReduction(player) {
  return Math.max(0, _f(player, 'pet_relic_cooldown_ms'));
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
  STREAK_PCT_PER_STACK, RELIC_SHIELD_MS, LOW_HP_SHIELD_MS, RESPAWN_HP_BASE,
  inCombat,
  // dano causado
  outgoingDamageMult, armorPen, cannonAccuracyBonus, critChance, critMult,
  noteCritRoll, pierceChance, doubleShotChance, burnDot,
  streakStacks, noteStreakShot,
  // dano recebido
  damageReduction, applyDamageReduction, dodgeChance, blockChance, thornsDamage,
  lifestealAmount, manaOnHit, deathSaveChance, secondWindHeal, flatReduction,
  lowHpShieldAmount,
  // vida e mana
  maxHpPctBonus, healingReceivedMult, hpRegenPerSec,
  maxManaBonus, manaRegenMult,
  // relíquias e canhão
  relicDamageMult, relicCritBonus, relicManaCostMult, relicCooldownMult,
  relicCastMult, relicRangeMult, relicShieldAmount, reloadMult,
  // movimento
  speedMult, partySpeedAura, turnRateMult,
  // CC
  ccDurationMult, slowStrengthMult, slowOnHit,
  // economia
  lootMult, goldDoubleChance, dobraoDoubleChance, shopPriceMult,
  deathPenaltyMult, explorationLootMult, explorationDoubleChance,
  fragmentExtraChance,
  // piratas e espólio
  pirateCapacityBonus, pirateBattlePowerPct, pirateDefensePct,
  pirateCasualtyReductionPct, runUpkeepMult, spoilLootPct, piratePriceMult,
  // mascote
  petXpMult, petRelicCooldownReduction,
  // diversos
  respawnImmunityBonus, respawnHpFrac, visionMult, stealthRangeMult,
  archCooldownMult,
  // estado
  onHitDealt, onKill, onHitTaken, onRelicUsed, onMoveStart,
  tickCombatState, consumeOpener,
};
