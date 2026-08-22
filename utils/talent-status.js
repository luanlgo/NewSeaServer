// utils/talent-status.js
// Quais talentos estão VALENDO agora — a fonte da barra de status da HUD.
//
// ── Por que existe ────────────────────────────────────────────────────────────
// Dos 120 talentos, 68 são passivos permanentes (ficariam acesos o tempo todo e
// não informam nada) e 51 dependem de contexto. Estes 51 são os que viram ícone.
// Eles se dividem em dois regimes:
//
//   ESTADO    — 22 talentos que descrevem uma situação em que o jogador ESTÁ:
//               pilhas (Frenesi), janelas (Ventania), recarga (Segundo Fôlego)
//               e condições (vida abaixo de 30%, parado, sem grupo…).
//               Apurados a cada tique, direto do estado do jogador.
//
//   POR GOLPE — 30 talentos que só existem no instante de um acerto (Matador de
//               Colossos, Emboscada, Abordagem…). Sozinhos apareceriam por um
//               quadro e sumiriam, então ficam LINGER_MS na tela depois da
//               última vez que valeram: lê-se "isto acabou de contar".
//
// ── Como sabemos que um talento valeu ─────────────────────────────────────────
// As condições ("se o alvo é chefe", "se a vida está abaixo de 30%") já moram em
// talent-effects.js, dentro das funções que calculam o multiplicador. Reler
// essas condições aqui criaria duas cópias que divergem no primeiro
// rebalanceamento. Em vez disso, aquelas funções aceitam um coletor opcional
// (`procs`) e anotam nele cada termo que realmente contribuiu — aqui só
// traduzimos stat → talento.

'use strict';

const { TALENT_DEFS } = require('../constants/talents');
const fx = require('./talent-effects');

/** Quanto um talento de "por golpe" fica visível depois de valer. */
const LINGER_MS = 3000;

/** Teto de ícones enviados. A HUD quebra em duas linhas; mais que isso é sopa. */
const MAX_STATUS = 24;

// ── Os 51 que podem virar status ─────────────────────────────────────────────
// kind: 'stack' | 'window' | 'cooldown' | 'cond' | 'hit'
// Os três primeiros regimes têm tratamento próprio abaixo; 'cond' e 'hit' saem
// do coletor de procs, e a diferença entre eles é só o LINGER.
const STATUS_STATS = {
  // ── pilhas ──
  frenzy_pct:              'stack',
  killstreak_pct:          'stack',
  reduction_after_hit_pct: 'stack',
  crit_chain_pct:          'stack',
  // ── janelas com relógio ──
  burst_speed_pct:      'window',
  speed_on_kill_pct:    'window',
  speed_on_relic_pct:   'window',
  // ── recarga ──
  second_wind_pct:      'cooldown',
  // ── condições ──
  speed_in_combat_pct:     'cond',
  speed_out_combat_pct:    'cond',
  speed_low_hp_pct:        'cond',
  weather_speed_pct:       'cond',
  crit_damage_high_hp:     'cond',
  damage_low_hp_pct:       'cond',
  repair_out_combat_pct:   'cond',
  hp_regen_low_pct:        'cond',
  mana_out_combat_pct:     'cond',
  reduction_still_pct:     'cond',
  reduction_solo_pct:      'cond',
  reduction_per_ally_pct:  'cond',
  dodge_moving_chance:     'cond',
  // ── por golpe ──
  damage_vs_npc_pct:       'hit',
  damage_vs_player_pct:    'hit',
  damage_vs_boss_pct:      'hit',
  damage_vs_cc_pct:        'hit',
  execute_pct:             'hit',
  opener_pct:              'hit',
  damage_close_pct:        'hit',
  salvo_damage_pct:        'hit',
  ammo_damage_pct:         'hit',
  aoe_damage_pct:          'hit',
  ram_damage_pct:          'hit',
  crit_chance:             'hit',
  crit_damage_pct:         'hit',
  armor_pen_pct:           'hit',
  pierce_chance:           'hit',
  double_shot_chance:      'hit',
  burn_pct:                'hit',
  thorns_pct:              'hit',
  lifesteal_pct:           'hit',
  mana_on_hit_flat:        'hit',
  death_save_chance:       'hit',
  dodge_chance:            'hit',
  relic_crit_chance:       'hit',
  reduction_vs_npc_pct:    'hit',
  reduction_vs_player_pct: 'hit',
  reduction_aoe_pct:       'hit',
  reduction_relic_pct:     'hit',
  dot_reduction_pct:       'hit',
  crit_taken_reduction:    'hit',
  flat_reduction_pct:      'hit',
  slow_on_hit_pct:         'hit',
};

// stat → id do talento. Derivado dos defs: se um talento mudar de stat, o mapa
// acompanha e o teste de cobertura acusa quem ficou órfão.
const ID_BY_STAT = {};
for (const [id, def] of Object.entries(TALENT_DEFS)) {
  if (STATUS_STATS[def.stat]) ID_BY_STAT[def.stat] = id;
}

// ── Registro dos procs ───────────────────────────────────────────────────────

/**
 * Carimba no jogador o instante em que cada stat da lista contribuiu.
 * `procs` é o array preenchido pelas funções de talent-effects.js.
 */
function noteProcs(player, procs, now = Date.now()) {
  if (!player || !procs || procs.length === 0) return;
  let map = player._talProc;
  if (!map) { map = Object.create(null); player._talProc = map; }
  for (const stat of procs) {
    if (STATUS_STATS[stat]) map[stat] = now;
  }
}

/**
 * Atalho para quem tem um efeito DISCRETO, que ou aconteceu ou não: bala de
 * corrente atravessou, esquiva salvou, teimosia segurou o golpe fatal. Esses
 * não passam por um multiplicador, então não têm proc automático.
 */
function noteHit(player, stat, now = Date.now()) {
  if (!player || !STATUS_STATS[stat]) return;
  let map = player._talProc;
  if (!map) { map = Object.create(null); player._talProc = map; }
  map[stat] = now;
}

// ── Apuração ─────────────────────────────────────────────────────────────────

function _lvl(player, stat) {
  return (player && player.tal && player.tal[stat]) || 0;
}

/**
 * Lista dos talentos ativos agora, pronta para ir no fio.
 *
 * @param {object} player
 * @param {object} ctx     mesmo contexto do tique (isStill, inParty, allyCount,
 *                         withCurrent, badWeather, isMoving)
 * @param {number} now
 * @returns {Array<[string, number, number]>} [id, pilhas, msRestantes]
 *          pilhas = 1 quando o talento não acumula; msRestantes = 0 quando não
 *          tem relógio (vale enquanto a condição durar).
 */
function activeStatuses(player, ctx = {}, now = Date.now()) {
  if (!player || !player.tal) return [];

  const out = [];
  const push = (stat, stacks, msLeft) => {
    const id = ID_BY_STAT[stat];
    if (id) out.push([id, stacks || 1, Math.max(0, Math.round(msLeft || 0))]);
  };

  // ── Pilhas ──
  const frenzy = player._frenzyStacks || 0;
  if (frenzy > 0 && _lvl(player, 'frenzy_pct') > 0) push('frenzy_pct', frenzy, 0);

  const streak = player._killstreakStacks || 0;
  if (streak > 0 && _lvl(player, 'killstreak_pct') > 0) push('killstreak_pct', streak, 0);

  const sentinel = player._sentinelStacks || 0;
  if (sentinel > 0) {
    push('reduction_after_hit_pct', sentinel, (player._sentinelUntil || 0) - now);
  }

  if ((player._critChainBonus || 0) > 0) push('crit_chain_pct', 1, 0);

  // ── Recarga: Segundo Fôlego só aparece ENQUANTO está indisponível ──
  if (_lvl(player, 'second_wind_pct') > 0) {
    const readyAt = (player._secondWindAt || 0) + fx.SECOND_WIND_CD_MS;
    if (now < readyAt) push('second_wind_pct', 1, readyAt - now);
  }

  // ── Estado contínuo: quem sabe a condição é quem calcula o efeito ──
  const procs = [];
  fx.speedMult(player, { now, withCurrent: !!ctx.withCurrent }, procs);
  fx.damageReduction(player, {
    isStill:    !!ctx.isStill,
    inParty:    !!ctx.inParty,
    allyCount:  ctx.allyCount || 0,
  }, procs);
  fx.critMult(player, 1.5, _hpFrac(player), procs);
  fx.outgoingDamageMult(player, { attackerHpFrac: _hpFrac(player) }, procs);
  fx.hpRegenPerSec(player, now, procs);
  fx.manaRegenMult(player, now, procs);
  fx.dodgeChance(player, !!ctx.isMoving, procs);

  // Vento Próprio só conta quando existe penalidade de clima para ignorar.
  if (ctx.badWeather && _lvl(player, 'weather_speed_pct') > 0) procs.push('weather_speed_pct');

  const seen = new Set(out.map(e => e[0]));
  for (const stat of procs) {
    const kind = STATUS_STATS[stat];
    // `procs` traz passivos junto (damage_pct e afins) — só os 51 entram, e as
    // janelas/pilhas já foram tratadas acima com o número certo.
    if (kind !== 'cond') continue;
    const id = ID_BY_STAT[stat];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push([id, 1, 0]);
  }

  // ── Janelas com relógio ──
  _window(player, out, seen, 'burst_speed_pct',    player._moveStartedAt, fx.BURST_MS, now);
  _window(player, out, seen, 'speed_on_kill_pct',  player._lastKillAt,    fx.KILL_SPEED_MS, now);
  _window(player, out, seen, 'speed_on_relic_pct', player._lastRelicAt,   fx.RELIC_SPEED_MS, now);

  // ── Por golpe: sobrevivem LINGER_MS depois de valer ──
  const map = player._talProc;
  if (map) {
    for (const stat of Object.keys(map)) {
      if (STATUS_STATS[stat] !== 'hit') continue;
      const left = map[stat] + LINGER_MS - now;
      if (left <= 0) { delete map[stat]; continue; }
      const id = ID_BY_STAT[stat];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push([id, 1, left]);
    }
  }

  // Ordem estável: quem tem relógio primeiro (some sozinho), depois o resto por
  // id. Sem isso os ícones dançariam de lugar a cada broadcast.
  out.sort((a, b) => (b[2] > 0) - (a[2] > 0) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return out.length > MAX_STATUS ? out.slice(0, MAX_STATUS) : out;
}

function _hpFrac(player) {
  return player.maxHp ? player.hp / player.maxHp : 1;
}

function _window(player, out, seen, stat, startedAt, durMs, now) {
  if (_lvl(player, stat) <= 0) return;
  const left = (startedAt || 0) + durMs - now;
  if (left <= 0) return;
  const id = ID_BY_STAT[stat];
  if (!id || seen.has(id)) return;
  seen.add(id);
  out.push([id, 1, Math.round(left)]);
}

/**
 * Assinatura para decidir se vale reenviar.
 *
 * O tempo restante NÃO entra: ele muda a cada tique e o cliente sabe contar
 * sozinho. O que entra é o instante em que a janela ACABA, que só muda quando o
 * efeito é renovado — assim um Frenesi ganhando pilha reenvia, mas um Frenesi
 * parado em 3 pilhas não gasta banda nenhuma.
 */
function signature(list, now = Date.now()) {
  let s = '';
  for (const [id, stacks, ms] of list) {
    s += id + ':' + stacks + ':' + (ms > 0 ? Math.round((now + ms) / 250) : 0) + '|';
  }
  return s;
}

module.exports = {
  LINGER_MS, MAX_STATUS, STATUS_STATS, ID_BY_STAT,
  noteProcs, noteHit, activeStatuses, signature,
};
