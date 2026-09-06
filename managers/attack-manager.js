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
const { isInvincible, isSafeAfterRespawn } = require('../utils/invincibility');
const { applyGoldShield } = require('../utils/gold-shield');
// Geometria compartilhada com as relíquias do bestiário: o ataque do bicho e a
// relíquia que ele dropa precisam acertar EXATAMENTE a mesma área.
const MonsterSkillManager = require('./monster-skill-manager');
const shield = require('../utils/shield');
const { sonarSweep } = require('../utils/sonar-sweep');

/**
 * Specials que rodam o PROPRIO relogio depois do cast.
 *
 * O laco de `ticks` do _beginCast chama _resolveAttack uma vez por leva. Para
 * quem simula a si mesmo isso abriria uma simulacao INTEIRA por leva — oito
 * apertos de arena sobrepostos, cinco ninhadas, cinco cargas de 5 s. Eles
 * resolvem uma vez so e se agendam por dentro.
 *
 * Entrar aqui e obrigatorio ao criar um special com timeline propria. Esquecer
 * nao da erro: da a skill acontecendo N vezes.
 */
const SELF_RUN = new Set([
  'orb', 'sonar', 'collapse', 'charge', 'summons', 'torpedo',
  // `swallow` entrou tarde e pagou o preco descrito acima: o _runSwallow ja
  // agenda as proprias 5 levas, e o laco de fora o chamava 5 vezes. Eram CINCO
  // bocarras sobrepostas por cast — 25 levas de dano no lugar de 5, cinco
  // presas escolhidas em janelas diferentes e cinco cuspidas. Do lado de quem
  // apanhava a leitura era so ruido: a area redecidia a cada 400 ms enquanto o
  // desenho ficava parado. Ver _runSwallow.
  'swallow',
]);

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
    // Sonar: as ondas correm por (rings-1)*intervalo + expansao da ultima. A
    // ultima faixa da varredura pode cair depois de `expandMs` (ver
    // utils/sonar-sweep.js) — quem manda e a que terminar por ultimo.
    if (attack.special === 'sonar') {
      const rings = attack.ringCount || count;
      const corrida = Math.max(attack.expandMs || 1600, sonarSweep(attack).endMs);
      busy = Math.max(busy, (rings - 1) * step + corrida);
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
    // Bocarra: a presa fica presa por `holdMs` e só é cuspida no fim. Abrir
    // outro golpe com alguém ainda dentro do peito é o bicho fazendo duas
    // coisas ao mesmo tempo — e o hold é MAIOR que a canalizada (2000 > 1600).
    if (attack.special === 'swallow') {
      busy = Math.max(busy, attack.holdMs || 2000);
    }
    // Faróis de Carne: as luzes existem no mundo até implodir, igual à orbe. O
    // arauto fica ocupado esse tempo todo de propósito — abrir outro golpe por
    // cima de três projéteis em voo apagaria a leitura de todos.
    if (attack.special === 'lights') {
      busy = Math.max(busy, attack.lifeMs || 5000);
    }
    // Cadeia: o 1º elo sai no fim do cast, os demais de `jumpCastMs` em
    // `jumpCastMs`.
    if (attack.shape === 'chain') {
      busy = Math.max(busy,
        (Math.max(1, attack.count || 3) - 1) * (attack.jumpCastMs || 550));
    }
    // Anel que aperta: o miôlo explode DEPOIS da última leva do aperto, então a
    // ocupação é uma leva a mais que a canalizada comum.
    if (attack.special === 'collapse') {
      busy = Math.max(busy, count * step);
    }
    // Invocações: as criaturas existem no mar até alcançar alguém ou expirar.
    // A ESCOLTA é a exceção — ela não tem relógio próprio, fica esperando o
    // bicho acertar, e prender o bicho por 10 s esperando seria travar o chefe.
    if (attack.special === 'summons' && attack.summonMode !== 'escort') {
      busy = Math.max(busy, attack.lifeMs || 5000);
    }
    // Torpedos: a última saída da salva mais o voo dela.
    if (attack.special === 'torpedo') {
      busy = Math.max(busy, (Math.max(1, attack.count || 6) - 1) * (attack.salvoMs || 150)
                            + (attack.travelMs || 480));
    }
    // Carga: o bicho fica preso os 5 s inteiros — é a janela em que atirar
    // nele CANCELA o golpe, e abrir outra skill por cima apagaria essa leitura.
    if (attack.special === 'charge') {
      busy = Math.max(busy, attack.chargeMs || 5000);
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
    if (isSafeAfterRespawn(target)) return; // imunidade pós-respawn
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
    // Memória do último golpe: é o que o Espelho do Córtex copia quando a
    // relíquia é usada CONTRA este bicho. Sem gravar, o espelho do jogador não
    // teria o que ler e cairia sempre no golpe de reserva.
    npc._lastAttackId = attack.id;

    // Para all_players_in_range: trava posição de TODOS os jogadores no alcance
    let multiTargets = null;
    if (attack.targetMode === 'all_players_in_range') {
      const range = attack.rangeMax || 320;
      const _now = Date.now();
      const inRange = allPlayers.filter(p =>
        p.mapLevel === mapLevel && !p.dead &&
        !isSafeAfterRespawn(p, _now) && dist2D(npc, p) <= range
      );
      if (inRange.length > 0) {
        // `maxTargets`: teto de marcações simultâneas (Pilares do Juízo: 8).
        // Sem ele, arena cheia = uma coluna por jogador, e o mesmo frame sairia
        // com 20 telegraphs. Os mais PERTO ganham as colunas — é o chefe
        // escolhendo quem está no colo dele, não um sorteio.
        const max = attack.maxTargets || 0;
        if (max > 0 && inRange.length > max) {
          inRange.sort((a, b) => dist2D(npc, a) - dist2D(npc, b));
          inRange.length = max;
        }
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

    // Mira viva das canalizadas com cap de giro (`turnRate`): comeca na direcao
    // que o TELEGRAPH mostrou. Sem esta semente o 1o tick ja saltaria para cima
    // do alvo — era metade da queixa ("assim que solta, vai insta no jogador").
    npc._aimAngle = Math.atan2(targetZ - npc.z, targetX - npc.x);

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
      // ── Arauto do Abismo ───────────────────────────────────────────────────
      // Quantas colunas/luzes e as medidas da cela. Mesma regra do resto: o que
      // não sai daqui o cliente desenha com o default da demo.
      maxTargets:   attack.maxTargets,
      lightCount:   attack.lightCount,
      lightSpeed:   attack.lightSpeed,
      wallLength:   attack.wallLength,
      wallThickness: attack.wallThickness,
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
    const selfRun   = SELF_RUN.has(attack.special);
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
          let adx = tx - npc.x, adz = tz - npc.z;
          const al  = Math.hypot(adx, adz) || 1;

          // ── Cap de giro ─────────────────────────────────────────────────
          // Sem isto o feixe re-mirava INSTANTANEAMENTE: saltava do angulo do
          // telegraph para cima do jogador na 1a leva e colava nele ate o fim.
          // Nao havia jogada — so tomar o dano. Com o cap ele varre, e da para
          // sair contornando enquanto a velocidade lateral do barco (~45 un/s)
          // ganhar da do feixe (`turnRate x distancia`).
          if (attack.turnRate) {
            const passo = attack.turnRate * (tickStep || 120) / 1000;
            let diff = Math.atan2(adz, adx) - npc._aimAngle;
            // Normaliza para [-PI, PI]: sem isto o feixe daria a volta pelo
            // caminho longo quando o alvo cruzasse o -180.
            diff = Math.atan2(Math.sin(diff), Math.cos(diff));
            npc._aimAngle += Math.max(-passo, Math.min(passo, diff));
            adx = Math.cos(npc._aimAngle);
            adz = Math.sin(npc._aimAngle);
            // O alvo efetivo passa a ser PARA ONDE O FEIXE APONTA — e daqui que
            // o `_isHit` tira a direcao do corredor.
            tx = npc.x + adx * al;
            tz = npc.z + adz * al;
          }

          this.addEvent({
            type: 'npc_skill_aim',
            npcId: npc.id,
            npcX:  npc.x,
            npcZ:  npc.z,
            dirX:  attack.turnRate ? adx : adx / al,
            dirZ:  attack.turnRate ? adz : adz / al,
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

    // ── Os specials que o BICHO declarava e nunca executava ─────────────
    // O dado destas skills sempre trouxe `special`, `phaseCount`, `fuseMs`,
    // `chargeMs`, `pairCount` — e este motor não tinha branch nenhum para eles.
    // `special` sem branch NÃO DÁ ERRO: cai na resolução comum e vira um círculo
    // ou um aro parado. É por isso que o Carniceiro do Ossuário, cujas QUATRO
    // skills caem aqui, parecia estar usando as versões antigas de tudo: ele
    // nunca chegou a usar versão nenhuma. Ver a nota gorda no _runCollapsingRing.
    //
    // Os `_*Burst` são guardas de reentrância: cada um destes métodos volta a
    // chamar _resolveAttack para aplicar o dano pelo caminho comum (escudo,
    // pet, carapaça, morte), e sem a marca ele se re-lançaria em loop.
    if (attack.special === 'collapse' && !attack._collapseStep) {
      this._runCollapsingRing(npc, attack, targetX, targetZ, allPlayers, mapLevel);
      return;
    }
    if (attack.special === 'summons' && !attack._summonHit) {
      this._runSummons(npc, attack, targetX, targetZ, allPlayers, mapLevel);
      return;
    }
    if (attack.special === 'torpedo' && !attack._torpedoHit) {
      this._runTorpedoes(npc, attack, targetX, targetZ, allPlayers, mapLevel);
      return;
    }
    if (attack.special === 'charge' && !attack._chargeBurst) {
      this._runCharge(npc, attack, targetX, targetZ, allPlayers, mapLevel);
      return;
    }

    // Chuva de destrocos: uma queda por vez, mirada ao vivo. Ver _runWreckRain.
    if (attack.dropIntervalMs && !attack._drop) {
      this._runWreckRain(npc, attack, allPlayers, mapLevel);
      return;
    }

    // Farois de Carne: as luzes VOAM atras dos alvos e implodem no fim.
    // `_lightBurst` marca a resolucao da implosao la na frente, senao ela cairia
    // aqui de novo e a skill se re-lancaria em loop. Ver _runHunterLights.
    if (attack.special === 'lights' && !attack._lightBurst) {
      this._runHunterLights(npc, attack, allPlayers, mapLevel);
      return;
    }

    // Prisao de Terra: nao ha dano nenhum, so as 4 paredes. Ver _raisePrisonWalls.
    if (attack.special === 'prison') {
      this._raisePrisonWalls(npc, attack, targetX, targetZ, mapLevel);
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

    // ── Bocarra Torácica: ENGOLE uma vítima ────────────────────────────────
    // Espelha o `_castSwallow` do motor da relíquia: prende (stunExpires), cola
    // a presa no bicho leva a leva e CUSPE para trás no fim.
    if (attack.special === 'swallow') {
      this._runSwallow(npc, attack, allPlayers, mapLevel);
      return;
    }

    // ── Espelho do Córtex: copia o último golpe do ALVO ────────────────────
    // O boss lê `player._lastRelicSkill` (gravado no handleUseRelic) e relança a
    // versão DE BICHO daquela skill. Guard de recursão: espelho não copia
    // espelho, senão dois deles em cena travam o servidor.
    if (attack.special === 'mirror' && !attack._mirrored) {
      this._runMirror(npc, attack, targetX, targetZ, allPlayers, mapLevel);
      return;
    }

    // ── Carapaça Eriçada: AUTO-BUFF, não ataque ────────────────────────────
    // O `special: 'bulwark'` não tinha implementação nenhuma aqui. O bicho
    // levantava as placas no desenho e caía na resolução comum: um círculo de
    // raio 70 com `damageMult: 0`, ou seja o 1 de dano do piso e nada mais.
    // Nem mitigava, nem refletia — a skill inteira era enfeite.
    //
    // Os campos são os MESMOS que a relíquia r32 põe no jogador
    // (relicBulwark*), porque quem lê o buff na hora do dano é código
    // compartilhado — ver projectile-manager.hit() e o laço de acerto aqui.
    // ── Névoa Espectral: o arauto se DESFAZ ──────────────────────────────────
    // Mesmo efeito da relíquia r2, do lado do bicho: por `holdMs` nada o
    // machuca (ver o guard de `phaseUntil` no projectile-manager e no
    // monster-skill-manager). Não é uma defensiva passiva — é uma janela em que
    // atirar é desperdiçar munição, e a resposta certa é reposicionar.
    //
    // Reaproveita o VFX e o evento `relic_effect` da r2: o cliente já sabe
    // desenhar 'invincible' em qualquer entidade, jogador ou bicho.
    if (attack.special === 'phase') {
      const dur = attack.holdMs || attack.durationMs || 5000;
      npc.phaseUntil = Date.now() + dur;
      this.addEvent({
        type: 'relic_effect', casterId: npc.id, effect: 'invincible',
        vfx: attack.vfx, skill: attack.skill, duration: dur,
      }, mapLevel);
      return;
    }

    if (attack.special === 'bulwark') {
      npc.relicBulwarkExpires   = Date.now() + (attack.durationMs || 5000);
      npc.relicBulwarkReduction = attack.damageReduction || 0.4;
      npc.relicBulwarkReflect   = attack.reflectPct || 0.3;
      this.addEvent({
        type: 'relic_effect', casterId: npc.id, effect: 'bulwark',
        vfx: attack.vfx, skill: attack.skill, duration: attack.durationMs || 5000,
      }, mapLevel);
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
      p.mapLevel === mapLevel && !p.dead && !isSafeAfterRespawn(p, _hitNow)
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
        // ── Onda que VARRE: uma parede, um acerto ────────────────────────
        // O Sonar amostra a MESMA onda nove vezes enquanto ela corre. Que ela
        // não pudesse cobrar duas vezes era um acidente da aritmética (as
        // faixas não se sobrepunham) e só valia para quem estava PARADO: fugir
        // para fora junto com a parede mantinha o barco dentro dela por vários
        // passos. O conjunto é por ONDA e nasce no _runSonar.
        if (attack._sweepSeen) {
          if (attack._sweepSeen.has(p.id)) continue;
          attack._sweepSeen.add(p.id);
        }
        // Névoa Espectral: invencível bloqueia também ataques em área
        // (antes só projéteis respeitavam — necessário para a defensiva do pet).
        if (isInvincible(p, _hitNow)) {
          this.addEvent({ type: 'shield_block', targetId: p.id }, mapLevel);
          continue;
        }
        // ── `damageMult: 0` é "não machuca", não "machuca 1" ──────────────────
        // O piso de 1 existe para um golpe REAL nunca arredondar para zero. Mas
        // ele também fabricava dano onde o dado diz que não há: a Carapaça
        // Eriçada (auto-buff) e a Jaula de Patas (só obstáculos) declaram
        // `damageMult: 0` e mesmo assim tiravam 1 de vida de todo mundo no raio
        // — era o "tomo 1 de dano fixo e depois mais nada" do playtest. O piso
        // agora só vale quando existe multiplicador para pisar.
        let dmg = attack.damageMult > 0
          ? Math.max(1, Math.floor((npc.cannonDmg || 1) * attack.damageMult / splitDiv))
          : 0;
        // Aplica debuff de defesa se ativo
        const defDebuff = p.activeDebuffs?.find(d => d.type === 'defense_buff' && d.expiresAt > Date.now());
        if (defDebuff) dmg = Math.round(dmg * (1 + Math.abs(defDebuff.value)));
        // ── Habilidade Defesa (Capitão → Habilidades) ──────────────────────
        // Ela reduzia o TIRO (o projectile-manager sempre a aplicou) e não
        // reduzia nada do bestiário — que é a maior parte do dano que um
        // jogador leva de bicho. Do lado de quem sobe a habilidade isso lia
        // como "o número não faz nada": vinte níveis de Defesa e o mesmo
        // estrago da investida, do morteiro e de toda skill de área.
        //
        // Só a habilidade entra aqui. A redução de TALENTO e a plana da
        // Carapaça de Kraken continuam de fora deste caminho de propósito —
        // ligá-las junto mexe no balanço de todo bicho do jogo de uma vez, e é
        // a leva de balanceamento que a nota do utils/player-defense.js
        // descreve. Uma coisa de cada vez.
        if (p.skillDefense > 0) dmg = Math.round(dmg * (1 - p.skillDefense));
        // Escudo de Ouro (r5): mesma conta dos outros dois caminhos de dano —
        // ver utils/gold-shield.js.
        {
          const esc = applyGoldShield(p, dmg);
          dmg = esc.damage;
          if (esc.goldCost > 0) {
            this.addEvent({ type: 'gold_shield_cost', targetId: p.id, goldCost: esc.goldCost, gold: p.gold }, mapLevel);
            this.journal?.accrue(p, 'gold_shield', { gold: -esc.goldCost });
          }
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
        p.hp = Math.max(0, p.hp - shield.absorb(p, dmg).dmg);
        p.lastCombatTime = Date.now();

        // Roubo de ouro (goldStealRatio definido no MAP_DEFS do mapa)
        let goldStolen = 0;
        if (goldStealRatio > 0 && dmg > 0) {
          goldStolen = Math.max(1, Math.floor(dmg * goldStealRatio));
          p.gold     = Math.max(0, (p.gold || 0) - goldStolen);
          this.journal?.accrue(p, 'gold_stolen', { gold: -goldStolen });
        }

        hits.push({ id: p.id, hp: p.hp, dmg, goldStolen });

        // Escolta de Ossos: o bicho acertou — as caveiras saltam. Este é o
        // ÚNICO funil de dano do bestiario (os chefes de skill não atiram
        // canhão), então um gancho aqui cobre a promessa inteira. O guarda de
        // reentrância mora no notifyNpcHit: o próprio salto passa por aqui.
        if (dmg > 0 && npc._summonEscort) this.notifyNpcHit(npc, p, mapLevel);

        // ── Coro dos Rostos: SILÊNCIO ──────────────────────────────────────
        // Trava o uso de relíquia (lido por handleUseRelic). Curto de propósito
        // — o jogador continua navegando e atirando de canhão.
        // O `special: 'silence'` saiu do dado quando o Coro convergiu
        // (2026-09-05): silêncio nunca foi um jeito de RESOLVER área, é um
        // debuff no acerto — e amarrado ao `special` ele morreria junto com a
        // convergência, levando um eixo inteiro do conjunto alienígena embora.
        // Agora quem o aplica é cada rosto que encosta em você.
        if (attack.silenceMs) {
          p._silencedUntil = Math.max(p._silencedUntil || 0, Date.now() + attack.silenceMs);
          this.addEvent({ type: 'silenced', targetId: p.id, durationMs: attack.silenceMs },
                        mapLevel);
        }

        // ── Sorvo sem Olhos: queima MANA em vez de vida ────────────────────
        if (attack.special === 'manaburn' && attack.manaBurn) {
          const antes = p.mana || 0;
          p.mana = Math.max(0, antes - attack.manaBurn);
          const perdeu = antes - p.mana;
          if (perdeu > 0) {
            this.addEvent({
              type: 'mana_burn', targetId: p.id, amount: perdeu,
              mana: p.mana, maxMana: p.maxMana,
            }, mapLevel);
          }
        }

        // Morte do jogador — ruína saqueável e tela de morte saem de
        // resolvePlayerDeath (server.js), o mesmo caminho do PvP. Killer é um
        // NPC, então nada é creditado a ninguém.
        if (this.onPlayerKilled) this.onPlayerKilled(p, npc.id);

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

    // ── Sanguessuga: parte do dano volta como VIDA ─────────────────────
    // Espelha o `special: 'drain'` do motor da relíquia. Do lado do bicho ele
    // não existia: o Sorvo da Tartaruga e a Tripa do Alígena declaravam
    // `drainHealPct` e nunca curavam um ponto — a mecânica que dá nome à skill
    // (e que faz o jogador ter de SAIR da poça em vez de trocar dano) era só
    // desenho. É também o que torna a corrida de dano do chefe uma decisão.
    if (attack.special === 'drain' && hits.length > 0 && !npc.dead) {
      const sorvido = hits.reduce((s, h) => s + (h.dmg || 0), 0);
      const cura = Math.round(sorvido * (attack.drainHealPct || 0.5));
      if (cura > 0) {
        const antes = npc.hp;
        npc.hp = Math.min(npc.maxHp || npc.hp, npc.hp + cura);
        // Só anuncia o que ENTROU: com a vida cheia a skill continua doendo,
        // mas mostrar "+0" faria parecer que ela curou quando não curou.
        if (npc.hp > antes) {
          this.addEvent({
            type: 'npc_drain_heal', npcId: npc.id, amount: npc.hp - antes,
            hp: npc.hp, maxHp: npc.maxHp, vfx: attack.vfx,
          }, mapLevel);
        }
      }
    }

    // A simulacao fina do Sonar roda dezenas de passos por cast; anunciar leva
    // vazia enche a rede e faz o cliente contar levas que nao aconteceram.
    // `_quiet`: mesma história para os passos do aperto, os ovos e a corrente —
    // eles resolvem dezenas de vezes e a maioria não pega ninguém.
    if ((attack._frontRadius != null || attack._frontDistance != null || attack._quiet)
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
   * `setTimeout` que se RETIRA da lista quando dispara.
   *
   * `npc._tickTimers` é o que o cancelCast limpa quando o bicho morre no meio
   * de uma canalizada. Empilhar sem tirar faz a lista crescer a cada golpe pela
   * vida inteira do chefe — e o cancelCast passa a varrer milhares de ids
   * mortos. O resto do arquivo já faz esse `filter` à mão em cada agendamento;
   * os cinco specials novos usam este atalho em vez de repetir a linha oito
   * vezes.
   */
  _agenda(npc, fn, ms) {
    const t = setTimeout(() => {
      if (npc._tickTimers) npc._tickTimers = npc._tickTimers.filter(x => x !== t);
      fn();
    }, ms);
    (npc._tickTimers ||= []).push(t);
    return t;
  }

  /**
   * Anel que APERTA (`special: 'collapse'`) — Espiral do Abismo e Marcha Fúnebre.
   *
   * Este é o golpe que o playtest pegou: o bicho declarava `collapse`,
   * `phaseCount`, `finalRadius` e `collapseRadius`, e este motor não tinha
   * nenhum branch para eles. Sem branch a skill não falha — ela cai na
   * resolução comum e vira um ARO PARADO no raio inicial. Num raio de 320 isso
   * quer dizer uma coroa finíssima lá na borda: quem lutava com o chefe ficava
   * perto dele, no meio, e a lendária dele não encostava em ninguém.
   *
   * O aperto acontece em `phaseCount` PASSOS, não numa rampa contínua — é o
   * compasso que o desenho 2D mostra e o que dá tempo de ler para onde correr.
   * Cada leva cobra a ÁREA VARRIDA (do raio anterior até o de agora), não uma
   * faixa fina: com faixa fina um passo de 60 un sobre uma banda de 12 deixaria
   * 80% do caminho sem tocar em nada. A geometria é a MESMA do lado da
   * relíquia (_castCollapsingRing), de propósito.
   *
   * O que é DIFERENTE do lado do bicho, e de propósito: o `damageMult` do dado
   * é o dano POR LEVA, e aqui as levas passaram a acertar de verdade. Os
   * números antigos (5,0 × 8) valiam enquanto quase nenhuma pegava; cobradas
   * todas seriam 40× o canhão do bicho num golpe só. Por isso a face do bicho
   * ganhou `burstMult`: leva barata, miúlo caro — a mesma proporção que a
   * relíquia já usava entre `ticks.pct` e `damagePct`.
   */
  _runCollapsingRing(npc, attack, targetX, targetZ, allPlayers, mapLevel) {
    const ticks  = attack.ticks || { count: 8, intervalMs: 500 };
    const total  = Math.max(1, ticks.count || 8);
    const step   = ticks.intervalMs || 500;
    const deR    = attack.radius || 200;
    const ateR   = attack.collapseTo || attack.finalRadius || attack.eruptRadius || 60;
    const banda  = attack.band || Math.max(12, (deR - ateR) / total);
    const passos = Math.max(1, attack.phaseCount || total);
    // Último PASSO em que a coroa de espinhos foi (re)plantada. -1 = nenhum.
    let passoPlantado = -1;

    for (let i = 0; i < total; i++) {
      this._agenda(npc, () => {
        if (npc.dead) return;
        const passo = passos === 1 ? 0 : Math.floor((i * passos) / total) / (passos - 1);
        const raio  = deR + (ateR - deR) * Math.min(1, passo);
        // Onde a parede estava no passo ANTERIOR — no primeiro ela vem de fora.
        const passoAnt = passos === 1 ? 0
          : Math.max(0, Math.floor((i * passos) / total) - 1) / (passos - 1);
        const raioAnt = i === 0 ? deR : deR + (ateR - deR) * Math.min(1, passoAnt);

        this._resolveAttack(npc, {
          ...attack,
          shape: 'ring',
          radius: Math.max(raioAnt, raio) + banda / 2,
          safeRadius: Math.max(0, raio - banda / 2),
          _collapseStep: true, _quiet: true, _tickIndex: i,
        }, targetX, targetZ, allPlayers, mapLevel);

        // ── Espinhos TANGÍVEIS ────────────────────────────────────
        // As mesmas caixas do Muro de Pedra e da Jaula, respeitadas por jogador
        // e por bicho no mesmo ponto de colisão. Plantadas uma vez por PASSO
        // (não por leva): reposicionar uma dúzia de caixas a cada 500 ms dá
        // tranco no barco. Elas expiram sozinhas no fim do passo — ninguém
        // fica preso depois que o golpe acaba.
        //
        // O ÚLTIMO passo NÃO planta: é a janela que a descrição promete ("saia do
        // centro no fim"). Com a coroa selada até o último instante, o miúlo
        // vira dano garantido e a skill deixa de ter jogada — só aperta e
        // cobra. Sem a última coroa sobra ~1 s para remar os ~45 un que
        // separam a borda de dentro do raio da explosão. É apertado de
        // propósito: é a ⭐ do chefe final.
        const passoIdx = Math.floor((i * passos) / total);
        if (attack.tangible && this.wallManager && passoIdx !== passoPlantado
            && passoIdx < passos - 1) {
          passoPlantado = passoIdx;
          const n = Math.max(6, Math.min(24, attack.spikeCount || 14));
          // Meia-largura que SELA o anel: o arco entre dois vizinhos (2πR/n)
          // tem de caber no comprimento de um. O 1,06 é a folga contra o
          // vazamento fino na quina de duas caixas.
          const meia = (Math.PI * raio / n) * 1.06;
          const esp  = Math.max(3, banda * 0.25);
          const dura = Math.ceil((step * total) / Math.max(1, passos)) + 150;
          const stamp = Date.now();
          for (let k = 0; k < n; k++) {
            const a = (k / n) * Math.PI * 2;
            // Tangente ao círculo: o eixo do COMPRIMENTO da caixa é
            // basis.x = (cos rot, −sin rot); igualar a (−sin a, cos a) dá
            // rot = −(a + π/2). Errar aqui põe os espinhos radiais e o anel vaza.
            this.wallManager.addWall(mapLevel, {
              id: 'collapse_' + npc.id + '_' + stamp + '_' + k,
              x: targetX + Math.cos(a) * raio, z: targetZ + Math.sin(a) * raio,
              hw: meia, hh: esp, rot: -(a + Math.PI / 2), durationMs: dura,
            });
          }
        }

        // ── E o empurrão ────────────────────────────────────────
        // Quem ficou além do anel é trazido para a borda de dentro. Os dois se
        // completam em vez de competir: o empurrão É o aperto, a parede é o que
        // impede de sair de novo.
        const agora = Date.now();
        const empurrados = [];
        for (const pl of allPlayers) {
          if (pl.mapLevel !== mapLevel || pl.dead) continue;
          if (isSafeAfterRespawn(pl, agora) || isInvincible(pl, agora)) continue;
          const dx = pl.x - targetX, dz = pl.z - targetZ;
          const d = Math.hypot(dx, dz);
          if (d <= raio || d > deR + banda * 2 || d < 0.001) continue;
          pl.x = targetX + (dx / d) * raio;
          pl.z = targetZ + (dz / d) * raio;
          empurrados.push({ id: pl.id, x: pl.x, z: pl.z });
        }

        // Mesmo evento do lado da relíquia: o cliente já sabe desenhar o aro
        // fechando e o rastro de quem foi arrastado, e não liga se o `casterId`
        // é de um jogador ou de um bicho.
        this.addEvent({
          type: 'relic_collapse_step', casterId: npc.id, skill: attack.skill,
          vfx: attack.vfx, originX: targetX, originZ: targetZ,
          radius: raio, band: banda, step: i, stepCount: total,
          pushed: empurrados,
        }, mapLevel);
      }, i * step);
    }

    // ── O miúlo ──────────────────────────────────────────────
    // A explosão central que a descrição sempre prometeu. `burstMult` no lugar
    // de `damageMult`: o aperto foi o preço de chegar até aqui, o miúlo é O golpe.
    if (attack.burstAtCenter) {
      this._agenda(npc, () => {
        if (npc.dead) return;
        const raio = attack.collapseRadius || attack.eruptRadius || ateR;
        this._resolveAttack(npc, {
          ...attack, shape: 'circle', radius: raio, safeRadius: 0,
          damageMult: attack.burstMult || attack.damageMult,
          _collapseStep: true,
        }, targetX, targetZ, allPlayers, mapLevel);
        this.addEvent({
          type: 'relic_collapse_burst', casterId: npc.id, skill: attack.skill,
          vfx: attack.vfx, originX: targetX, originZ: targetZ, radius: raio,
        }, mapLevel);
      }, total * step);
    }
  }

  /**
   * BICHOS INVOCADOS (`special: 'summons'`) — quatro leituras, um motor só.
   *
   * Espelho do `_castSummons` do lado da relíquia. O golpe não é uma forma que
   * resolve num instante: são CRIATURAS que existem no mar por alguns segundos,
   * andam por conta própria e batem quando encostam. Isso troca a pergunta que a
   * skill faz — de "onde vai cair?" para "para onde eu corro agora?".
   *
   *   hunt    — nascem no casco do bicho e CAÇAM o jogador mais perto.
   *   ambush  — nascem espalhadas e ficam PARADAS; só investem quando alguém
   *             entra no `triggerRadius`. Vira campo minado com paciência.
   *   volley  — saem do casco em salva e voam no alvo mais perto de uma vez.
   *   escort  — ficam em órbita do bicho e só saltam quando ELE acerta alguém
   *             (ver notifyNpcHit). Não tem relógio próprio.
   *
   * Três mecanicas só do bicho morreram para isto nascer (`mark`, `brood`,
   * `bond`, 2026-09-05): eram as versões ANTIGAS destas mesmas três skills, de
   * quando as duas faces divergiam. Estão no git — decisão do Luang de que o
   * bestiario inteiro mostre a mesma skill que a relíquia dele entrega.
   *
   * O alvo é reavaliado a cada leva, então a criatura não "trava" numa presa que
   * morreu: procura outra. E o cliente só DESENHA — a posição chega em
   * `relic_summon_move`, a mesma divisão da Orbe e dos Faróis de Carne. Os
   * eventos são os MESMOS da relíquia: o handler do cliente não liga se o
   * `casterId` é jogador ou bicho.
   */
  _runSummons(npc, attack, targetX, targetZ, allPlayers, mapLevel) {
    if ((attack.summonMode || 'hunt') === 'escort') {
      return this._armSummonEscort(npc, attack, mapLevel);
    }
    const modo    = attack.summonMode || 'hunt';
    const n       = Math.max(1, attack.count || 3);
    const tickMs  = attack.summonTickMs || 180;
    const life    = attack.lifeMs || 5000;
    const speed   = attack.moveSpeed || 55;
    const raio    = attack.radius || 20;
    const catchR  = attack.catchRadius || 14;
    const gatilho = attack.triggerRadius || 45;
    const spread  = attack.spread || 0;

    // De onde nascem: o mar apontado (emboscada) ou o próprio casco. A salva
    // sempre sai de dentro do bicho; a caçada também, quando o dado pede
    // (`spawnAtCaster`) — numa skill cuja graça é a PERSEGUIÇÃO, nascer longe
    // troca a ameaça por um teste de pontaria que a skill nem quer cobrar.
    const noCasco = modo === 'volley' || attack.spawnAtCaster;
    const ox = noCasco ? npc.x : targetX;
    const oz = noCasco ? npc.z : targetZ;

    for (let i = 0; i < n; i++) {
      const ang  = (i / n) * Math.PI * 2 + Math.random() * 0.5;
      const dist = spread > 0 ? spread * Math.sqrt(0.25 + Math.random() * 0.75) : 0;
      const cria = {
        x: ox + Math.cos(ang) * dist,
        z: oz + Math.sin(ang) * dist,
        // A emboscada nasce DORMINDO — ela não persegue, ela espera.
        acordada: modo !== 'ambush',
        fim: 0,
      };

      const fim = (bateu) => {
        this.addEvent({
          type: 'relic_summon_end', casterId: npc.id, index: i,
          skill: attack.skill, vfx: attack.vfx, x: cria.x, z: cria.z,
          radius: raio, hit: !!bateu,
        }, mapLevel);
      };

      const bater = () => {
        // Chance de atordoar POR CRIATURA (o Coro): é sorteio por rosto, não um
        // stun garantido. Entra pelo `cc` porque é o caminho que já respeita a
        // convenção de quem pode e quem não pode ser atordoado.
        const azar = attack.stunChance > 0 && Math.random() < attack.stunChance;
        this._resolveAttack(npc, {
          ...attack, shape: 'circle', radius: raio, _summonHit: true, _quiet: true,
          cc: azar ? { ...(attack.cc || {}), stunMs: attack.stunMs || 900 } : attack.cc,
        }, cria.x, cria.z, allPlayers, mapLevel);
      };

      const passo = () => {
        if (npc.dead || (this.pm?.npcs && !this.pm.npcs.has(npc.id))) return;
        if (Date.now() >= cria.fim) return fim(false);

        let alvo = null, melhor = Infinity;
        const agora = Date.now();
        for (const pl of allPlayers) {
          if (pl.mapLevel !== mapLevel || pl.dead) continue;
          if (isSafeAfterRespawn(pl, agora) || isInvincible(pl, agora)) continue;
          const d = Math.hypot(pl.x - cria.x, pl.z - cria.z);
          if (d < melhor) { melhor = d; alvo = pl; }
        }

        // Emboscada: acorda quando alguém chega perto o bastante — e aí não
        // dorme mais, mesmo que o sujeito se afaste.
        if (alvo && !cria.acordada && melhor <= gatilho) cria.acordada = true;

        if (alvo && cria.acordada) {
          const dx = alvo.x - cria.x, dz = alvo.z - cria.z;
          const d  = Math.hypot(dx, dz) || 1;
          const avanco = speed * (tickMs / 1000);
          if (d <= avanco || d <= catchR) {
            cria.x = alvo.x; cria.z = alvo.z;
            bater();
            return fim(true);
          }
          cria.x += (dx / d) * avanco;
          cria.z += (dz / d) * avanco;
        }
        this.addEvent({
          type: 'relic_summon_move', casterId: npc.id, index: i,
          x: cria.x, z: cria.z, awake: cria.acordada,
        }, mapLevel);
        this._agenda(npc, passo, tickMs);
      };

      cria.fim = Date.now() + life;
      this.addEvent({
        type: 'relic_summon_spawn', casterId: npc.id, index: i,
        skill: attack.skill, vfx: attack.vfx, x: cria.x, z: cria.z,
        radius: raio, lifeMs: life, mode: modo, awake: cria.acordada,
      }, mapLevel);
      passo();
    }
  }

  /**
   * ESCOLTA — as criaturas ficam em órbita do bicho esperando ELE acertar.
   *
   * Não têm relógio próprio: a janela (`durationMs`) só começa a contar no
   * PRIMEIRO salto. Do lado do jogador isso é uma decisão (guardar a escolta
   * para a briga certa); do lado do bicho é o que faz a skill ser uma AMEAÇA
   * PENDENTE — enquanto as caveiras estiverem lá, todo golpe dele vale mais, e
   * quem está lutando vê isso na tela antes de sentir.
   *
   * Por isso ela também não entra no `busyMs`: prender o chefe 10 s esperando
   * um acerto que talvez não venha o deixaria parado no meio da luta.
   */
  _armSummonEscort(npc, attack, mapLevel) {
    npc._summonEscort = {
      // Quantas caveiras estão em órbita. NÃO são cargas gastas uma a uma:
      // saltam todas juntas a cada salva (ver notifyNpcHit).
      vivas:     Math.max(1, attack.count || 3),
      janelaMs:  attack.durationMs || 10000,
      recargaMs: attack.leapCooldownMs || 1500,
      expira:    0,          // 0 = a janela ainda nem abriu
      proximo:   0,
      saltando:  false,
      attack,
    };
    this.addEvent({
      type: 'relic_summon_spawn', casterId: npc.id, index: 0,
      skill: attack.skill, vfx: attack.vfx, x: npc.x, z: npc.z,
      radius: attack.radius || 22, orbitRadius: attack.orbitRadius || 26,
      lifeMs: 0, mode: 'escort', count: npc._summonEscort.vivas,
    }, mapLevel);
  }

  /**
   * O bicho acertou alguém — a escolta salta.
   *
   * `saltando` é a trava de reentrância, e não é zelo excessivo: o próprio salto
   * causa dano, que volta ao laço de acerto do _resolveAttack, que chamaria aqui
   * de novo — recursão infinita até a pilha estourar.
   */
  notifyNpcHit(npc, alvo, mapLevel) {
    const e = npc._summonEscort;
    if (!e || e.saltando || e.vivas <= 0) return;
    if (!alvo || alvo.dead || alvo.mapLevel !== mapLevel) return;

    const agora = Date.now();
    // A janela abre AGORA — e só agora.
    if (e.expira === 0) e.expira = agora + e.janelaMs;
    if (agora >= e.expira) { npc._summonEscort = null; return; }
    if (agora < e.proximo) return;

    e.proximo  = agora + e.recargaMs;
    e.saltando = true;
    this.addEvent({
      type: 'relic_summon_leap', casterId: npc.id, skill: e.attack.skill,
      vfx: e.attack.vfx, targetId: alvo.id, x: alvo.x, z: alvo.z,
      count: e.vivas,
    }, mapLevel);
    // As três saltam JUNTAS e o `damageMult` é o dano da SALVA inteira — não de
    // cada caveira, senão o golpe triplicaria de valor junto com a leitura.
    this._resolveAttack(npc, {
      ...e.attack, shape: 'circle', radius: e.attack.radius || 22,
      _summonHit: true, _quiet: true,
    }, alvo.x, alvo.z, [alvo], mapLevel);
    e.saltando = false;
  }

  /**
   * CARDUME DE TORPEDOS (`special: 'torpedo'`): a salva sai do casco em
   * sequência, cada torpedo com voo próprio e mira teleguiada.
   *
   * Espelho do `_castTorpedoes`. O que faz a skill acertar é a RE-MIRA na
   * chegada: o alvo andou durante o voo, e se ele continua perto do ponto
   * anunciado o estouro sai em cima dele. O `homingRadius` é a corda — quem
   * fugiu mais que isso ganhou a corrida, e aí o torpedo estoura onde foi
   * anunciado (o desenho concorda, porque o cliente para de seguir pelo mesmo
   * critério).
   */
  _runTorpedoes(npc, attack, targetX, targetZ, allPlayers, mapLevel) {
    const n       = Math.max(1, attack.count || 6);
    const gapMs   = attack.salvoMs || 150;
    const flyMs   = attack.travelMs || 480;
    const alcance = attack.length || 95;
    const meio    = ((attack.angle || 60) * Math.PI / 180) / 2;
    const leque   = ((attack.fanAngle || 40) * Math.PI / 180) / 2;
    let bdx = targetX - npc.x, bdz = targetZ - npc.z;
    const bl = Math.hypot(bdx, bdz) || 1;
    bdx /= bl; bdz /= bl;
    const base = Math.atan2(bdz, bdx);

    for (let i = 0; i < n; i++) {
      this._agenda(npc, () => {
        if (npc.dead) return;
        const fx = npc.x, fz = npc.z;
        const alvo = this._coneTargetPlayer(fx, fz, bdx, bdz, alcance, meio,
                                            allPlayers, mapLevel);

        // Leque simétrico: 0, +1, -1, +2, -2… normalizado pelo número de tiros.
        const lado = (i % 2 === 0 ? 1 : -1) * Math.ceil(i / 2);
        const ang  = base + (n > 1 ? (lado / Math.ceil(n / 2)) * leque : 0);
        const tx = alvo ? alvo.x : fx + Math.cos(ang) * alcance;
        const tz = alvo ? alvo.z : fz + Math.sin(ang) * alcance;

        this.addEvent({
          type: 'relic_torpedo', casterId: npc.id, skill: attack.skill,
          vfx: attack.vfx, index: i, side: lado >= 0 ? 1 : -1,
          fromX: fx, fromZ: fz, toX: tx, toZ: tz,
          travelMs: flyMs, radius: attack.radius || 15, homed: !!alvo,
          targetId: alvo ? alvo.id : null,
          homingRadius: attack.homing ? (attack.homingRadius || 55) : 0,
        }, mapLevel);

        this._agenda(npc, () => {
          if (npc.dead) return;
          let ax = tx, az = tz;
          if (attack.homing && alvo && !alvo.dead && alvo.mapLevel === mapLevel
              && Math.hypot(alvo.x - tx, alvo.z - tz) <= (attack.homingRadius || 55)) {
            ax = alvo.x; az = alvo.z;
          }
          this._resolveAttack(npc, {
            ...attack, shape: 'circle', radius: attack.radius || 15,
            _torpedoHit: true, _quiet: true,
          }, ax, az, allPlayers, mapLevel);
        }, flyMs);
      }, i * gapMs);
    }
  }

  /** Jogador mais perto dentro de um cone à frente do bicho — a mira do torpedo. */
  _coneTargetPlayer(ox, oz, dx, dz, reach, halfAngle, allPlayers, mapLevel) {
    const agora = Date.now();
    let best = null, bestD = Infinity;
    for (const p of allPlayers) {
      if (p.mapLevel !== mapLevel || p.dead) continue;
      if (isSafeAfterRespawn(p, agora) || isInvincible(p, agora)) continue;
      const rx = p.x - ox, rz = p.z - oz;
      const d = Math.hypot(rx, rz);
      if (d > reach || d < 0.001 || d >= bestD) continue;
      const cosA = (rx * dx + rz * dz) / d;
      if (Math.acos(Math.max(-1, Math.min(1, cosA))) > halfAngle) continue;
      bestD = d; best = p;
    }
    return best;
  }

  /**
   * Sobrecarga do Núcleo (`special: 'charge'`): carrega por `chargeMs` e detona
   * a tela inteira — a menos que alguém o INTERROMPA.
   *
   * Sem o branch, os 5 s de carga não existiam: o chefe soltava a explosão no
   * fim do cast de 800 ms, sem janela nenhuma e sem como cancelar. A skill
   * inteira é a janela — `interruptDamage: 1` quer dizer que UM ponto de dano
   * cancela tudo, ou seja o golpe mais assustador do chefe é também o único que
   * o jogador desliga só de continuar atirando.
   *
   * O segundo telegraph é o que torna isso jogável: sem ele o jogador via um
   * aviso de 800 ms, cinco segundos de nada, e a tela explodindo. Vai SEM `vfx`
   * de propósito (o círculo genérico do TelegraphSystem), senão o cliente
   * recomeçaria a animação inteira da skill por cima da que já está rodando —
   * ver a mesma nota no elo seguinte da Descarga em Cadeia.
   */
  _runCharge(npc, attack, targetX, targetZ, allPlayers, mapLevel) {
    const charge = attack.chargeMs || 5000;
    const limite = Math.max(1, attack.interruptDamage || 1);
    const hpIni  = npc.hp;

    npc._charging = true;
    this.addEvent({
      type: 'npc_telegraph', npcId: npc.id, attackId: attack.id,
      attackName: attack.name || attack.id, shape: 'circle',
      npcX: npc.x, npcZ: npc.z, x: targetX, z: targetZ,
      radius: attack.radius, duration: charge,
      color: attack.telegraph?.color,
    }, mapLevel);

    this._agenda(npc, () => {
      npc._charging = false;
      if (npc.dead) return;
      if (npc.hp <= hpIni - limite) {
        this.addEvent({
          type: 'monster_skill_interrupted', casterId: npc.id,
          skill: attack.skill, vfx: attack.vfx, originX: npc.x, originZ: npc.z,
        }, mapLevel);
        return;
      }
      this._resolveAttack(npc, {
        ...attack, shape: 'circle', _chargeBurst: true,
      }, targetX, targetZ, allPlayers, mapLevel);
    }, charge);
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
          // `sticky`: alcançar NÃO acaba o golpe — a coisa GRUDA no alvo e
          // continua moendo até a vida dela terminar. É o que separa um
          // projetil teleguiado (a Orbe) de uma tromba d'água que persegue: se
          // estourasse ao encostar, "segue o alvo dando dano por tique" seria
          // uma promessa de um tique só.
          if (!attack.sticky) return burst(orb.x, orb.z);
        } else {
          orb.x += (dx / d) * stepDist;
          orb.z += (dz / d) * stepDist;
        }
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
      !isSafeAfterRespawn(p));

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
   * A varredura vem do `sonarSweep`: `ceil(radius/band)` faixas encostadas,
   * amostradas no centro de cada uma. Ler a nota do utils/sonar-sweep.js — o
   * relogio que estava aqui antes deixava a ULTIMA faixa de fora e quem ficava
   * parado na borda escapava do golpe inteiro de vez em quando.
   *
   * `_sweepSeen`: uma onda so cobra UMA vez de cada barco. Isso era um acidente
   * da aritmetica (o passo valia `band`, entao as faixas nao se sobrepunham) e
   * so valia para quem estava PARADO — fugir para fora junto com a parede
   * mantinha o barco dentro dela por varios passos e cobrava o dobro.
   */
  _runSonar(npc, attack, targetX, targetZ, allPlayers, mapLevel) {
    const rings  = attack.ringCount || attack.ticks?.count || 4;
    const gapMs  = attack.ticks?.intervalMs || 850;
    const { steps, stepMs, fronts, timeAt } = sonarSweep(attack);
    // Centrado no ALVO do cast e PLANTADO ali — e onde o cliente ancora o
    // desenho (`ring` nao e from_caster). Recentrar no bicho poria as ondas
    // do dano num lugar e as desenhadas em outro.
    const ox = targetX, oz = targetZ;
    const gapFacing = npc._castGapFacing;

    // Uma cadeia de timers POR ONDA: as ondas saem defasadas de `gapMs`, que
    // nao e multiplo de `stepMs` — num relogio unico so a onda 0 cairia nos
    // instantes certos, e as outras amostrariam a frente onde a divisao
    // deixasse (era o que abria o buraco na borda).
    const sweep = (i, k, seen) => {
      if (npc.dead || (this.pm?.npcs && !this.pm.npcs.has(npc.id))) return;
      this._resolveAttack(npc, {
        ...attack,
        shape: 'ring',
        _frontRadius: fronts[k],
        _ringIndex: i,
        _gapFacing: gapFacing,
        _sweepSeen: seen,
      }, ox, oz, allPlayers, mapLevel);

      if (k + 1 >= steps) return;
      const tm = setTimeout(() => {
        if (npc._tickTimers) npc._tickTimers = npc._tickTimers.filter(x => x !== tm);
        sweep(i, k + 1, seen);
      }, stepMs);
      (npc._tickTimers ||= []).push(tm);
    };

    for (let i = 0; i < rings; i++) {
      const seen = new Set();
      const tm = setTimeout(() => {
        if (npc._tickTimers) npc._tickTimers = npc._tickTimers.filter(x => x !== tm);
        sweep(i, 0, seen);
      }, i * gapMs + timeAt(0));
      (npc._tickTimers ||= []).push(tm);
    }
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
  /**
   * Bocarra Torácica (bicho): engole UM jogador colado, segura e cospe.
   * Ver a nota do `_castSwallow` no monster-skill-manager — as duas faces
   * seguram pelo mesmo `stunExpires` e reescrevem a posição a cada leva.
   */
  _runSwallow(npc, attack, allPlayers, mapLevel) {
    const hold  = attack.holdMs   || 2000;
    const spit  = attack.spitDist || 95;
    const raio  = attack.radius   || 75;
    const ticks = attack.ticks;
    const total = Math.max(1, ticks ? (ticks.count || 1) : 1);
    const step  = ticks ? (ticks.intervalMs || 400) : 0;
    const agora = Date.now();

    const perto = allPlayers
      .filter(p => p.mapLevel === mapLevel && !p.dead
                && !isSafeAfterRespawn(p, agora)
                && !isInvincible(p, agora)
                && dist2D(npc, p) <= raio)
      .sort((a, b) => dist2D(npc, a) - dist2D(npc, b));
    if (perto.length === 0) return;

    const presa = perto[0];
    presa.stunExpires = Math.max(presa.stunExpires || 0, Date.now() + hold);
    presa._swallowedBy = npc.id;
    this.addEvent({
      type: 'relic_effect', casterId: npc.id, effect: 'swallow',
      vfx: attack.vfx, skill: attack.skill, targetId: presa.id, duration: hold,
    }, mapLevel);

    for (let i = 0; i < total; i++) {
      const tm = setTimeout(() => {
        if (npc.dead || presa.dead) return;
        // ⚠️ `presa.dead` volta a ser `false` no instante em que o jogador
        // aperta reviver, e as levas que faltavam caíam em cima do barco novo,
        // com 10% de vida. A trégua é o que distingue "ainda está sendo
        // mastigado" de "já morreu e voltou" — o `dead` sozinho não distingue.
        if (isSafeAfterRespawn(presa)) return;
        presa.x = npc.x;
        presa.z = npc.z;
        const dmg = Math.max(1, Math.floor((npc.cannonDmg || 1) * attack.damageMult));
        presa.hp = Math.max(0, presa.hp - shield.absorb(presa, dmg).dmg);
        presa.lastCombatTime = Date.now();
        this.addEvent({
          type: 'npc_attack_hit', npcId: npc.id, attackId: attack.id,
          x: npc.x, z: npc.z,
          hits: [{ id: presa.id, hp: presa.hp, maxHp: presa.maxHp, dmg }],
        }, mapLevel);
        if (this.onPlayerKilled) this.onPlayerKilled(presa, npc.id);
      }, i * step);
      (npc._tickTimers ||= []).push(tm);
    }

    const fim = setTimeout(() => {
      if (presa.dead) return;
      presa.x = npc.x - Math.sin(npc.rotation || 0) * spit;
      presa.z = npc.z - Math.cos(npc.rotation || 0) * spit;
      delete presa._swallowedBy;
      this.addEvent({ type: 'relic_effect', casterId: npc.id, effect: 'spit_out',
                      targetId: presa.id, x: presa.x, z: presa.z }, mapLevel);
    }, hold);
    (npc._tickTimers ||= []).push(fim);
  }

  /**
   * Espelho do Córtex (bicho): relança a última relíquia de bestiário que o
   * ALVO usou, na versão de bicho. `player._lastRelicSkill` é gravado pelo
   * handleUseRelic; sem nada gravado cai no `fallbackSkill`, para a skill não
   * punir justamente quem chegou sem repertório.
   */
  _runMirror(npc, attack, targetX, targetZ, allPlayers, mapLevel) {
    const agora = Date.now();
    let alvo = null, melhor = Infinity;
    for (const p of allPlayers) {
      if (p.mapLevel !== mapLevel || p.dead) continue;
      const d = dist2D(npc, p);
      if (d < melhor) { melhor = d; alvo = p; }
    }
    const copiada = (alvo && alvo._lastRelicSkill) || attack.fallbackSkill;
    const espelhada = copiada && ATTACK_DEFS[copiada];
    if (!espelhada || espelhada.special === 'mirror') {
      this.addEvent({ type: 'relic_effect', casterId: npc.id, effect: 'mirror_failed',
                      skill: attack.skill }, mapLevel);
      return;
    }
    this.addEvent({
      type: 'relic_effect', casterId: npc.id, effect: 'mirror', skill: attack.skill,
      copiedSkill: copiada, copiedName: espelhada.name,
    }, mapLevel);

    // O dano continua sendo o DESTE golpe: o espelho reproduz a FORMA, senão
    // copiar a skill mais forte do jogador sairia mais barato que o próprio
    // repertório do bicho.
    const clone = { ...espelhada, _mirrored: true,
                    damageMult: attack.damageMult, cooldown: attack.cooldown };
    // `_currentCast` já foi limpo pelo timer do cast original — dá para reabrir.
    npc._currentCast = null;
    this._beginCast(npc, clone, alvo, allPlayers, mapLevel);
    void agora; void targetX; void targetZ;
  }

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

  /** Passo da simulacao das luzes, em ms. Ver _runHunterLights. */
  static get LIGHT_TICK_MS() { return 200; }

  /**
   * FAROIS DE CARNE — `lightCount` luzes TELEGUIADAS, uma por alvo.
   *
   * Cada luz nasce no arauto e voa atras da posicao VIVA de quem ela marcou.
   * Ela nao machuca no caminho: implode quando alcanca (`catchRadius`) ou
   * quando `lifeMs` acaba, onde quer que esteja. A explosao e a skill inteira.
   *
   * E a familia da Orbe Cacadora (`_runHunterOrb`), com as duas diferencas que
   * as separam: a orbe e UMA e corroi a cada leva, para te empurrar de um
   * lugar; estas sao TRES e so contam o tempo, para dividir a atencao da sala.
   * Numa arena de PvP e o mais valioso que o arauto faz — tres pessoas fugindo
   * em direcoes diferentes ao mesmo tempo desfaz qualquer formacao.
   *
   * Alvos SORTEADOS (e nao "os mais proximos", como nos Pilares) e sem repetir:
   * a luz tem de poder ir atras de quem esta longe brigando com outro jogador,
   * que e o que faz o arauto interromper PvP em vez de so punir quem o encara.
   *
   * `LIGHT_TICK_MS` e o passo da simulacao E o ritmo dos `..._move`. 200 ms com
   * o cliente interpolando entre eles gasta ~25 eventos por luz nos 5 s; um
   * passo muito menor triplicaria a rede para ganhar suavidade que o lerp do
   * cliente ja da de graca.
   */
  _runHunterLights(npc, attack, allPlayers, mapLevel) {
    const range  = attack.rangeMax || 300;
    const life   = attack.lifeMs || 5000;
    const speed  = attack.lightSpeed || 62;      // unidades por segundo
    const catchR = attack.catchRadius || 18;
    const raio   = attack.radius || 70;
    const tickMs = AttackManager.LIGHT_TICK_MS;
    const _now   = Date.now();

    const candidatos = allPlayers.filter(p =>
      p.mapLevel === mapLevel && !p.dead &&
      !isSafeAfterRespawn(p, _now) && dist2D(npc, p) <= range
    );
    if (candidatos.length === 0) return;

    // Fisher-Yates parcial: embaralha so o tanto que vai usar.
    const n = Math.min(attack.lightCount || 3, candidatos.length);
    for (let i = 0; i < n; i++) {
      const j = i + Math.floor(Math.random() * (candidatos.length - i));
      [candidatos[i], candidatos[j]] = [candidatos[j], candidatos[i]];
    }

    for (let i = 0; i < n; i++) {
      const alvoId = candidatos[i].id;
      // Nasce no arauto, como um projetil de verdade — nao em cima da vitima.
      const luz = { x: npc.x, z: npc.z };
      const nasceuEm = Date.now();

      this.addEvent({
        type: 'monster_skill_light', npcId: npc.id, skill: attack.skill,
        vfx: attack.vfx, targetId: alvoId, index: i,
        x: luz.x, z: luz.z, npcX: npc.x, npcZ: npc.z,
        lifeMs: life, radius: raio, lightSpeed: speed,
        color: attack.telegraph?.color,
      }, mapLevel);

      const implodir = (bx, bz) => {
        this.addEvent({
          type: 'monster_skill_light_burst', npcId: npc.id, skill: attack.skill,
          vfx: attack.vfx, targetId: alvoId, index: i,
          x: bx, z: bz, radius: raio, color: attack.telegraph?.color,
        }, mapLevel);
        // O estouro e o ataque normal (circulo) — reaproveita dano, escudo,
        // pet, morte e o `cc` do dado. Mesma saida da orbe.
        this._resolveAttack(npc,
          { ...attack, shape: 'circle', radius: raio, _lightBurst: true },
          bx, bz, allPlayers, mapLevel);
      };

      const passo = () => {
        if (npc.dead || (this.pm?.npcs && !this.pm.npcs.has(npc.id))) return;

        // Presa: o alvo marcado enquanto vivo; senao o mais proximo da LUZ —
        // ela ja saiu, e sumir no ar seria perder o golpe por sorte.
        let presa = allPlayers.find(p => p.id === alvoId);
        if (!presa || presa.dead || presa.mapLevel !== mapLevel) {
          presa = null;
          let best = Infinity;
          for (const p of allPlayers) {
            if (p.mapLevel !== mapLevel || p.dead) continue;
            const d = Math.hypot(p.x - luz.x, p.z - luz.z);
            if (d < best) { best = d; presa = p; }
          }
        }

        if (presa) {
          const dx = presa.x - luz.x, dz = presa.z - luz.z;
          const d  = Math.hypot(dx, dz) || 1;
          const avanco = speed * (tickMs / 1000);
          if (d <= avanco || d <= catchR) {           // alcancou
            luz.x = presa.x; luz.z = presa.z;
            return implodir(luz.x, luz.z);
          }
          luz.x += (dx / d) * avanco;
          luz.z += (dz / d) * avanco;
        }

        this.addEvent({
          type: 'monster_skill_light_move', npcId: npc.id, index: i,
          x: luz.x, z: luz.z,
        }, mapLevel);

        if (Date.now() - nasceuEm >= life) return implodir(luz.x, luz.z);

        const t = setTimeout(() => {
          if (npc._tickTimers) npc._tickTimers = npc._tickTimers.filter(x => x !== t);
          passo();
        }, tickMs);
        (npc._tickTimers ||= []).push(t);
      };

      passo();
    }
  }

  /**
   * PRISAO DE TERRA — quatro muros retos formando uma caixa FECHADA em volta do
   * ponto mirado. Prima da Jaula de Patas, com a diferenca que define as duas:
   * a jaula e um anel de pernas COM brecha (existe para empurrar para um lado);
   * esta nao tem saida nenhuma, e por isso nao atordoa nem machuca — o preco e
   * o tempo, e o `wallManager` cobra sozinho.
   *
   * `rot` segue a convencao da caixa de colisao (`_pushOutOfShape`): o eixo do
   * COMPRIMENTO e o basis.x, entao os dois muros N/S usam rot 0 e os dois L/O
   * usam rot PI/2. Errar isso deixa a cela aberta nos cantos.
   */
  _raisePrisonWalls(npc, attack, targetX, targetZ, mapLevel) {
    if (!this.wallManager) return;
    const meia  = (attack.wallLength || 52) / 2;   // meio comprimento do muro
    const esp   = (attack.wallThickness || 8) / 2; // meia espessura
    const hold  = attack.holdMs || 30000;
    const stamp = Date.now();

    // Distancia do centro ate cada parede: metade do comprimento cobre a
    // largura da cela, e a espessura fica POR FORA para o interior util nao
    // encolher (senao um barco de raio 14 nao manobra numa cela de 52).
    const d = meia + esp;
    const muros = [
      { x:  0, z: -d, rot: 0 },              // norte
      { x:  0, z:  d, rot: 0 },              // sul
      { x: -d, z:  0, rot: Math.PI / 2 },    // oeste
      { x:  d, z:  0, rot: Math.PI / 2 },    // leste
    ];

    const pontos = [];
    for (let i = 0; i < muros.length; i++) {
      const m = muros[i];
      this.wallManager.addWall(mapLevel, {
        id: `prison_${npc.id}_${stamp}_${i}`,
        x: targetX + m.x, z: targetZ + m.z,
        hw: meia, hh: esp, rot: m.rot, durationMs: hold,
      });
      pontos.push({ x: m.x, z: m.z, rot: m.rot });
    }

    this.addEvent({
      type: 'monster_skill_obstacles', npcId: npc.id, skill: attack.skill,
      vfx: attack.vfx, originX: targetX, originZ: targetZ,
      points: pontos, radius: attack.radius, holdMs: hold,
      wallLength: attack.wallLength, wallThickness: attack.wallThickness,
    }, mapLevel);
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
        false,                    // miss: o bicho não rola precisão (ver spawnSalvo)
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
        p.mapLevel === mapLevel && !p.dead && !isSafeAfterRespawn(p, _auraNow)
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
