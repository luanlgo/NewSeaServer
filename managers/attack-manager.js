// managers/attack-manager.js
//
// Gerencia seleção, telegraph, cast e resolução de dano de ataques de NPC.
// NPCs não contêm lógica de ataque — apenas referenciam IDs de ATTACK_DEFS.
//
// Fluxo por ataque:
//   1. tryAttack()        — NPC escolhe um ataque disponível (range + cooldown + peso)
//   2. _beginCast()       — emite npc_telegraph para o cliente, agenda resolução
//   3. _resolveAttack()   — aplica dano; projéteis via ProjectileManager, AoE direto
//   4. cooldown           — registrado em npc._attackCooldowns[id]

'use strict';

const { dist2D } = require('../utils/helpers');
const { ATTACK_DEFS, MAP_DEFS } = require('../constants');
const { starAttackAllowed } = require('../utils/star-gate');
// Geometria compartilhada com as relíquias do bestiário: o ataque do bicho e a
// relíquia que ele dropa precisam acertar EXATAMENTE a mesma área.
const MonsterSkillManager = require('./monster-skill-manager');

class AttackManager {
  /**
   * @param {Function} addEvent         — broadcast fn do server.js
   * @param {Object}   projectileManager
   */
  constructor(addEvent, projectileManager) {
    this.addEvent = addEvent;
    this.pm       = projectileManager;
  }

  /**
   * Quanto tempo (ms) o golpe ainda OCUPA o bicho DEPOIS do `castTime`.
   *
   * É o que impede o bicho de abrir uma segunda skill por cima de uma que ainda
   * está acontecendo — visualmente é o que separa "um golpe de cada vez" de
   * uma sopa de efeitos sobrepostos na tela.
   *
   * Nem toda skill termina no fim do cast, e o erro fácil aqui é achar que o
   * laço de `ticks` cobre todos os casos. Não cobre: a Orbe Caçadora voa por
   * `lifeMs` e a Descarga em Cadeia anuncia um elo de cada vez — as duas SEM
   * `ticks` nenhum. Elas ficavam com ocupação ZERO e o bicho abria outra skill
   * no meio delas (4 s de orbe voando, ~1,7 s de cadeia pulando).
   *
   * Ao criar uma skill que continue resolvendo depois do cast, ela precisa
   * entrar aqui — senão o bug volta silencioso.
   */
  static busyMs(attack) {
    const ticks = attack.ticks;
    const count = Math.max(1, ticks ? (ticks.count || 1) : 1);
    const step  = ticks ? (ticks.intervalMs || 400) : 0;
    let busy = (count - 1) * step;                    // canalizada

    // Orbe: existe no mundo até estourar ou expirar.
    if (attack.special === 'orb') {
      busy = Math.max(busy, attack.lifeMs || 4000);
    }
    // Sonar: as ondas correm por (rings-1)*intervalo + expansao da ultima.
    if (attack.special === 'sonar') {
      const rings = attack.ringCount || count;
      busy = Math.max(busy, (rings - 1) * step + (attack.expandMs || 1600));
    }
    // Chuva de destrocos: uma queda por `dropIntervalMs`, mais o aviso da ultima.
    if (attack.dropIntervalMs) {
      busy = Math.max(busy,
        (Math.max(1, attack.count || 6) - 1) * attack.dropIntervalMs
        + (attack.dropWarnMs || 700));
    }
    // Muralha de Maré: a onda corre por `travelMs` depois do cast.
    if (attack.special === 'tidewall') {
      busy = Math.max(busy, attack.travelMs || 1200);
    }
    // Cadeia: o 1º elo sai no fim do cast, os demais de `jumpCastMs` em
    // `jumpCastMs`.
    if (attack.shape === 'chain') {
      busy = Math.max(busy,
        (Math.max(1, attack.count || 3) - 1) * (attack.jumpCastMs || 550));
    }
    return busy;
  }

  // ── API pública ──────────────────────────────────────────────────────────────

  /**
   * Tenta iniciar um ataque para um NPC.
   * Chamado pelo npc-manager a cada tick, quando o NPC tem um alvo válido.
   *
   * @param {Object}   npc
   * @param {Object}   target       — jogador mais próximo
   * @param {Object[]} allPlayers   — todos os jogadores do mapa
   * @param {number}   mapLevel
   */
  tryAttack(npc, target, allPlayers, mapLevel) {
    if (npc._currentCast) return; // já está em cast
    if (npc.dead || target.dead)  return;
    if (target.safeUntil && Date.now() < target.safeUntil) return; // imunidade pós-respawn
    if (npc._nextAttackTime && Date.now() < npc._nextAttackTime) return; // cooldown entre ataques

    const dist     = dist2D(npc, target);
    const available = this._getAvailable(npc, dist);
    if (!available.length) return;

    const attack = this._selectWeighted(available);
    this._beginCast(npc, attack, target, allPlayers, mapLevel);
  }

  /**
   * Cancela cast pendente de um NPC (ex: morte durante telegraph).
   * @param {Object} npc
   */
  cancelCast(npc) {
    if (npc._castTimer) {
      clearTimeout(npc._castTimer);
      npc._castTimer = null;
    }
    // Canalizadas (ticks) seguem batendo depois do castTime — sem limpar estes
    // o bicho morto continuava aplicando os ticks restantes.
    if (npc._tickTimers) {
      for (const t of npc._tickTimers) clearTimeout(t);
      npc._tickTimers = null;
    }
    npc._currentCast = null;
  }

  // ── Seleção ──────────────────────────────────────────────────────────────────

  _getAvailable(npc, dist) {
    const now = Date.now();
    const ids  = npc.attacks;
    if (!ids?.length) return [];

    // Fora da Lua de Sangue o bicho não tem a ⭐ no repertório: ela é o ataque
    // forte do conjunto (telegraph longo, dano/leitura maiores) e sobrecarregava
    // o começo de jogo. Na lua ele volta a usar. Ver utils/star-gate.js.
    const available = ids
      .map(id => ATTACK_DEFS[id])
      .filter(atk =>
        atk &&
        atk.shape !== 'aura' &&
        starAttackAllowed(atk) &&
        dist >= atk.rangeMin &&
        dist <= atk.rangeMax &&
        !(npc._attackCooldowns?.[atk.id] > now)
      );

    // Embaralha para que o peso não seja influenciado pela posição no array
    for (let i = available.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [available[i], available[j]] = [available[j], available[i]];
    }

    return available;
  }

  _selectWeighted(attacks) {
    const total = attacks.reduce((s, a) => s + a.weight, 0);
    let r = Math.random() * total;
    for (const atk of attacks) {
      r -= atk.weight;
      if (r <= 0) return atk;
    }
    return attacks[attacks.length - 1];
  }

  // ── Cast / Telegraph ─────────────────────────────────────────────────────────

  _beginCast(npc, attack, target, allPlayers, mapLevel) {
    npc._currentCast = attack.id;

    // Para all_players_in_range: trava posição de TODOS os jogadores no alcance
    let multiTargets = null;
    if (attack.targetMode === 'all_players_in_range') {
      const range = attack.rangeMax || 320;
      const _now = Date.now();
      const inRange = allPlayers.filter(p =>
        p.mapLevel === mapLevel && !p.dead &&
        !(p.safeUntil && _now < p.safeUntil) && dist2D(npc, p) <= range
      );
      if (inRange.length > 0) {
        multiTargets = inRange.map(p => ({ x: p.x, z: p.z }));
      }
    }

    const targetX = target.x;
    const targetZ = target.z;

    // ── Geometria sorteada do bestiário ──────────────────────────────────────
    // Decidida UMA vez, aqui, e guardada no npc: o mesmo conjunto de pontos vai
    // no telegraph (desenho + malhas 3D) e é lido pelo _isHit (dano). Sortear
    // de novo na resolução faria a explosão cair fora da marcação.
    npc._castPoints = null;
    npc._castGapFacing = null;
    if (attack.special === 'obstacles' && attack.legCount) {
      npc._castGapFacing = Math.random() * Math.PI * 2;
      npc._castPoints = MonsterSkillManager.cageSpots(attack, npc._castGapFacing);
    } else if (attack.shape === 'multi') {
      npc._castPoints = MonsterSkillManager.scatter(attack.count || 5, attack.spread || 100, attack);
    } else if (attack.shape === 'ring' && attack.gapAngle) {
      // Sonar: a brecha das ondas e sorteada UMA vez, aqui, e vai no telegraph.
      // Sorteada de novo na resolucao, o vao desenhado ficaria num lado e o
      // buraco no dano no outro.
      npc._castGapFacing = Math.random() * Math.PI * 2;
    }

    this.addEvent({
      type:         'npc_telegraph',
      npcId:        npc.id,
      attackId:     attack.id,
      // Nome legível do golpe — o cliente anuncia sobre o bicho em build de
      // debug, pra dar pra ver QUAL skill disparou enquanto se balanceia.
      attackName:   attack.name || attack.id,
      shape:        attack.shape,
      npcX:         npc.x,
      npcZ:         npc.z,
      x:            targetX,
      z:            targetZ,
      radius:       attack.radius,
      angle:        attack.angle,
      length:       attack.length,
      width:        attack.width,
      duration:     attack.castTime,
      color:        attack.telegraph?.color,
      multiTargets: multiTargets,
      // ── Bestiário ──────────────────────────────────────────────────────────
      // Ataques dos 9 bichos novos carregam a pasta do VFX próprio; o cliente
      // troca o telegraph genérico pela skill dedicada. Ausente nos ataques
      // antigos, que continuam no desenho genérico do TelegraphSystem.
      // Chuva de destrocos: o cast principal e so o WIND-UP. Mandar a pasta da
      // skill aqui faria o cliente tocar as 6 quedas de uma vez, que e
      // exatamente o que deixou de acontecer — cada queda tem telegraph
      // proprio, com o vfx, mais abaixo.
      vfx:          attack.dropIntervalMs ? null : (attack.vfx || null),
      special:      attack.special || null,
      safeRadius:   attack.safeRadius,
      // Raio da irrupção (2ª etapa da investida). É o mesmo número que o
      // servidor usa no dano — é ele que faz o desenho 2D, a peça 3D e o acerto
      // concordarem, em vez de cada um inventar o seu.
      eruptRadius:  attack.eruptRadius,
      spread:       attack.spread,
      count:        attack.count,
      band:         attack.band,
      holdMs:       attack.holdMs,
      durationMs:   attack.durationMs,
      spinSpeed:    attack.spinSpeed,
      follow:       attack.follow || false,
      dash:         attack.dash || false,
      // Canalizada: quantas levas e em que ritmo. O cliente precisa disto para
      // (1) manter o cone girando até o ÚLTIMO tick, (2) pulsar o VFX no mesmo
      // compasso do dano e (3) só encerrar o rastreio na última leva. Sem este
      // campo o cast do bicho chegava sem ticks e tudo isso terminava junto com
      // o cast, enquanto o dano continuava — a queixa de "desvinculado".
      ticks:        attack.ticks || null,
      // Extensão visual (não o raio de dano) — sem estes o cliente dimensiona
      // o quad pelo raio e corta a cadeia/orbe/barragem no meio.
      jumpRange:    attack.jumpRange,
      orbSpeed:     attack.orbSpeed,
      lifeMs:       attack.lifeMs,
      // Distância em que a orbe considera que alcançou e estoura. O desenho
      // precisa dela para estourar junto com o dano em vez de continuar voando.
      catchRadius:  attack.catchRadius,
      burstRadius:  attack.burstRadius,
      stepDistance: attack.stepDistance,
      stepCount:    attack.stepCount,
      firstDistance: attack.firstDistance,
      beamWidth:    attack.beamWidth,
      // Offsets das sub-áreas: decididos AQUI e guardados em `npc._castPoints`
      // para o _isHit conferir a MESMA área que foi desenhada.
      points:       npc._castPoints,
      // Jaula: brecha única — o desenho, as patas 3D e a colisão concordam.
      gapFacing:    npc._castGapFacing,
      // Vao das ondas do Sonar: largura e quanto ele gira por onda. Sem estes
      // o desenho usava os defaults da demo e o setor seguro desenhado nao era
      // o mesmo que o dano poupa.
      gapAngle:     attack.gapAngle,
      gapStep:      attack.gapStep,
      ringCount:    attack.ringCount,
      // Setores da Salva de Bombordo: quantos e onde comecam. Batiam por
      // COINCIDENCIA com o default da demo (4 / 0) — um ajuste no dado e o
      // desenho apontaria setores diferentes dos que disparam.
      sectorCount:  attack.sectorCount,
      sectorOffset: attack.sectorOffset,
      // Area presa ao lancador: o cliente ancora o desenho nele em vez de no
      // ponto do cast, e o quad passa a andar junto.
      atCaster:     attack.atCaster || false,
      // Tempo de expansao de cada onda: o desenho e a simulacao do dano tem de
      // correr no MESMO ritmo, senao a parede que voce ve nao e a que machuca.
      expandMs:     attack.expandMs,
      // Intervalo de LANCAMENTO entre uma onda e a seguinte. Sem mandar, o
      // desenho soltava os aneis no default da demo (0,85 s) enquanto o
      // servidor os soltava no ritmo do dado.
      ringIntervalMs: attack.ticks?.intervalMs,
    }, mapLevel);

    // ── Canalizada / multi-hit ───────────────────────────────────────────────
    // `ticks` do bestiário: o golpe bate `count` vezes espaçadas de
    // `intervalMs`, e o `damageMult` do bicho JÁ é o dano POR TICK (por isso o
    // Sopro tem 0.8 e a Pinçada, de golpe único, tem 2.5). Sem este laço tudo
    // resolvia uma vez só — que era o "não está dando dano por tick".
    const ticks     = attack.ticks;
    // Specials que simulam o PROPRIO ritmo (a orbe voa, as ondas do sonar
    // correm) resolvem uma vez so: o laco de ticks abriria uma simulacao
    // inteira POR LEVA — 4 sonares sobrepostos, 15 acertos onde deviam ser 4.
    const selfRun   = attack.special === 'orb' || attack.special === 'sonar';
    const tickCount = selfRun ? 1 : Math.max(1, ticks ? (ticks.count || 1) : 1);
    const tickStep  = ticks ? (ticks.intervalMs || 400) : 0;
    // Ocupação REAL do golpe (não só o laço de ticks) — ver busyMs().
    const busyMs    = AttackManager.busyMs(attack);

    const timer = setTimeout(() => {
      npc._castTimer   = null;
      npc._currentCast = null;
      if (!npc._attackCooldowns) npc._attackCooldowns = {};
      // Jitter de ±20% no cooldown para que ataques com cooldown igual
      // não expirem sempre na mesma ordem (A→B→C→A→B→C)
      const jitter = attack.cooldown * (Math.random() * 0.4 - 0.2);
      npc._attackCooldowns[attack.id] = Date.now() + attack.cooldown + jitter;
      // Pausa aleatória entre ataques (800ms–2200ms) para que múltiplos ataques
      // disponíveis ao mesmo tempo não resultem sempre no mesmo ser escolhido
      // primeiro. Soma a canalização: sem isso o bicho abria uma segunda skill
      // por cima do Sopro que ainda estava ticando.
      npc._nextAttackTime = Date.now() + busyMs + 800 + Math.random() * 1400;
      // Aborta se o NPC morreu OU já saiu do mapa (algumas mortes deletam o NPC
      // do Map sem setar dead) — sem isto o telegraph "fantasma" ainda causa dano
      // ~castTime depois de o jogador ter matado o NPC.
      if (npc.dead || (this.pm?.npcs && !this.pm.npcs.has(npc.id))) return;

      // Direcao do avanco, travada no inicio da resolucao: os passos seguem a
      // linha bicho->alvo daquele instante, igual ao desenho.
      const tx0 = targetX, tz0 = targetZ;

      const fireTick = (tickIdx) => {
        // Cada tick reconfere: a canalização dura segundos e o bicho pode
        // morrer no meio dela.
        if (npc.dead || (this.pm?.npcs && !this.pm.npcs.has(npc.id))) return;

        let tx = targetX, tz = targetZ;

        // `atCaster`: a area e centrada no PROPRIO bicho e o acompanha. Lido a
        // cada leva (nao uma vez no cast) — e isso que faz a salva ANDAR com
        // ele em vez de ficar plantada onde o alvo estava.
        if (attack.atCaster) {
          tx = npc.x;
          tz = npc.z;
        }

        if (attack.follow && !multiTargets) {
          // Canalizada re-mira no alvo VIVO a cada tick — é o equivalente, do
          // lado do bicho, ao `relic_aim` que o jogador manda com o mouse. Sem
          // isto o cone ficava travado na direção do começo do cast enquanto
          // bicho e alvo continuavam andando ("a skill fica toda torta").
          if (target && !target.dead && target.mapLevel === mapLevel) {
            tx = target.x;
            tz = target.z;
          }
          // O cliente só sabe re-mirar o cast LOCAL (que segue o mouse); para
          // cast de bicho quem manda o giro é o servidor, senão o desenho
          // aponta para um lado e o dano sai para o outro.
          const adx = tx - npc.x, adz = tz - npc.z;
          const al  = Math.hypot(adx, adz) || 1;
          this.addEvent({
            type: 'npc_skill_aim',
            npcId: npc.id,
            npcX:  npc.x,
            npcZ:  npc.z,
            dirX:  adx / al,
            dirZ:  adz / al,
          }, mapLevel);
        }

        // Geometria que ANDA (a frente do Sonar, o passo da Barragem) precisa
        // saber QUAL leva está resolvendo — sem isso toda leva bate a mesma
        // área e a parede vira enfeite. Mesmo canal do `_spinNow` da Coroa.
        const tickAtk = {
          ...attack,
          _tickIndex: tickIdx,
          _tickCount: tickCount,
          _gapFacing: npc._castGapFacing,
        };

        if (multiTargets) {
          for (const t of multiTargets) {
            this._resolveAttack(npc, tickAtk, t.x, t.z, allPlayers, mapLevel);
          }
        } else {
          this._resolveAttack(npc, tickAtk, tx, tz, allPlayers, mapLevel);
        }
      };

      // ── Barragem Rolante: cada passo ergue PEDRA de verdade ───────────────
      // Isto so existia no caminho da relIquia (monster-skill-manager). No
      // cast de bicho a barragem so pintava faixas: nao bloqueava, nao
      // empurrava, e o cliente nunca recebia `monster_skill_obstacles` para
      // erguer as malhas 3D — era o "a parede nao esta sendo invocada".
      if (attack.wallPerStep) {
        this._raiseBarrageWalls(npc, attack, tx0, tz0, tickStep, mapLevel);
      }

      fireTick(0);
      for (let i = 1; i < tickCount; i++) {
        const t = setTimeout(() => {
          if (npc._tickTimers) {
            npc._tickTimers = npc._tickTimers.filter(x => x !== t);
          }
          fireTick(i);
        }, i * tickStep);
        (npc._tickTimers ||= []).push(t);
      }
    }, attack.castTime);

    npc._castTimer = timer;
  }

  // ── Resolução de dano ────────────────────────────────────────────────────────

  /**
   * Barragem Rolante do BICHO: uma parede de pedra por passo, no ritmo do
   * avanco. Espelha o `wallPerStep` do monster-skill-manager (a versao da
   * reliquia) — as duas precisam bloquear igual, senao o mesmo golpe empurra
   * quando o jogador lanca e atravessa quando o bicho lanca.
   *
   * O bloqueio em si e do wallManager; o `monster_skill_obstacles` e o que faz
   * o cliente erguer as malhas 3D nos mesmos pontos.
   */
  _raiseBarrageWalls(npc, attack, targetX, targetZ, stepMs, mapLevel) {
    const wallManager = this.wallManager;
    if (!wallManager) return;
    const ddx = targetX - npc.x, ddz = targetZ - npc.z;
    const dl  = Math.hypot(ddx, ddz) || 1;
    const dx  = ddx / dl, dz = ddz / dl;
    const perp = { x: -dz, z: dx };            // eixo da parede

    const steps = attack.stepCount || 5;
    const first = attack.firstDistance || 20;
    const gap   = attack.stepDistance || 20;
    const halfW = (attack.width || 80) / 2;
    const r     = attack.obstacleRadius || 8;
    const hold  = attack.holdMs || 1400;
    const ox = npc.x, oz = npc.z;

    for (let i = 0; i < steps; i++) {
      const t = setTimeout(() => {
        if (npc._tickTimers) npc._tickTimers = npc._tickTimers.filter(x => x !== t);
        if (npc.dead || (this.pm?.npcs && !this.pm.npcs.has(npc.id))) return;
        const d = first + i * gap;
        const spots = [];
        const n = Math.max(2, Math.round(halfW / Math.max(r, 1)));
        for (let k = -n; k <= n; k++) {
          const off = (k / n) * halfW;
          spots.push({ x: perp.x * off + dx * d, z: perp.z * off + dz * d });
          wallManager.addWall(mapLevel, {
            id: `bar_${npc.id}_${Date.now()}_${i}_${k}`,
            x: ox + perp.x * off + dx * d,
            z: oz + perp.z * off + dz * d,
            hw: r, hh: r, rot: 0, durationMs: hold,
          });
        }
        this.addEvent({
          type: 'monster_skill_obstacles', npcId: npc.id, skill: attack.skill,
          vfx: attack.vfx, originX: ox, originZ: oz, points: spots,
          radius: r, holdMs: hold, facing: Math.atan2(dx, dz),
        }, mapLevel);
      }, i * stepMs);
      (npc._tickTimers ||= []).push(t);
    }
  }

  _resolveAttack(npc, attack, targetX, targetZ, allPlayers, mapLevel) {
    if (attack.shape === 'projectile') {
      this._spawnProjectiles(npc, attack, targetX, targetZ);
      return;
    }

    // Orbe Caçadora: vira uma ameaça MÓVEL simulada pelo servidor. Antes o
    // `special: 'orb'` não tinha implementação nenhuma aqui — o servidor batia
    // um círculo no ponto do cast e quem "perseguia" era só o desenho, que num
    // cast de bicho ia atrás do inimigo mais próximo do jogador (outro NPC).
    if (attack.special === 'orb' && !attack._orbBurst) {
      this._runHunterOrb(npc, attack, targetX, targetZ, allPlayers, mapLevel);
      return;
    }

    // Chuva de destrocos: uma queda por vez, mirada ao vivo. Ver _runWreckRain.
    if (attack.dropIntervalMs && !attack._drop) {
      this._runWreckRain(npc, attack, allPlayers, mapLevel);
      return;
    }

    // Muralha de Maré: a onda VIAJA. Ver _runTideWall.
    if (attack.special === 'tidewall' && attack._frontDistance == null) {
      this._runTideWall(npc, attack, targetX, targetZ, allPlayers, mapLevel);
      return;
    }

    // Sonar: as ondas CORREM. Ver _runSonar.
    if (attack.special === 'sonar' && attack._frontRadius == null) {
      this._runSonar(npc, attack, targetX, targetZ, allPlayers, mapLevel);
      return;
    }

    // Cadeia: pulos ENCADEADOS, um de cada vez e cada um anunciado antes.
    // O `_isHit` de 'chain' só sabe testar um círculo de radius+jumpRange, e não
    // existia nenhuma lógica de pulo aqui — na prática a "cadeia" era um estouro
    // instantâneo de raio 110 que pegava todo mundo junto, sem falloff.
    if (attack.shape === 'chain' && !attack._chainLink) {
      this._resolveChain(npc, attack, targetX, targetZ, allPlayers, mapLevel);
      return;
    }

    // O corredor/cone nasce de ONDE O GOLPE COMEÇOU. Precisa ser capturado
    // antes do dash: o `_isHit` usa esta origem, e mover o bicho primeiro fazia
    // a faixa de dano ser medida a partir do FIM da investida, apontando de
    // volta para o ponto de partida — por isso a Investida Enterrada não
    // acertava nada. Para os demais ataques o valor é o mesmo de npc.x/z.
    // `_castPoints` VAI JUNTO no snapshot: as sub-áreas do `multi` foram
    // sorteadas no telegraph e é o `_isHit` quem as confere. Sem esta linha o
    // snapshot só tinha x/z, `cast._castPoints` vinha `undefined` e o `multi`
    // caía em `[].some()` — ou seja, morteiro, tentáculos, pústulas, cemitério
    // de naufrágios, sentença do crânio e ninhada NUNCA acertavam ninguém. Do
    // lado do jogador isso lia como "Esquiva!" toda vez, mesmo parado em cima.
    const castOrigin = { x: npc.x, z: npc.z, _castPoints: npc._castPoints };

    // Dash (Investida/Bote): o bicho VIAJA até o fim do corredor — a investida
    // acontece de verdade. Clamps de ilha/muro/borda ficam com o npc-manager
    // no próximo tick de movimento.
    if (attack.dash) {
      const ddx = targetX - npc.x, ddz = targetZ - npc.z;
      const dl = Math.hypot(ddx, ddz) || 1;
      const reach = attack.length || 100;
      npc.x += (ddx / dl) * reach;
      npc.z += (ddz / dl) * reach;
    }

    const hits = [];
    const _hitNow = Date.now();
    const mapPlayers = allPlayers.filter(p =>
      p.mapLevel === mapLevel && !p.dead && !(p.safeUntil && _hitNow < p.safeUntil)
    );

    const goldStealRatio = (MAP_DEFS[mapLevel] || {}).goldStealRatio || 0;

    // Maré Partida (splitDamage): o dano total é rateado entre TODOS que estão
    // na área — ficar junto É a defesa. Precisa contar antes do laço: aplicando
    // dentro dele, o primeiro do array levaria o valor cheio.
    // Conta quem está na área, não quem toma dano: quem entrou protegido por
    // invencibilidade/escudo ainda "segura sua parte" da maré.
    let splitDiv = 1;
    if (attack.splitDamage) {
      splitDiv = Math.max(1, mapPlayers.reduce(
        (n, p) => n + (this._isHit(p, attack, targetX, targetZ, castOrigin) ? 1 : 0), 0));
    }

    for (const p of mapPlayers) {
      if (this._isHit(p, attack, targetX, targetZ, castOrigin)) {
        // Névoa Espectral: invencível bloqueia também ataques em área
        // (antes só projéteis respeitavam — necessário para a defensiva do pet)
        if (p.relicInvincibleExpires && _hitNow < p.relicInvincibleExpires) {
          this.addEvent({ type: 'shield_block', targetId: p.id }, mapLevel);
          continue;
        }
        let dmg = Math.max(1, Math.floor((npc.cannonDmg || 1) * attack.damageMult / splitDiv));
        // Aplica debuff de defesa se ativo
        const defDebuff = p.activeDebuffs?.find(d => d.type === 'defense_buff' && d.expiresAt > Date.now());
        if (defDebuff) dmg = Math.round(dmg * (1 + Math.abs(defDebuff.value)));
        // Escudo de Ouro: 30% DR (mesmo que projectile-manager)
        if (p.relicGoldShieldActive) {
          const blocked = Math.round(dmg * 0.30);
          dmg -= blocked;
          const goldCost = Math.round(blocked * 0.10);
          if (goldCost > 0) p.gold = Math.max(0, (p.gold || 0) - goldCost);
        }
        // ── Carapaça Eriçada (r32): mitiga e DEVOLVE parte do golpe ───────
        // Isto só existia no projectile-manager, ou seja, a carapaça só valia
        // contra TIRO. Contra as 34 skills de área do bestiário — justamente o
        // que um kit de tanque deveria aparar — ela não fazia absolutamente
        // nada, nem mitigação nem reflexão. Mesma conta do caminho do tiro.
        if (p.relicBulwarkExpires && _hitNow < p.relicBulwarkExpires) {
          const mitigado = Math.round(dmg * (p.relicBulwarkReduction || 0.4));
          dmg = Math.max(0, dmg - mitigado);
          const refletido = Math.round(mitigado * (p.relicBulwarkReflect || 0.3));
          if (refletido > 0 && !npc.dead) {
            npc.hp = Math.max(0, npc.hp - refletido);
            this.addEvent({
              type: 'bulwark_reflect', targetId: p.id,
              shooterId: npc.id, dmg: refletido, hp: npc.hp,
            }, mapLevel);
          }
        }

        // Pet: relíquia defensiva intercepta ANTES do dano ser aplicado
        if (this.petManager) {
          dmg = this.petManager.interceptOwnerDamage(p, dmg);
          if (dmg <= 0) {
            this.addEvent({ type: 'shield_block', targetId: p.id }, mapLevel);
            continue;
          }
        }
        p.hp = Math.max(0, p.hp - dmg);
        p.lastCombatTime = Date.now();

        // Roubo de ouro (goldStealRatio definido no MAP_DEFS do mapa)
        let goldStolen = 0;
        if (goldStealRatio > 0 && dmg > 0) {
          goldStolen = Math.max(1, Math.floor(dmg * goldStealRatio));
          p.gold     = Math.max(0, (p.gold || 0) - goldStolen);
        }

        hits.push({ id: p.id, hp: p.hp, dmg, goldStolen });

        // Verifica morte do jogador
        if (p.hp <= 0 && !p.dead) {
          p.dead = true;
          // Zona vermelha: qualquer morte (até pro kraken) dropa ruína saqueável
          if (this.wreckManager) this.wreckManager.onPlayerDeath(p);
          this.addEvent({
            type:     'entity_dead',
            id:       p.id,
            name:     p.name,
            isNPC:    false,
            killerId: npc.id,
          }, mapLevel, /* urgent */ true);
        }

        // ── CC do bestiário (`cc`) ───────────────────────────────────────
        // O lado da RELÍQUIA sempre aplicou (monster-skill-manager); o lado do
        // BICHO ignorava o campo, então o slow do Sopro e o root dos Tentáculos
        // eram só desenho. Usa os mesmos campos que a Prisão de Gelo já usa no
        // jogador (slowMult/slowExpires, stunExpires), lidos pelo player-manager.
        if (attack.cc) {
          const cc = attack.cc;
          const ccNow = Date.now();
          if (cc.slowPct) {
            // Pior slow vence em vez de empilhar — dois ataques lentos seguidos
            // não podem somar até deixar o barco parado.
            p.slowMult    = Math.min(p.slowMult || 1, 1 - cc.slowPct);
            p.slowExpires = Math.max(p.slowExpires || 0, ccNow + (cc.slowMs || 2000));
          }
          if (cc.stunMs) p.stunExpires = Math.max(p.stunExpires || 0, ccNow + cc.stunMs);
          if (cc.rootMs) p.stunExpires = Math.max(p.stunExpires || 0, ccNow + cc.rootMs);
        }

        // Aplica efeitos (debuffs + pull) ao jogador
        if (attack.effects?.length) {
          if (!p.activeDebuffs) p.activeDebuffs = [];
          const now = Date.now();
          for (const eff of attack.effects) {
            if (eff.type === 'pull') {
              // Puxa o jogador em direção ao NPC até pullDistance unidades de distância
              const pullDist = eff.pullDistance || 60;
              const ddx = npc.x - p.x;
              const ddz = npc.z - p.z;
              const d   = Math.sqrt(ddx * ddx + ddz * ddz) || 1;
              if (d > pullDist) {
                p.x = npc.x - (ddx / d) * pullDist;
                p.z = npc.z - (ddz / d) * pullDist;
              }
              this.addEvent({
                type:     'player_pulled',
                playerId: p.id,
                npcId:    npc.id,
                toX:      p.x,
                toZ:      p.z,
              }, mapLevel);
            } else {
              // Remove debuff do mesmo tipo se já existe, depois aplica
              p.activeDebuffs = p.activeDebuffs.filter(d => d.type !== eff.type);
              p.activeDebuffs.push({ type: eff.type, value: eff.value, expiresAt: now + eff.duration });
            }
          }
        }
      }
    }

    // A simulacao fina do Sonar roda dezenas de passos por cast; anunciar leva
    // vazia enche a rede e faz o cliente contar levas que nao aconteceram.
    if ((attack._frontRadius != null || attack._frontDistance != null)
        && hits.length === 0) return;

    this.addEvent({
      type:         'npc_attack_hit',
      npcId:        npc.id,
      attackId:     attack.id,
      shape:        attack.shape,
      x:            targetX,
      z:            targetZ,
      hits,
      effects:      attack.effects || [],
      visualEffect: attack.visualEffect || null,
      // splitDamage: quantos rachavam a conta — o cliente mostra "Dividido ×N"
      splitCount:   attack.splitDamage ? splitDiv : null,
    }, mapLevel);
  }

  /**
   * Orbe Caçadora: o servidor move a orbe em direção ao alvo vivo, corrói quem
   * estiver dentro dela a cada `orbTickMs` e estoura (dano cheio + stun) ao
   * alcançar o alvo ou ao fim de `lifeMs`. A posição é transmitida a cada leva
   * para o desenho seguir o mesmo ponto do dano — o cliente sozinho não tem como
   * saber quem a orbe de um BICHO está caçando.
   */
  _runHunterOrb(npc, attack, targetX, targetZ, allPlayers, mapLevel) {
    const tickMs  = attack.orbTickMs || 400;
    const life    = attack.lifeMs    || 4000;
    const speed   = attack.orbSpeed  || 55;      // unidades por segundo
    const radius  = attack.radius    || 45;
    const catchR  = attack.catchRadius || 18;
    const startAt = Date.now();

    // Nasce no bicho e caça quem foi mirado; se ele sumir, segue para o ponto.
    const orb = { x: npc.x, z: npc.z };
    const aimedId = allPlayers.find(p =>
      p.mapLevel === mapLevel && !p.dead &&
      Math.hypot(p.x - targetX, p.z - targetZ) < 1e-6)?.id || null;

    const burst = (bx, bz) => {
      // O estouro é o ataque normal (círculo) — reaproveita dano, escudo, pet,
      // morte e o cc do dado, que aqui traz o atordoamento.
      this._resolveAttack(npc, { ...attack, shape: 'circle', radius, _orbBurst: true },
        bx, bz, allPlayers, mapLevel);
      this.addEvent({ type: 'npc_orb_end', npcId: npc.id, x: bx, z: bz }, mapLevel);
    };

    const step = () => {
      if (npc.dead || (this.pm?.npcs && !this.pm.npcs.has(npc.id))) return;

      // Presa: o alvo mirado enquanto vivo; senão o mais próximo da ORBE.
      let prey = aimedId ? allPlayers.find(p => p.id === aimedId) : null;
      if (!prey || prey.dead || prey.mapLevel !== mapLevel) {
        prey = null;
        let best = Infinity;
        for (const p of allPlayers) {
          if (p.mapLevel !== mapLevel || p.dead) continue;
          const d = Math.hypot(p.x - orb.x, p.z - orb.z);
          if (d < best) { best = d; prey = p; }
        }
      }

      // Avança em direção à presa (posição VIVA — é o "seguir o alvo").
      if (prey) {
        const dx = prey.x - orb.x, dz = prey.z - orb.z;
        const d  = Math.hypot(dx, dz) || 1;
        const stepDist = speed * (tickMs / 1000);
        if (d <= stepDist || d <= catchR) {          // alcançou
          orb.x = prey.x; orb.z = prey.z;
          return burst(orb.x, orb.z);
        }
        orb.x += (dx / d) * stepDist;
        orb.z += (dz / d) * stepDist;
      }

      this.addEvent({ type: 'npc_orb_move', npcId: npc.id, x: orb.x, z: orb.z, radius }, mapLevel);

      // Corrosão: fração do dano em quem estiver DENTRO da orbe agora.
      this._resolveAttack(npc, {
        ...attack, shape: 'circle', radius, _orbBurst: true,
        cc: null,                                    // o stun é só do estouro
        damageMult: (attack.damageMult || 1) * (attack.orbTickPct || 0.18),
      }, orb.x, orb.z, allPlayers, mapLevel);

      if (Date.now() - startAt >= life) return burst(orb.x, orb.z);

      const t = setTimeout(() => {
        if (npc._tickTimers) npc._tickTimers = npc._tickTimers.filter(x => x !== t);
        step();
      }, tickMs);
      (npc._tickTimers ||= []).push(t);
    };

    step();
  }

  /**
   * Descarga em Cadeia: resolve elo a elo. Cada pulo MARCA o ponto e só bate
   * `jumpCastMs` depois, então quem está no próximo elo pode sair do raio — era
   * o pedido de "dar tempo de desviar". O dano cai por `falloff` a cada pulo e
   * ninguém é atingido duas vezes pela mesma cadeia.
   *
   * Cada elo reaproveita o `_resolveAttack` como um círculo (`_chainLink` evita
   * a recursão): assim escudo, pet, roubo de ouro, morte, cc e o evento de
   * impacto continuam saindo do mesmo lugar de sempre.
   */
  _resolveChain(npc, attack, targetX, targetZ, allPlayers, mapLevel) {
    const links   = Math.max(1, attack.count || 3);
    const jumpMs  = attack.jumpCastMs || 550;
    const radius  = attack.radius || 20;
    const range   = attack.jumpRange || 90;
    const falloff = attack.falloff || 0.75;
    const hitIds  = new Set();

    const alive = () => allPlayers.filter(p =>
      p.mapLevel === mapLevel && !p.dead && !hitIds.has(p.id) &&
      !(p.safeUntil && Date.now() < p.safeUntil));

    const fireLink = (k, markX, markZ) => {
      if (npc.dead || (this.pm?.npcs && !this.pm.npcs.has(npc.id))) return;

      // Quem estiver no raio do ponto MARCADO leva — quem saiu, escapou.
      const linkAttack = {
        ...attack,
        shape: 'circle',
        radius,
        _chainLink: true,
        damageMult: (attack.damageMult || 1) * Math.pow(falloff, k),
      };
      for (const p of alive()) {
        if (Math.hypot(p.x - markX, p.z - markZ) <= radius) hitIds.add(p.id);
      }
      this._resolveAttack(npc, linkAttack, markX, markZ, allPlayers, mapLevel);

      if (k + 1 >= links) return;

      // Próximo elo: o mais perto DESTE ponto que ainda não foi atingido.
      let next = null, bestD = Infinity;
      for (const p of alive()) {
        const d = Math.hypot(p.x - markX, p.z - markZ);
        if (d <= range && d < bestD) { bestD = d; next = p; }
      }
      if (!next) return;   // cadeia morre onde não há mais ninguém por perto

      const nx = next.x, nz = next.z;
      this.addEvent({
        type:     'npc_telegraph',
        npcId:    npc.id,
        attackId: attack.id,
        shape:    'circle',
        npcX:     npc.x,
        npcZ:     npc.z,
        x:        nx,
        z:        nz,
        radius,
        duration: jumpMs,
        color:    attack.telegraph?.color,
        // SEM `vfx` de propósito: este evento é só o AVISO do próximo elo, um
        // círculo no chão. Mandando a pasta da skill aqui, o cliente entendia
        // "toca a Descarga em Cadeia inteira" e reproduzia a animação COMPLETA
        // a cada pulo — dentro de um quad dimensionado para um círculo de
        // `radius`, que é o que fazia o desenho aparecer cortado. O círculo
        // genérico do TelegraphSystem já usa a cor certa (`color`, acima).
        vfx:      null,
        chainLink: k + 1,          // informativo p/ o cliente (elo nº)
      }, mapLevel);

      const t = setTimeout(() => {
        if (npc._tickTimers) npc._tickTimers = npc._tickTimers.filter(x => x !== t);
        fireLink(k + 1, nx, nz);
      }, jumpMs);
      (npc._tickTimers ||= []).push(t);
    };

    fireLink(0, targetX, targetZ);
  }

  /**
   * Sonar do Abismo: cada onda e uma PAREDE que corre de 0 ate `radius` em
   * `expandMs`, e machuca quem ela atravessa — uma vez so, e nunca quem esta
   * no vao daquela onda.
   *
   * Antes isto eram 4 levas de `ring`, e a conta nao fechava: a frente pulava
   * `radius/4` (65 un) por leva sobre uma faixa de 30, entao **54% do raio
   * nunca era atingido**. O jogador via o anel passar por cima dele sem nada
   * acontecer, e levava dano parado num ponto onde nao havia anel nenhum.
   *
   * O passo da simulacao sai da propria faixa (`expandMs * band / radius`):
   * assim a frente avanca exatamente `band` por passo — a varredura fica
   * CONTINUA (sem buraco) e ninguem leva a mesma onda duas vezes, entao o dano
   * total continua sendo um por onda, como era.
   */
  _runSonar(npc, attack, targetX, targetZ, allPlayers, mapLevel) {
    const rings  = attack.ringCount || attack.ticks?.count || 4;
    const gapMs  = attack.ticks?.intervalMs || 850;
    const expand = attack.expandMs || 1600;
    const radius = attack.radius || 90;
    const band   = attack.band || 20;
    const stepMs = Math.max(60, Math.round((expand * band) / Math.max(radius, 1)));
    const total  = (rings - 1) * gapMs + expand;
    const start  = Date.now();
    // Centrado no ALVO do cast e PLANTADO ali — e onde o cliente ancora o
    // desenho (`ring` nao e from_caster). Recentrar no bicho poria as ondas
    // do dano num lugar e as desenhadas em outro.
    const ox = targetX, oz = targetZ;
    const gapFacing = npc._castGapFacing;

    const step = () => {
      if (npc.dead || (this.pm?.npcs && !this.pm.npcs.has(npc.id))) return;
      const el = Date.now() - start;

      for (let i = 0; i < rings; i++) {
        const t = el - i * gapMs;
        if (t < 0 || t > expand) continue;          // ainda nao saiu / ja acabou
        const front = radius * (t / expand);
        this._resolveAttack(npc, {
          ...attack,
          shape: 'ring',
          _frontRadius: front,
          _ringIndex: i,
          _gapFacing: gapFacing,
        }, ox, oz, allPlayers, mapLevel);
      }

      if (el >= total) return;
      const tm = setTimeout(() => {
        if (npc._tickTimers) npc._tickTimers = npc._tickTimers.filter(x => x !== tm);
        step();
      }, stepMs);
      (npc._tickTimers ||= []).push(tm);
    };
    step();
  }

  /**
   * Muralha de Maré: UMA parede que corre do bicho até `length` em `travelMs`,
   * machucando quem ela alcança — uma vez só.
   *
   * Antes era um `line` comum: o corredor inteiro resolvia no fim do cast, ou
   * seja o dano saía TODO no instante em que a onda ainda estava saindo. Quem
   * estava no fim do corredor levava antes de a parede chegar perto.
   *
   * O passo sai da própria espessura (`travelMs × band / length`), então a
   * frente avança exatamente `band` por passo: a varredura fica contínua (sem
   * buraco) e ninguém leva a mesma onda duas vezes. Mesma receita do Sonar.
   */
  _runTideWall(npc, attack, targetX, targetZ, allPlayers, mapLevel) {
    const reach  = attack.length || 200;
    const band   = attack.band || 20;
    const travel = attack.travelMs || 1200;
    const stepMs = Math.max(60, Math.round((travel * band) / Math.max(reach, 1)));
    const start  = Date.now();
    // Origem e direção TRAVADAS no cast: a muralha é plantada, não persegue.
    const ox = npc.x, oz = npc.z;

    const step = () => {
      if (npc.dead || (this.pm?.npcs && !this.pm.npcs.has(npc.id))) return;
      const el = Date.now() - start;
      const front = reach * Math.min(el / travel, 1);

      this._resolveAttack(npc, { ...attack, _frontDistance: front },
        targetX, targetZ, allPlayers, mapLevel);

      if (el >= travel) return;
      const tm = setTimeout(() => {
        if (npc._tickTimers) npc._tickTimers = npc._tickTimers.filter(x => x !== tm);
        step();
      }, stepMs);
      (npc._tickTimers ||= []).push(tm);
    };
    step();
  }

  /**
   * Cemiterio de Naufragios: os destrocos caem UM POR VEZ, cada um mirado em
   * onde o alvo esta NAQUELE instante, com `dropWarnMs` de aviso.
   *
   * As 6 quedas simultaneas eram um sorteio: raio 30 sobre espalhamento 200
   * quase nunca punia quem ficava parado. Em chuva, parar e a pior escolha —
   * e como cada destroco vira obstaculo, correr em linha reta fecha a arena
   * em volta de quem fugiu.
   *
   * Cada queda tem telegraph PROPRIO (com o vfx, uma peca so) e ergue pedra de
   * verdade — o `special: 'obstacles'` do bicho nunca chegou a erguer nada, a
   * mesma lacuna que a Barragem tinha.
   */
  _runWreckRain(npc, attack, allPlayers, mapLevel) {
    const drops  = Math.max(1, attack.count || 6);
    const gapMs  = attack.dropIntervalMs || 1000;
    const warnMs = attack.dropWarnMs || 700;
    const r      = attack.obstacleRadius || 8;
    const hold   = attack.holdMs || 8000;

    for (let i = 0; i < drops; i++) {
      const t = setTimeout(() => {
        if (npc._tickTimers) npc._tickTimers = npc._tickTimers.filter(x => x !== t);
        if (npc.dead || (this.pm?.npcs && !this.pm.npcs.has(npc.id))) return;

        // Mira ao VIVO: o mais proximo do bicho naquele instante.
        let presa = null, best = Infinity;
        for (const p of allPlayers) {
          if (p.mapLevel !== mapLevel || p.dead) continue;
          const d = dist2D(npc, p);
          if (d < best) { best = d; presa = p; }
        }
        if (!presa) return;
        const dx = presa.x, dz = presa.z;

        // Aviso desta queda. `vfx` presente e `count: 1`: o cliente desenha UM
        // destroco caindo, nao o campo inteiro.
        this.addEvent({
          type: 'npc_telegraph', npcId: npc.id, attackId: attack.id,
          shape: 'circle', npcX: npc.x, npcZ: npc.z, x: dx, z: dz,
          radius: attack.radius, duration: warnMs,
          color: attack.telegraph?.color,
          vfx: attack.vfx || null, skill: attack.skill,
          count: 1, points: [{ x: 0, z: 0 }],
          // `spread: 0` PRENDE o destroco no ponto anunciado. Sem isto a skill
          // sorteia o ponto dela dentro de `spread_radius` (200 un no default),
          // entao a marcacao de impacto aparecia longe de onde a peca caia — e
          // fora do quad, que e dimensionado pelo raio de dano. Era o "nao
          // mostra a area de impacto".
          spread: 0,
          dropIndex: i,
        }, mapLevel);

        const t2 = setTimeout(() => {
          if (npc._tickTimers) npc._tickTimers = npc._tickTimers.filter(x => x !== t2);
          if (npc.dead || (this.pm?.npcs && !this.pm.npcs.has(npc.id))) return;

          // Dano so de quem esta debaixo do destroco AGORA.
          this._resolveAttack(npc, { ...attack, shape: 'circle', _drop: true },
            dx, dz, allPlayers, mapLevel);

          // E o destroco vira obstaculo de verdade.
          if (this.wallManager) {
            this.wallManager.addWall(mapLevel, {
              id: `wreck_${npc.id}_${Date.now()}_${i}`,
              x: dx, z: dz, hw: r, hh: r, rot: 0, durationMs: hold,
            });
          }
          this.addEvent({
            type: 'monster_skill_obstacles', npcId: npc.id, skill: attack.skill,
            vfx: attack.vfx, originX: dx, originZ: dz,
            points: [{ x: 0, z: 0 }], radius: r, holdMs: hold,
          }, mapLevel);
        }, warnMs);
        (npc._tickTimers ||= []).push(t2);
      }, i * gapMs);
      (npc._tickTimers ||= []).push(t);
    }
  }

  _spawnProjectiles(npc, attack, targetX, targetZ) {
    const count    = attack.count ?? npc.cannonCount ?? 1;
    const spread   = attack.spread || 0.05;
    const baseAng  = Math.atan2(targetX - npc.x, targetZ - npc.z);

    for (let i = 0; i < count; i++) {
      const ang = baseAng + (Math.random() - 0.5) * spread * 2;
      const d   = 80 + Math.random() * 40;
      this.pm.spawn(
        npc,
        npc.x + Math.sin(ang) * d,
        npc.z + Math.cos(ang) * d,
        0,
        attack.damageMult,
        npc.cannonDmg || 0
      );
    }
  }

  // ── Geometria de hit ─────────────────────────────────────────────────────────

  /**
   * O jogador está dentro da área do golpe?
   *
   * `cast` NÃO é o npc: é o SNAPSHOT do cast (ver `castOrigin` em
   * _resolveAttack), porque a investida move o bicho antes da resolução e a
   * área precisa ser medida de onde o golpe saiu. Ele carrega o que a
   * geometria pede — hoje `x`, `z` e `_castPoints`.
   *
   * O parâmetro já se chamou `npc`, e foi exatamente isso que quebrou o
   * `multi`: lendo `npc._castPoints` de um objeto `{x, z}` vinha `undefined`,
   * `inShape` caía em `[].some()` e NENHUM ataque multi acertava ninguém.
   * Ao adicionar um campo novo aqui, lembre de colocá-lo também no snapshot.
   */
  _isHit(player, attack, tx, tz, cast) {
    const px = player.x;
    const pz = player.z;

    switch (attack.shape) {
      case 'circle': {
        // Setores (Salva de Bombordo) e qualquer outra regra do bestiario moram
        // no `inShape`. Este ramo tinha a propria conta e so olhava o raio —
        // pela SEGUNDA vez a mesma armadilha (a 1a foi a faixa da Barragem no
        // `line`): corrigir a geometria compartilhada nao muda nada aqui.
        if (attack.sectorCount) {
          return MonsterSkillManager.inShape(attack, 'circle', tx, tz, 0, 0, null, player);
        }
        const dx = px - tx, dz = pz - tz;
        return dx * dx + dz * dz <= attack.radius * attack.radius;
      }

      case 'cone': {
        const d = dist2D(player, cast);
        if (d > (attack.length || attack.rangeMax)) return false;
        // Colado no ápice o ângulo é indefinido, mas estar em cima do bicho
        // está trivialmente DENTRO do cone (mesma regra do MonsterSkillManager).
        if (d < 0.001) return true;
        const aimAng    = Math.atan2(tx - cast.x, tz - cast.z);
        const playerAng = Math.atan2(px - cast.x, pz - cast.z);
        let   diff      = Math.abs(playerAng - aimAng);
        if (diff > Math.PI) diff = Math.PI * 2 - diff;
        // `angle` é em GRAUS (é assim que o bestiário e o telegraph o usam) e
        // `diff` em radianos: sem a conversão o limiar de um cone de 70° virava
        // 35 rad e QUALQUER diferença passava — o cone desenhado batia 360° em
        // volta do bicho. Mesma conta do cone da relíquia.
        return diff <= ((attack.angle || 60) * Math.PI / 180) / 2;
      }

      case 'line': {
        // Projeção do jogador sobre o eixo origem→alvo
        const dirX = tx - cast.x,  dirZ = tz - cast.z;
        const len  = Math.sqrt(dirX * dirX + dirZ * dirZ) || 1;
        const uX = dirX / len,   uZ = dirZ / len;  // unit ao longo da linha

        // ── Barragem Rolante: geometria COMPARTILHADA com a relíquia ────────
        // Existem duas implementações de `line` (esta e a do MonsterSkillManager)
        // e só a de lá sabia da faixa por passo — o bicho seguia batendo o
        // corredor antigo, que vai do bicho até ONDE O ALVO ESTAVA no cast.
        // Como os passos vão MUITO além disso (60 → 280 aqui), quem se afastava
        // não levava nada; e depois que a barragem passou a erguer pedra, o
        // empurrão da parede tirava o jogador do único trecho que machucava.
        // Delegar mantém as duas mãos do mesmo golpe acertando igual.
        if (attack.stepCount || attack._frontDistance != null) {
          return MonsterSkillManager.inShape(
            attack, 'line', cast.x, cast.z, uX, uZ, null, player);
        }

        const rX = -uZ,          rZ = uX;           // unit perpendicular
        const relX = px - cast.x, relZ = pz - cast.z;
        const along = relX * uX + relZ * uZ;
        const perp  = Math.abs(relX * rX + relZ * rZ);
        // O corredor tem o comprimento DESENHADO (`length`), não a distância
        // até o alvo: com o alvo perto, a faixa marcada passava dele e o dano
        // parava antes — desenho e dano discordavam.
        const reach = attack.length || len;
        if (along >= 0 && along <= reach && perp <= (attack.width || 10) / 2) return true;

        // 2ª etapa da investida: a IRRUPÇÃO no fim do corredor (a área redonda
        // que o VFX desenha e que a peça 3D ergue). Sem isto o impacto era só
        // animação — quem estava exatamente no ponto de saída não levava nada.
        if (attack.eruptRadius) {
          const ex = cast.x + uX * reach, ez = cast.z + uZ * reach;
          const ddx = px - ex, ddz = pz - ez;
          return ddx * ddx + ddz * ddz <= attack.eruptRadius * attack.eruptRadius;
        }
        return false;
      }

      case 'targeted_aoe': {
        const dx = px - tx, dz = pz - tz;
        return dx * dx + dz * dz <= attack.radius * attack.radius;
      }

      // ── Formas do bestiário ──────────────────────────────────────────────
      // Sem estes casos o `default: return false` fazia os 9 bichos novos
      // causarem ZERO dano em qualquer ataque ring/multi/chain/rays — o
      // telegraph aparecia, a animação rodava, e nada acontecia.
      // A geometria é a MESMA do MonsterSkillManager (fonte única): o ataque
      // do bicho e a relíquia dele acertam exatamente igual.
      case 'ring':
      case 'multi':
      case 'rays': {
        const origin = (attack.shape === 'ring' || attack.shape === 'multi')
          ? { x: tx, z: tz }        // centrado no alvo
          : { x: cast.x, z: cast.z }; // coroa gira em volta do PRÓPRIO bicho
        let sdef = attack;
        if (attack.shape === 'rays') {
          // A coroa gira DURANTE a salva inteira, não só até o fim do cast.
          // Congelar o tempo em `castTime` deixava o dano parado no ângulo da
          // 1ª leva enquanto o desenho continuava rodando: na 10ª leva já eram
          // 45° de defasagem, com raios de 22° em intervalos de 60° — ou seja,
          // o dano caía exatamente na BRECHA que o jogador estava usando.
          //
          // `_tickIndex` (o mesmo canal do Sonar e da Barragem) dá a leva atual;
          // a conta passa a ser idêntica à do caminho da relíquia.
          const stepMs = attack.ticks ? (attack.ticks.intervalMs || 250) : 0;
          const tSec = ((attack.castTime || 800)
                     + (attack._tickIndex || 0) * stepMs) / 1000;
          sdef = { ...attack, _spinNow: MonsterSkillManager.crownSpin(
            attack, tSec, tx - cast.x, tz - cast.z) };
        }
        return MonsterSkillManager.inShape(
          sdef, attack.shape, origin.x, origin.z, 0, 0, cast._castPoints, player);
      }

      case 'chain': {
        // A cadeia é resolvida por proximidade em _resolveAttack (precisa da
        // lista inteira); aqui só o 1º elo, em volta do ponto do cast.
        const dx = px - tx, dz = pz - tz;
        const r = (attack.radius || 20) + (attack.jumpRange || 90);
        return dx * dx + dz * dz <= r * r;
      }

      default:
        return false;
    }
  }

  // ── Tick de auras passivas ────────────────────────────────────────────────────

  tickAuras(npc, allPlayers, mapLevel) {
    if (!npc.auras?.length) return;
    const now = Date.now();
    if (!npc._auraTicks) npc._auraTicks = {};

    for (const auraId of npc.auras) {
      const auraDef = ATTACK_DEFS[auraId];
      if (!auraDef || auraDef.shape !== 'aura') continue;

      const tickRate = auraDef.tickRate || 1000;
      if (now - (npc._auraTicks[auraId] || 0) < tickRate) continue;
      npc._auraTicks[auraId] = now;

      const radius = auraDef.radius || 200;
      const _auraNow = Date.now();
      const mapPlayers = allPlayers.filter(p =>
        p.mapLevel === mapLevel && !p.dead && !(p.safeUntil && _auraNow < p.safeUntil)
      );
      const hits = [];

      for (const p of mapPlayers) {
        const dx = p.x - npc.x, dz = p.z - npc.z;
        if (dx * dx + dz * dz > radius * radius) continue;

        // Aplica efeitos de debuff
        if (auraDef.effects?.length) {
          if (!p.activeDebuffs) p.activeDebuffs = [];
          for (const eff of auraDef.effects) {
            p.activeDebuffs = p.activeDebuffs.filter(d => d.type !== eff.type);
            p.activeDebuffs.push({ type: eff.type, value: eff.value, expiresAt: now + eff.duration });
          }
          hits.push({ id: p.id });
        }
      }

      if (hits.length) {
        this.addEvent({
          type:     'aura_tick',
          npcId:    npc.id,
          auraId,
          radius,
          // x/z = centro da aura (o próprio boss, que se move). O cliente desenha
          // a borda com isto — sem a borda o jogador não tem como decidir entre
          // ficar dentro e sair, que é a mecânica inteira.
          x:        npc.x,
          z:        npc.z,
          color:    auraDef.telegraph?.color,
          effects:  auraDef.effects,
          hits:     hits.map(h => h.id),
        }, mapLevel);
      }
    }
  }

}

module.exports = AttackManager;
