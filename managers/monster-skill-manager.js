// managers/monster-skill-manager.js
// Motor genérico das 34 relíquias do bestiário (r14..r47).
//
// Por que um motor e não 34 branches: as skills variam na FORMA e no RITMO do
// acerto, não na natureza dele. Escrever 34 branches em handleUseRelic() seria
// ~3000 linhas repetindo o mesmo bloco de "aplica dano, contabiliza morte,
// broadcast". Aqui a diferença entre a Pinça e a Marcha Fúnebre é DADO
// (constants/monster_skills.js), e o código é um só.
//
// O que o motor compõe:
//   forma    circle | ring | cone | line | multi | chain   (quem é atingido)
//   ritmo    ticks {count, intervalMs, pct}                 (quantas vezes)
//   controle cc {slowPct, slowMs, stunMs, rootMs, pullTo, pushDist}
//   special  soak | bulwark | drain | obstacles | charge | mark | brood | bond
//                                                          | orb | static
//
// Autoridade: TODO acerto sai daqui. O cliente só desenha o VFX que o
// broadcast `monster_skill_cast` descreve — inclusive os offsets sorteados
// (`points`), pra explosão desenhada bater com a que causou dano.
'use strict';

const { MONSTER_SKILLS } = require('../constants/monster_skills');
const { isInvincible, isSafeAfterRespawn } = require('../utils/invincibility');
const { applyGoldShield } = require('../utils/gold-shield');
const shield = require('../utils/shield');
const { sonarSweep } = require('../utils/sonar-sweep');

class MonsterSkillManager {
  /**
   * Passo da simulação dos Faróis de Carne, em ms — e também o ritmo dos
   * eventos `monster_skill_light_move`. Tem que casar com o
   * `AttackManager.LIGHT_TICK_MS`: as duas faces do mesmo golpe voam no mesmo
   * compasso, e o cliente interpola entre as levas dos dois igual.
   */
  static get LIGHT_TICK_MS() { return 200; }

  /**
   * `ctx` são as peças do server.js que o motor precisa. Injetadas em vez de
   * importadas porque quase todas são instâncias vivas (managers por mapa),
   * não módulos — mesmo padrão do partyManager/wallManager.
   */
  constructor(ctx) {
    this.ctx = ctx;
  }

  // ── NUNCA espalhe `effectPayload` num addEvent ──────────────────────────
  // Ele é a resposta PRIVADA ao lançador (`sendTo`), e começa com
  // `type: 'relic_used'`. Espalhado num evento de mapa ele entra por ÚLTIMO e
  // SOBRESCREVE o `type` do próprio evento: o `monster_skill_strike` chegava no
  // cliente como `relic_used` e ia parar no handler errado, sem número de dano
  // nenhum. Foi o que apagou o dano dos Pilares do Juízo e dos Faróis de Carne,
  // e o que fazia as paredes da Prisão de Terra nunca serem desenhadas — três
  // sintomas sem nada em comum, uma linha só de origem.

  // ── Geometria ──────────────────────────────────────────────────────────────

  /** Offsets das sub-áreas de um `multi`, sorteados em disco e reaproveitáveis. */
  static scatter(count, spread, def = null) {
    // `aimed_ring`: uma sub-área MIRADA no alvo + anel com UMA brecha.
    //
    // O padrão aleatório abaixo tem um buraco no meio — `sqrt(0.15 + …)` nunca
    // deixa uma sub-área nascer a menos de 0,387×spread do centro. Como o
    // espalhamento é centrado NO ALVO, esse buraco (69,7 un no morteiro) era
    // maior que o raio de dano (38): ficar parado era matematicamente
    // invulnerável e SE MEXER era o que fazia tomar dano — a mecânica ao
    // contrário. Com o anel, parado leva sempre e a saída é ler a brecha.
    if (def && def.pattern === 'aimed_ring') {
      return MonsterSkillManager.aimedRing(count, spread, def.gapAngle || 90);
    }
    // `sealed_ring`: TODAS as sub-areas num anel fechado, sem miolo e sem
    // brecha. E o inverso do aimed_ring — aqui o centro e o ABRIGO, e a coroa
    // e a parede que voce paga para atravessar. Para o anel nao ter vao, o
    // arco entre dois vizinhos tem de caber no diametro de uma sub-area:
    // 2*PI*spread/count <= 2*radius, ou seja count >= PI*spread/radius.
    if (def && def.pattern === 'sealed_ring') {
      const pts = [];
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2;
        pts.push({ x: Math.cos(a) * spread, z: Math.sin(a) * spread });
      }
      return pts;
    }
    const pts = [];
    for (let i = 0; i < count; i++) {
      // Ângulo espalhado + jitter: distribui melhor que random puro (que
      // amontoa) sem virar um círculo perfeito de pontos.
      const ang = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.9;
      const rad = spread * Math.sqrt(0.15 + Math.random() * 0.85);
      pts.push({ x: Math.cos(ang) * rad, z: Math.sin(ang) * rad });
    }
    return pts;
  }

  /**
   * Uma sub-área no alvo + as demais num anel de raio `spread` cobrindo tudo
   * menos uma brecha de `gapDeg` graus. A brecha gira a cada uso, então não dá
   * para decorar o lado — tem que olhar a marcação.
   */
  static aimedRing(count, spread, gapDeg) {
    const pts  = [{ x: 0, z: 0 }];                  // a mirada
    const ring = Math.max(1, count - 1);
    const span = Math.PI * 2 - (gapDeg * Math.PI) / 180;
    const start = Math.random() * Math.PI * 2;      // onde a brecha cai
    for (let i = 0; i < ring; i++) {
      // Com uma só, ela fica no meio do arco; com várias, de ponta a ponta —
      // assim a brecha fica com a largura anunciada em vez de dobrar.
      const t   = ring === 1 ? 0.5 : i / (ring - 1);
      const ang = start + t * span;
      pts.push({ x: Math.cos(ang) * spread, z: Math.sin(ang) * spread });
    }
    return pts;
  }

  /**
   * Posições das patas da Jaula: anel com UMA brecha centrada em `gapFacing`.
   * Compartilhado entre o cast (broadcast/colisão) e o attack-manager (NPC).
   */
  static cageSpots(def, gapFacing) {
    const legs = def.legCount || 8;
    const r    = def.radius || 45;
    const gap  = (def.gapAngle || 55) * Math.PI / 180;
    const TAU  = Math.PI * 2;
    const spots = [];
    for (let i = 0; i < legs; i++) {
      const a = (i / legs) * TAU;
      // Distância angular pelo caminho curto (módulo de negativo em JS
      // preserva o sinal — usar abs antes, senão a brecha some).
      let diff = Math.abs(a - gapFacing) % TAU;
      if (diff > Math.PI) diff = TAU - diff;
      if (diff < gap / 2) continue;
      spots.push({ x: Math.cos(a) * r, z: Math.sin(a) * r });
    }
    return spots;
  }

  /**
   * A entidade `e` está dentro da forma?
   * `ox/oz` centro, `dx/dz` direção unitária (cone/line), `pts` offsets (multi).
   */
  static inShape(def, shape, ox, oz, dx, dz, pts, e) {
    const rx = e.x - ox, rz = e.z - oz;
    switch (shape) {
      case 'circle': {
        const d = Math.hypot(rx, rz);
        if (d > (def.radius || 40)) return false;

        // ── Salva de Bombordo: só os SETORES daquela leva disparam ──────────
        // Sem isto o `circle` batia o disco inteiro e os setores existiam só no
        // desenho: correr para a metade "segura" não adiantava nada, que era
        // exatamente a promessa da skill ("ache o RITMO, não o lugar").
        //
        // Mesma conta do `sector_angles(parity)` da skill 2D: centros em
        // `offset + TAU*(i+0.5)/n` para i = paridade, paridade+2, …, e
        // meia-abertura de `PI/n`. A paridade alterna por leva.
        if (def.sectorCount) {
          const n      = def.sectorCount;
          const parity = (def._tickIndex || 0) % 2;
          const half   = Math.PI / n;
          const ang    = Math.atan2(rz, rx);
          for (let i = parity; i < n; i += 2) {
            const centro = (def.sectorOffset || 0) + (Math.PI * 2 * (i + 0.5)) / n;
            let diff = Math.abs(ang - centro) % (Math.PI * 2);
            if (diff > Math.PI) diff = Math.PI * 2 - diff;
            if (diff <= half) return true;
          }
          return false;
        }
        return true;
      }

      case 'ring': {
        const d = Math.hypot(rx, rz);
        // ── Anel com FAIXA: a parede que corre para fora (Sonar) ────────────
        // Sem isto o `ring` batia o DISCO inteiro a cada leva: quem estava
        // colado no bicho levava as quatro ondas sem nenhuma parede ter
        // encostado nele, e a brecha desenhada não valia nada. Com `band`, o
        // acerto é só a espessura da frente naquele instante — o dano acontece
        // quando a parede passa por você, que é o que o desenho promete.
        if (def.band) {
          const n = Math.max(1, def._tickCount || 1);
          const k = Math.min(def._tickIndex || 0, n - 1);
          // `_frontRadius` vem do simulador do Sonar (a onda corre de verdade).
          // O calculo por leva fica de reserva para quem use `band` sem
          // simulacao — a frente abre em passos iguais ate `radius`.
          const front = def._frontRadius != null
            ? def._frontRadius
            : (def.radius || 90) * ((k + 1) / n);
          if (Math.abs(d - front) > def.band / 2) return false;
          // Brecha: o setor seguro daquela onda. `_gapFacing` é sorteado UMA
          // vez no cast e vai no telegraph, então desenho e dano concordam;
          // `gapStep` gira a brecha a cada onda (não dá para decorar o lado).
          if (def.gapAngle && def._gapFacing != null) {
            const ring = def._ringIndex != null ? def._ringIndex : k;
            const center = def._gapFacing + ring * (def.gapStep || 0);
            // `%` de JS preserva o sinal — o valor entra em Math.abs ANTES,
            // senão a brecha fecha (mesma pegadinha do cageSpots).
            let diff = Math.abs(Math.atan2(rz, rx) - center) % (Math.PI * 2);
            if (diff > Math.PI) diff = Math.PI * 2 - diff;
            if (diff < ((def.gapAngle * Math.PI) / 180) / 2) return false;
          }
          return true;
        }
        // O MIOLO é seguro — é o dodge invertido do Rugido/Espiral.
        return d <= (def.radius || 90) && d > (def.safeRadius || 0);
      }

      case 'cone': {
        const d = Math.hypot(rx, rz);
        if (d > (def.length || 60)) return false;
        // Colado no ápice: o ângulo é indefinido, mas estar em cima do caster
        // está trivialmente DENTRO do cone — devolver false aqui deixava um
        // ponto cego exatamente onde o inimigo mais perto costuma estar.
        if (d < 0.001) return true;
        const dot = (rx * dx + rz * dz) / d;
        const half = ((def.angle || 60) * Math.PI / 180) / 2;
        return Math.acos(Math.max(-1, Math.min(1, dot))) <= half;
      }

      case 'line': {
        const t = rx * dx + rz * dz;                 // projeção no eixo do corredor
        const perp = Math.abs(rx * -dz + rz * dx);   // distância perpendicular

        // ── Parede que AVANÇA em passos (Barragem Rolante) ──────────────────
        // Aqui `width` é a largura LATERAL da parede e `band` a espessura dela;
        // não existe `length`. Sem este ramo o corredor caía no default de 100
        // e cada leva batia o mesmo retângulo colado no bicho — a barragem
        // "avançava" no desenho e o dano ficava parado, pegando quem estava
        // atrás dela. Agora cada leva é a faixa daquele passo, e só ela.
        // ── Muralha de Maré: a frente que VIAJA ─────────────────────────────
        // `_frontDistance` vem do simulador; `width` aqui é a largura LATERAL
        // da onda e `band` a espessura dela. Sem este ramo o corredor inteiro
        // resolvia de uma vez no fim do cast: a parede aparecia longe de você e
        // o dano já tinha saído.
        if (def._frontDistance != null) {
          return Math.abs(t - def._frontDistance) <= (def.band || 12) / 2
              && perp <= (def.width || 80) / 2;
        }

        if (def.stepCount) {
          const k = def._tickIndex || 0;
          const d = (def.firstDistance || 20) + k * (def.stepDistance || 20);
          return Math.abs(t - d) <= (def.band || 12) / 2
              && perp <= (def.width || 80) / 2;
        }

        const reach = def.length || 100;
        if (t >= 0 && t <= reach && perp <= (def.width || 20) / 2) return true;
        // 2ª etapa da Investida: a irrupção no fim do corredor. O bicho e a
        // relíquia precisam acertar IGUAL — sem isto a versão do jogador
        // desenhava a explosão e não batia nela.
        if (def.eruptRadius) {
          const ex = ox + dx * reach, ez = oz + dz * reach;
          return Math.hypot(e.x - ex, e.z - ez) <= def.eruptRadius;
        }
        return false;
      }

      case 'multi': {
        // `growth`: as pocas CRESCEM com o tempo. Isto so existia no desenho —
        // a poca pintada chegava a 1,8x enquanto a que machucava ficava no raio
        // original, entao a borda visivel mentia. Cresce junto, no compasso das
        // levas, e a leitura "reposicione cedo, depois nao cabe mais" passa a
        // ser verdade.
        let r = def.radius || 15;
        if (def.growth && def.growth > 1) {
          const n = Math.max(1, (def._tickCount || 1) - 1);
          const k = Math.min(def._tickIndex || 0, n);
          r *= 1 + (def.growth - 1) * (k / n);
        }
        return (pts || []).some(p =>
          Math.hypot(e.x - (ox + p.x), e.z - (oz + p.z)) <= r);
      }

      case 'rays': {
        // Coroa de Espinhos: N raios estreitos girando. O giro do momento vem
        // em def._spinNow (o resolvedor injeta por tick) — o acerto acompanha a
        // coroa girando, igual ao desenho.
        const d = Math.hypot(rx, rz);
        if (d > (def.length || 80)) return false;
        if (d < 0.001) return true;
        const n = def.rayCount || 6;
        const slot = (Math.PI * 2) / n;
        const half = ((def.angle || 22) * Math.PI / 180) / 2;
        const ang = Math.atan2(rz, rx) - (def._spinNow || 0);
        const rel = ((ang % slot) + slot) % slot;   // distância angular ao raio mais próximo
        return rel <= half || rel >= slot - half;
      }

      default:
        return Math.hypot(rx, rz) <= (def.radius || 40);
    }
  }

  // ── Alvos ──────────────────────────────────────────────────────────────────

  /**
   * Este NPC é alvo legítimo do lançador?
   *
   * Espelha o `relicCanHitPlayer` do lado de lá: aqui o único caso hoje é a
   * nau da coleta, que a guilda dona da ilha ESCOLTA — para ela o barco não é
   * inimigo, e uma skill do bestiário que o pegasse de raspão afundaria o
   * imposto da própria irmandade. Sem o gancho ligado (testes, contexto
   * mínimo), tudo continua sendo alvo, como era antes.
   */
  _podeAcertarNpc(player, npc) {
    const pode = this.ctx.relicCanHitNpc;
    return pode ? pode(player, npc) : true;
  }

  /** Todos os inimigos válidos do caster dentro da forma. */
  _targetsIn(player, def, shape, ox, oz, dx, dz, pts) {
    const { projectileManager, players, relicCanHitPlayer } = this.ctx;
    const out = [];
    projectileManager.npcs.forEach(npc => {
      if (npc.dead) return;
      if (!this._podeAcertarNpc(player, npc)) return;
      if ((npc.mapLevel || 1) !== (player.mapLevel || 1)) return;
      if (MonsterSkillManager.inShape(def, shape, ox, oz, dx, dz, pts, npc)) {
        out.push({ e: npc, isNPC: true });
      }
    });
    players.forEach(p => {
      if (!relicCanHitPlayer(player, p)) return;
      if (MonsterSkillManager.inShape(def, shape, ox, oz, dx, dz, pts, p)) {
        out.push({ e: p, isNPC: false });
      }
    });
    return out;
  }

  /** Cadeia: parte do alvo mais próximo do ponto e pula de vizinho em vizinho. */
  _chainTargets(player, def, ox, oz) {
    const { projectileManager, players, relicCanHitPlayer } = this.ctx;
    const pool = [];
    projectileManager.npcs.forEach(npc => {
      if (npc.dead || !this._podeAcertarNpc(player, npc)) return;
      if ((npc.mapLevel || 1) === (player.mapLevel || 1)) pool.push({ e: npc, isNPC: true });
    });
    players.forEach(p => { if (relicCanHitPlayer(player, p)) pool.push({ e: p, isNPC: false }); });

    const jump = def.jumpRange || 35;
    const maxJumps = def.count || 4;
    const chain = [];
    const used = new Set();
    let cx = ox, cz = oz;
    // O primeiro elo aceita uma folga em volta do CURSOR; os seguintes precisam
    // estar a `jumpRange` do elo anterior — é isso que faz a cadeia "espalhar"
    // em vez de virar um AoE circular.
    //
    // `seekRadius` e não `radius`: o raio de dano da cadeia é pequeno de
    // propósito (é um arco, não uma bomba), e usá-lo como tolerância de mira
    // exigia clicar a 5 un do CENTRO do bicho — na prática a relíquia nunca
    // engatava. São duas coisas diferentes e agora têm dois números.
    let reach = def.seekRadius || def.radius || 8;
    for (let i = 0; i < maxJumps; i++) {
      let best = null, bestD = Infinity;
      for (const t of pool) {
        if (used.has(t.e.id)) continue;
        const d = Math.hypot(t.e.x - cx, t.e.z - cz);
        if (d <= reach && d < bestD) { best = t; bestD = d; }
      }
      if (!best) break;
      used.add(best.e.id);
      chain.push(best);
      cx = best.e.x; cz = best.e.z;
      reach = jump;
    }
    return chain;
  }

  // ── Aplicação ──────────────────────────────────────────────────────────────

  /**
   * Dano num alvo + contabilidade de morte. Extraído porque o bloco de morte de
   * NPC (boss vs comum, recompensa, respawn, save) é longo e as 34 skills não
   * podem cada uma ter a sua cópia.
   * Devolve a entrada de `hits` para o broadcast.
   */
  _damage(player, t, dmg) {
    const { onNpcDamaged, onPlayerKilled } = this.ctx;
    const e = t.e;
    // Névoa Espectral: enquanto o vulto está desfeito, NADA o machuca — nem a
    // área de uma relíquia. Sem esta linha o golpe atravessaria a névoa e o
    // "pare de atirar e reposicione" viraria "atire igual", que é o oposto da
    // janela que a skill abre.
    if (e.phaseUntil && Date.now() < e.phaseUntil) {
      return { id: e.id, hp: e.hp, isNPC: t.isNPC, dmg: 0, phased: true };
    }
    // ── As defesas do jogador também valem contra as 34 do bestiário ───────
    // Este caminho de dano nasceu sem nenhuma delas: a Névoa Espectral não
    // aparava skill de relíquia e o Escudo de Ouro não descontava nada. Como o
    // bestiário é hoje a maior parte do dano que se leva em PvP, as duas
    // relíquias defensivas simplesmente "não funcionavam" — a queixa do
    // playtest. Os outros dois caminhos (tiro e área de bicho) já faziam isto.
    if (!t.isNPC) {
      // ⚠️ A trégua tem de ser checada AQUI, e não só no `_targetsIn`.
      //
      // As skills de várias levas (Bocarra Torácica, canalizadas, chuvas)
      // escolhem o alvo UMA vez e depois disparam N `setTimeout` guardando a
      // referência dele. O guarda de cada leva era `if (e.dead) return`, e
      // `dead` volta a ser `false` no instante em que o jogador aperta reviver
      // — então as levas que faltavam caíam em cima do barco recém-nascido,
      // com 10% de vida. Era literalmente "morri, revivi, morri de novo".
      if (isSafeAfterRespawn(e)) {
        this.ctx.addEvent({ type: 'shield_block', targetId: e.id }, e.mapLevel || 1);
        return { id: e.id, hp: e.hp, isNPC: false, dmg: 0, blocked: true };
      }
      if (isInvincible(e)) {
        this.ctx.addEvent({ type: 'shield_block', targetId: e.id }, e.mapLevel || 1);
        return { id: e.id, hp: e.hp, isNPC: false, dmg: 0, blocked: true };
      }
      const esc = applyGoldShield(e, dmg);
      dmg = esc.damage;
      if (esc.goldCost > 0) {
        this.ctx.sendTo(e.ws, {
          type: 'gold_shield_cost', targetId: e.id, goldCost: esc.goldCost, gold: e.gold,
        });
      }
    }

    e.hp = Math.max(0, e.hp - shield.absorb(e, dmg).dmg);
    // Escolta de Ossos: qualquer dano de relíquia do lançador também aciona um
    // salto. Fica aqui porque este é o funil por onde TODO dano de relíquia
    // passa — pendurar em cada `special` daria uma lista para esquecer.
    if (dmg > 0 && player && player._summonEscort) this.notifyPlayerHit(player, e);
    if (t.isNPC) {
      e.lastDamageTime = Date.now();
      if (e.isBoss) {
        if (!e._damageMap) e._damageMap = new Map();
        e._damageMap.set(player.id, (e._damageMap.get(player.id) || 0) + dmg);
      }
      if (e.hp <= 0 && !e.dead) onNpcDamaged(player, e);
    } else {
      e.lastCombatTime = Date.now();
      // Simétrico ao onNpcDamaged: uma skill do bestiário que afunda um JOGADOR
      // também precisa resolver a morte (ruína, tela de morte, espólio,
      // contrato de Procurado) — antes o alvo só ficava com 0 de vida.
      if (onPlayerKilled) onPlayerKilled(e, player.id);
    }
    return { id: e.id, hp: e.hp, isNPC: t.isNPC, dmg };
  }

  /**
   * Slow/stun/root/pull/push conforme `cc` do def. Bosses não tomam stun/root.
   *
   * `soRenovaSlow`: nas levas 2..N de uma canalizada só o SLOW é reaplicado.
   * Stun, root, puxão e empurrão continuam valendo uma vez por uso — reaplicar
   * um stun de 0,8 s a cada 160 ms seria stun permanente, e repuxar o alvo para
   * o centro a cada leva o deixaria colado sem chance de sair.
   *
   * O slow, esse sim, precisa renovar: no Sopro Pútrido ele durava 1,5 s dentro
   * de uma canalização de 3,5 s, então o alvo estava solto na metade final do
   * golpe que deveria estar emperrando ele.
   */
  _applyCC(player, t, cc, ox, oz, soRenovaSlow = false) {
    if (!cc) return;
    const e = t.e;
    const now = Date.now();
    if (cc.slowPct) {
      e.slowMult = Math.min(e.slowMult || 1, 1 - cc.slowPct);   // pior slow, não empilha
      e.slowExpires = now + (cc.slowMs || 2000);
    }
    if (soRenovaSlow) return;
    // Convenção do projeto: boss só leva slow (ver r11 Prisão de Gelo).
    if (!e.isBoss) {
      if (cc.stunMs) e.stunExpires = Math.max(e.stunExpires || 0, now + cc.stunMs);
      if (cc.rootMs) e.stunExpires = Math.max(e.stunExpires || 0, now + cc.rootMs);
    }
    if (cc.pullTo != null && !e.isBoss) {
      // Arrasta na direção do centro, parando a `pullTo` dele.
      const dx = e.x - ox, dz = e.z - oz;
      const d = Math.hypot(dx, dz);
      if (d > cc.pullTo && d > 0.001) {
        e.x = ox + (dx / d) * cc.pullTo;
        e.z = oz + (dz / d) * cc.pullTo;
      }
    }
    if (cc.pushDist && !e.isBoss) {
      const dx = e.x - ox, dz = e.z - oz;
      const d = Math.hypot(dx, dz) || 1;
      e.x += (dx / d) * cc.pushDist;
      e.z += (dz / d) * cc.pushDist;
    }
    if (cc.pullTo != null || cc.pushDist) this.ctx.clampToMap(e);
  }

  // ── Entrada ────────────────────────────────────────────────────────────────

  /**
   * Executa uma relíquia de bestiário. Chamada pelo branch único
   * `effect === 'monster_skill'` do handleUseRelic().
   */
  cast(player, def, tx, tz, effectPayload) {
    const { addEvent, relicDamageFor, getMapManagerFor } = this.ctx;
    const skill  = MONSTER_SKILLS[def.skill];
    const shape  = def.shape || 'circle';
    // `??` e não `||`: a Barragem Rolante castea em 0 ms, e com `||` o zero
    // caía no default de 800 — a skill "instantânea" ganhava 0,8 s de carga do
    // nada e ninguém conseguia ver de onde vinha.
    const castMs = def.castMs ?? def.castTime ?? 800;
    const mapLvl = player.mapLevel || 1;

    // Alcance colado no canhão (Bote da Bocarra): usar um número fixo fazia o
    // bote ficar mais curto que o tiro normal em barcos evoluídos, o que lê
    // como downgrade. `player.cannonRange` já vem com os upgrades aplicados.
    if (def.rangeFromCannons && player.cannonRange) {
      def = { ...def, length: player.cannonRange };
    }

    // Ponto do cursor — sempre existe, e é dele que sai a DIREÇÃO.
    const cx = tx != null ? tx : player.x;
    const cz = tz != null ? tz : player.z;

    // Direção caster→cursor: eixo de cone/linha. Se o cast for em cima do
    // próprio barco, usa a proa pra não degenerar num vetor nulo.
    let dx = cx - player.x, dz = cz - player.z;
    const dl = Math.hypot(dx, dz);
    if (dl < 0.001) { dx = Math.sin(player.rotation || 0); dz = Math.cos(player.rotation || 0); }
    else            { dx /= dl; dz /= dl; }

    // ORIGEM da forma. Cone e linha SAEM DO BARCO e apontam pro cursor (o ápice
    // do cone é o caster); as demais são centradas no cursor. Errar isso põe o
    // cone inteiro depois do alvo, sem acertar nada no caminho.
    // A Orbe entra aqui mesmo sendo `circle`: ela NASCE no lançador e viaja até
    // o alvo. Ancorada no cursor, o desenho aparecia lá, e no fim do cast a
    // orbe saltava para o lançador para só então começar a voar — o "teleporte"
    // que se via. A âncora tem que ficar onde a orbe nasce.
    // `rays` (Coroa de Espinhos) entra aqui pelo mesmo motivo: a coroa gira em
    // volta de QUEM LANÇOU. É o que o desenho sempre fez (o cliente ancora
    // `rays` no caster) e o que o bicho faz (attack-manager: origin = cast.x/z).
    // Centrada no cursor, o jogador via os raios girando no próprio barco e o
    // dano caía num círculo lá longe — a queixa de "não está causando dano".
    // `torpedo` entra pelo mesmo motivo da Orbe: os torpedos NASCEM no casco
    // e viajam. Ancorado no cursor, o desenho apareceria lá e os torpedos
    // sairiam de um ponto que nada tem a ver com o barco.
    const fromCaster = (shape === 'cone' || shape === 'line' || shape === 'rays'
                     || def.special === 'orb' || def.special === 'torpedo'
                     || def.atCaster);
    const ox = fromCaster ? player.x : cx;
    const oz = fromCaster ? player.z : cz;

    // Offsets das sub-áreas sorteados AQUI e enviados no cast: o cliente desenha
    // exatamente onde o dano vai cair, em vez de sortear os dele por conta.
    let pts = (shape === 'multi')
      ? MonsterSkillManager.scatter(def.count || 5, def.spread || 60, def)
      : null;

    // Jaula de Patas: a BRECHA é decidida AQUI, antes do broadcast — o
    // desenho 2D, as patas 3D e a colisão têm que concordar sobre onde ela
    // fica. Sorteá-la em dois lugares deixava espinho em cima do lugar safe.
    let gapFacing = null;
    if (def.special === 'obstacles' && def.legCount) {
      gapFacing = Math.random() * Math.PI * 2;
      pts = MonsterSkillManager.cageSpots(def, gapFacing);
    } else if (shape === 'ring' && def.gapAngle) {
      // Sonar: a brecha de CADA onda tambem e decidida uma vez so, aqui, e vai
      // no telegraph. Sorteada de novo na resolucao, o setor seguro desenhado
      // ficaria num lugar e o buraco no dano em outro.
      gapFacing = Math.random() * Math.PI * 2;
    }

    // Chuva de destroços (Cemitério de Naufrágios): não existe "um cast" — são
    // N quedas miradas, cada uma com o próprio aviso. Sai ANTES do broadcast do
    // campo inteiro, que é justamente o que desenhava os seis de uma vez.
    if (def.dropIntervalMs) {
      return this._castAimedRain(player, def, cx, cz, castMs, effectPayload);
    }

    // 1. Aviso imediato — todo mundo no mapa vê o telegraph com o tempo certo.
    addEvent({
      type:     'monster_skill_cast',
      casterId: player.id,
      crit:     player._relicCrit,
      skill:    def.skill,
      vfx:      def.vfx,
      shape,
      special:  def.special || null,
      // originX/Z = onde o VFX é ancorado (barco no cone/linha, cursor no resto);
      // targetX/Z = o cursor, que define a direção. Para circle/ring/multi os
      // dois coincidem.
      originX:  ox,
      originZ:  oz,
      targetX:  cx,
      targetZ:  cz,
      dirX:     dx,
      dirZ:     dz,
      castMs,
      points:   pts,
      // Geometria que o cliente precisa pra dimensionar o VFX 1:1 com o dano.
      params: {
        radius: def.radius, safeRadius: def.safeRadius, eruptRadius: def.eruptRadius,
        length: def.length, width: def.width, angle: def.angle, band: def.band,
        spread: def.spread, count: def.count, holdMs: def.holdMs,
        durationMs: def.durationMs, chargeMs: def.chargeMs, fuseMs: def.fuseMs,
        hatchMs: def.hatchMs, sectorCount: def.sectorCount, ringCount: def.ringCount,
        nodeCount: def.nodeCount, phaseCount: def.phaseCount, armCount: def.armCount,
        rayCount: def.rayCount, stepCount: def.stepCount, legCount: def.legCount,
        pairCount: def.pairCount, finalRadius: def.finalRadius,
        collapseRadius: def.collapseRadius, coreRadius: def.coreRadius,
        ticks: def.ticks || null,
        spinSpeed: def.spinSpeed,
        // Extensão VISUAL (não o raio de dano): a cadeia alcança
        // count×jumpRange e a orbe viaja orbSpeed×lifeMs. Sem estes o cliente
        // dimensionava o quad pelo raio de dano (8 un!) e cortava o efeito.
        // Cardume de Torpedos: o compasso da salva e a abertura do leque. O
        // desenho precisa dos dois para dimensionar o quad e para a marcação
        // do casco pulsar no ritmo em que os tubos vão disparar.
        salvoMs: def.salvoMs, fanAngle: def.fanAngle,
        // Invocações: o desenho precisa saber QUANTOS bichos e de que jeito eles
        // se comportam para montar a cena do cast (o círculo de emergência, a
        // órbita da escolta). O voo de cada um chega depois, por evento.
        summonMode: def.summonMode, orbitRadius: def.orbitRadius,
        triggerRadius: def.triggerRadius,
        // Tarrafa de Raios: a malha fica no chão exatamente o tempo do stun. O
        // `cc` inteiro não vai no payload (é mecânica, não desenho), mas ESTE
        // número é as duas coisas — sem ele a rede sumia antes de o alvo soltar.
        stunMs: def.cc && def.cc.stunMs,
        // Tromba do Arauto: diz ao cliente que a coisa GRUDA, e por isso o quad
        // dela não precisa (nem pode) cobrir o percurso inteiro.
        sticky: def.sticky || false,
        jumpRange: def.jumpRange, orbSpeed: def.orbSpeed, lifeMs: def.lifeMs,
        burstRadius: def.burstRadius, stepDistance: def.stepDistance,
        stepCount: def.stepCount, firstDistance: def.firstDistance,
        beamWidth: def.beamWidth, obstacleRadius: def.obstacleRadius,
        // Medidas com nome próprio que ficavam de fora do payload: sem elas o
        // desenho caía no default da demo, que é a escala de BICHO — a mordida
        // do Vórtice em 80 quando o dano é 32, o braço da Ceifa em 28 quando é
        // 12, a corrente dos Grilhões em 120 quando é 45.
        catchRadius: def.catchRadius, biteRadius: def.biteRadius,
        armWidth: def.armWidth, maxLength: def.maxLength,
        // Lente do Abismo: tempo de viagem do feixe pelo corredor. O cliente já
        // lia `travelMs` (ver _apply_monster_params) e ninguém o mandava — o
        // raio atravessava no default da demo enquanto o dano saía no compasso
        // do servidor.
        travelMs: def.travelMs,
        // Canalizada: o cliente gira o efeito seguindo o cursor.
        // `turnRate` vai junto porque é ele que decide QUEM gira o desenho: com
        // cap, o giro é sempre o que o servidor manda (`relic_skill_aim`), até
        // para quem lançou — senão o desenho colado no mouse mostraria o feixe
        // onde ele não está. Ver spawn_monster_skill no cliente.
        follow: def.follow || false, turnRate: def.turnRate || 0,
        // Dash: o corredor fica PLANTADO onde nasceu (o caster viaja, o
        // desenho não) — sem isto a faixa arrasta junto com o barco.
        dash: def.dash || false,
        // Jaula: a brecha única, decidida acima — visual e colisão concordam.
        gapFacing,
        // Vao das ondas do Sonar — ver a nota no attack-manager.
        gapAngle: def.gapAngle, gapStep: def.gapStep, ringCount: def.ringCount,
        expandMs: def.expandMs, ringIntervalMs: def.ticks && def.ticks.intervalMs,
        sectorCount: def.sectorCount, sectorOffset: def.sectorOffset,
        atCaster: def.atCaster || false,
        // ── Arauto do Abismo ────────────────────────────────────────────────
        // Quantas colunas/luzes, quanto tempo a luz gruda e as medidas da cela.
        // Sem estes o desenho cai no default da demo, que é a escala de BICHO —
        // a mesma armadilha silenciosa documentada acima.
        maxTargets: def.maxTargets, lightCount: def.lightCount,
        lightSpeed: def.lightSpeed, seekRadius: def.seekRadius,
        wallLength: def.wallLength, wallThickness: def.wallThickness,
      },
    }, mapLvl);

    // 1b. NPCs tentam desviar da área perigosa (mesmo hook do raio/meteoro).
    const danger = def.radius || def.length || def.spread || 60;
    getMapManagerFor(mapLvl)?.notifyDangerZone(ox, oz, danger, castMs);

    // 2. Specials que não são "forma + dano" resolvem por conta própria.
    if (def.special === 'swallow') return this._castSwallow(player, def, ox, oz, castMs, effectPayload);
    if (def.special === 'mirror')  return this._castMirror(player, def, cx, cz, castMs, effectPayload);
    if (def.special === 'orb') return this._castHunterOrb(player, def, cx, cz, castMs, effectPayload);
    // Cardume de Torpedos: a salva sai em sequência, cada torpedo com o próprio
    // alvo e o próprio relógio — não cabe no laço de levas, que resolve sempre
    // a mesma forma no mesmo lugar.
    if (def.special === 'torpedo') return this._castTorpedoes(player, def, dx, dz, castMs, effectPayload);
    // Bichos INVOCADOS: quatro leituras diferentes com um motor só (ver lá).
    if (def.special === 'summons') return this._castSummons(player, def, cx, cz, castMs, effectPayload);
    if (def.special === 'bulwark') return this._castBulwark(player, def, castMs, effectPayload);
    if (def.special === 'obstacles') this._castObstacles(player, def, ox, oz, pts, castMs, dx, dz);
    if (def.special === 'charge')   return this._castCharge(player, def, ox, oz, dx, dz, pts, effectPayload);
    if (def.special === 'tidewall') {
      this._castTideWall(player, def, ox, oz, dx, dz, castMs, effectPayload);
      return;
    }
    // Faróis de Carne: as luzes escolhem alvo sozinhas e estouram 5 s depois.
    if (def.special === 'lights') {
      this._castLights(player, def, castMs, effectPayload);
      return;
    }
    // Espiral do Abismo / Marcha Fúnebre: o anel é PAREDE, não linha de dano.
    if (def.special === 'collapse') {
      this._castCollapsingRing(player, def, ox, oz, castMs, effectPayload);
      return;
    }
    // Sonar do Abismo: as ondas são SIMULADAS (correm de 0 até `radius` em
    // `expandMs`), não resolvidas em 4 levas grossas. Isto só existia do lado
    // do bicho (_runSonar no attack-manager): na mão do jogador o `band` de 11
    // un pulava em 4 passos de ~24 un, então 54% do raio nunca era tocado — o
    // anel passava por cima do alvo sem nada acontecer. Era o "o dano está
    // esquisito, não parece estar acertando quando devia".
    if (def.special === 'sonar') {
      this._runSonar(player, def, ox, oz, castMs, gapFacing, effectPayload);
      return;
    }
    // Prisão de Terra: só as 4 paredes, dano nenhum.
    if (def.special === 'prison') {
      this._castPrison(player, def, cx, cz, castMs, effectPayload);
      return;
    }
    // Pilares do Juízo: resolve uma vez por ALVO travado, não no cursor.
    if (def.targetMode === 'all_players_in_range') {
      this._castPillars(player, def, shape, castMs, effectPayload);
      return;
    }

    // 3. Resolução normal: uma ou várias levas de acerto.
    const ticks = def.ticks;
    const total = ticks ? (ticks.count || 1) : 1;
    const step  = ticks ? (ticks.intervalMs || 400) : 0;
    const hits  = [];

    for (let i = 0; i < total; i++) {
      setTimeout(() => {
        if (player.dead) return;   // caster morreu no meio — cancela o resto
        let tdx = dx, tdz = dz;
        let tox = ox, toz = oz;
        // Area presa ao lancador: re-le a posicao do barco a cada leva.
        //
        // `rays` entra junto com o `atCaster` e NAO e detalhe: a coroa gira em
        // volta de quem lancou e o cliente ancora o desenho NO BARCO (ver
        // spawn_monster_skill), entao ela navega junto. O dano, porem, ficava
        // travado em onde o barco estava no instante do cast — bastava andar
        // meio segundo para os espinhos rodarem em volta de voce enquanto o
        // acerto varria um circulo vazio la atras. Era o "a Coroa nao esta
        // pegando" do playtest, e valia igual para a Salva de Espinhos (r55).
        if (def.atCaster || shape === 'rays') {
          tox = player.x;
          toz = player.z;
        }
        if (def.follow) {
          // Canalizada: re-mira no CURSOR a cada tick. O cliente manda
          // `relic_aim` enquanto a skill roda (o jogo inteiro mira com o mouse,
          // não com a proa — mirar pela proa obrigava a girar o barco).
          // Sem mira recente, cai na proa como último recurso.
          tox = player.x;
          toz = player.z;
          const aim = player._relicAim;
          if (aim && Date.now() - aim.t < 1000) {
            const ax = aim.x - player.x, az = aim.z - player.z;
            const al = Math.hypot(ax, az);
            if (al > 0.001) { tdx = ax / al; tdz = az / al; }
          } else {
            tdx = Math.sin(player.rotation || 0);
            tdz = Math.cos(player.rotation || 0);
          }

          // ── Cap de giro, do lado do JOGADOR ─────────────────────────────
          // O bicho já tinha isto (attack-manager); a relíquia não. Sem cap o
          // cone SALTAVA para o cursor a cada leva: quem canalizava acertava
          // sempre, e quem estava do outro lado via um desenho parado no
          // ângulo em que o cast começou — "para o inimigo ela está parada,
          // mas quem está usando está mexendo".
          //
          // O `_aimAngle` vive no player enquanto o golpe roda; começa na
          // direção do cast para o primeiro passo sair do telegraph, não de um
          // ângulo herdado do uso anterior.
          if (def.turnRate) {
            if (i === 0 || player._skillAimAngle == null) {
              player._skillAimAngle = Math.atan2(dz, dx);
            }
            const passo = def.turnRate * (step || 160) / 1000;
            let diff = Math.atan2(tdz, tdx) - player._skillAimAngle;
            // Normaliza para [-PI, PI]: sem isto o feixe daria a volta pelo
            // caminho longo quando o cursor cruzasse o -180.
            diff = Math.atan2(Math.sin(diff), Math.cos(diff));
            player._skillAimAngle += Math.max(-passo, Math.min(passo, diff));
            tdx = Math.cos(player._skillAimAngle);
            tdz = Math.sin(player._skillAimAngle);
          }

          // ── E o giro vai NO AR ──────────────────────────────────────────
          // O cliente só sabia re-mirar o cast LOCAL (que segue o próprio
          // mouse). Para todos os OUTROS — inclusive o alvo — o desenho ficava
          // congelado na direção do telegraph enquanto o dano varria. É o par
          // exato do `npc_skill_aim` que o bicho já mandava; o nome muda só
          // porque o cliente encontra o lançador por casterId e não por npcId.
          addEvent({
            type: 'relic_skill_aim', casterId: player.id,
            x: player.x, z: player.z, dirX: tdx, dirZ: tdz,
          }, mapLvl);
        }
        // Geometria que ANDA (frente do Sonar, passo da Barragem) le a leva
        // atual daqui — ver inShape().
        const tickDef = { ...def, _tickIndex: i, _tickCount: total, _gapFacing: gapFacing };
        const batch = this._resolveOnce(player, tickDef, shape, tox, toz, tdx, tdz, pts, ticks, i);
        for (const h of batch) hits.push(h);

        // ── Golpe de ABERTURA ─────────────────────────────────────
        // Numa canalizada, `ticks.pct` SUBSTITUI o `damagePct` em todas as
        // levas — inclusive na primeira. Quem quer o par "pancada ao encostar +
        // corrosão enquanto dura" (a Lente do Abismo) não tinha como pedir: o
        // número grande do dado ficava morto e a skill lia como um cutucão
        // repetido. `burstPct` é essa primeira camada, e só ela.
        //
        // Sem `cc`: o controle já sai na leva 0 pelo caminho normal, e aplicar
        // duas vezes no mesmo frame renovaria o stun de graça.
        if (def.burstPct > 0 && i === 0) {
          const abertura = this._resolveOnce(player,
            { ...tickDef, damagePct: def.burstPct, cc: null },
            shape, tox, toz, tdx, tdz, pts, null, 0);
          for (const h of abertura) { hits.push(h); batch.push(h); }
        }

        // ── Cada leva anuncia o PRÓPRIO acerto ────────────────────────────────
        // Antes as levas só eram somadas aqui e o `monster_skill_strike` saía UMA
        // vez, depois da última — no Jato do Pescoço isso é 3,5 s depois do
        // clique. Durante toda a canalização não aparecia número nenhum e a
        // skill lia como "não está dando dano" (a queixa do playtest), enquanto o
        // MESMO golpe na mão do bicho mostra o dano leva a leva (npc_attack_hit).
        // Agora as duas faces relatam no mesmo ritmo.
        //
        // `tick` deixa o cliente saber que não é o primeiro anúncio: só o de
        // índice 0 bate na água, senão uma canalizada de 20 levas viraria 20
        // ondas. Pelo mesmo motivo os `points` (sub-áreas do `multi`) só vão na
        // primeira — é lá que o splash de cada poça acontece.
        if (total > 1 && batch.length > 0) {
          addEvent({
            type: 'monster_skill_strike', casterId: player.id, skill: def.skill,
            vfx: def.vfx, originX: tox, originZ: toz,
            points: i === 0 ? pts : null, hits: batch,
            radius: def.radius || def.length || 40, tick: i,
          }, mapLvl);
        }
      }, castMs + i * step);
    }

    // Dash (Investida/Bote): o caster VIAJA até o fim do corredor no momento
    // do resolve — a "investida" é de verdade, não só uma faixa de dano.
    if (def.dash) {
      setTimeout(() => {
        if (player.dead) return;
        player.x = ox + dx * (def.length || 100);
        player.z = oz + dz * (def.length || 100);
        this.ctx.clampToMap(player);   // nunca dentro de ilha/muro/fora do mapa
      }, castMs);
    }

    // 4. Broadcast do resultado depois da última leva. As canalizadas já
    //    anunciaram leva a leva acima — repetir aqui mostraria o dano duas vezes.
    setTimeout(() => {
      if (total === 1) {
        // Área que ANDA com o barco (`atCaster`, `rays`): o laço de levas já lê a
        // posição viva, mas este anúncio final ficava com a do CAST. Num campo de
        // 1,1 s de carga isso são ~50 un de diferença — a onda na água e os arcos
        // do desenho saíam de onde o casco esteve, não de onde ele está.
        const sx = (def.atCaster || shape === 'rays') ? player.x : ox;
        const sz = (def.atCaster || shape === 'rays') ? player.z : oz;
        addEvent({
          type: 'monster_skill_strike', casterId: player.id, skill: def.skill,
          vfx: def.vfx, originX: sx, originZ: sz, points: pts, hits,
          radius: def.radius || def.length || 40,
        }, mapLvl);
      }
      const npcHits = hits.filter(h => h.isNPC).length;
      if (npcHits > 0) this.ctx.grantSkillXp(player, 'reliquia', npcHits * 14);
    }, castMs + Math.max(0, total - 1) * step + 60);

    effectPayload.targetX = ox;
    effectPayload.targetZ = oz;
    effectPayload.castMs  = castMs;
  }

  /**
   * Giro das raias da Coroa de Espinhos NESTE instante, em ângulo de MUNDO.
   *
   * A skill 2D gira linearmente: `spin(t) = spin_speed * t`, com t contado
   * desde o começo do cast (o telegraph já gira). E o desenho no mundo ainda
   * soma a rotação do anchor, que aponta na direção do alvo. Sem somar as
   * duas, o dano ficava congelado em 0° enquanto a coroa girava na tela — o
   * jogador ficava na brecha que via e levava dano da brecha real.
   *
   * `tSec` é o tempo desde o início do cast; `dx/dz` a direção do golpe.
   */
  static crownSpin(def, tSec, dx, dz) {
    return (def.spinSpeed || 0) * tSec + Math.atan2(dz, dx);
  }

  /** Uma leva de acerto (um tick, ou o acerto único quando não há ticks). */
  _resolveOnce(player, def, shape, ox, oz, dx, dz, pts, ticks, index) {
    const { relicDamageFor } = this.ctx;

    // Coroa de Espinhos: o acerto tem que acompanhar o giro do desenho.
    if (shape === 'rays') {
      const castMs = def.castMs || def.castTime || 800;
      const stepMs = ticks ? (ticks.intervalMs || 250) : 0;
      const tSec = (castMs + index * stepMs) / 1000;
      def = { ...def, _spinNow: MonsterSkillManager.crownSpin(def, tSec, dx, dz) };
    }
    let targets = (shape === 'chain')
      ? this._chainTargets(player, def, ox, oz)
      : this._targetsIn(player, def, shape, ox, oz, dx, dz, pts);
    if (targets.length === 0) return [];

    // ── Onda que VARRE: uma parede, um acerto ────────────────────────────────
    // O Sonar amostra a MESMA onda nove vezes enquanto ela corre (ver
    // utils/sonar-sweep.js). Sem este conjunto, quem se afastasse junto com a
    // parede ficava dentro dela por vários passos e pagava a onda duas ou três
    // vezes. `_sweepSeen` é por ONDA e nasce no _runSonar.
    if (def._sweepSeen) {
      targets = targets.filter(t => !def._sweepSeen.has(t.e.id));
      for (const t of targets) def._sweepSeen.add(t.e.id);
      if (targets.length === 0) return [];
    }

    // Dano do tick: `ticks.pct` substitui o damagePct quando presente.
    const pct = ticks && ticks.pct != null ? ticks.pct : def.damagePct;
    let dmg = relicDamageFor(player, { ...def, damagePct: pct });

    // ── Comunhão do Coral: o dano TOTAL é dividido entre os atingidos ────────
    if (def.special === 'soak') dmg = Math.max(1, Math.round(dmg / targets.length));

    const out = [];
    let drained = 0;
    targets.forEach((t, k) => {
      // Cadeia perde força a cada pulo.
      let d = dmg;
      if (shape === 'chain') d = Math.max(1, Math.round(dmg * Math.pow(def.falloff || 0.75, k)));
      const h = this._damage(player, t, d);
      if (shape === 'chain') h.chainIndex = k;
      out.push(h);
      drained += d;
      // CC inteiro só na primeira leva; das seguintes, só o slow renova —
      // ver a nota no _applyCC.
      this._applyCC(player, t, def.cc, ox, oz, index !== 0);
      // ── `dot`: o golpe deixa o alvo QUEIMANDO/ENVENENADO ────────────────
      // Reaproveita o `e.dots` que o jogo inteiro já usa (bala de fogo, bala de
      // sangue, Óleo Incendiário): o laço `processDots` do server.js tica,
      // manda o número ao cliente e resolve a morte por veneno com recompensa
      // e respawn. Um laço próprio aqui teria de repetir tudo isso.
      //
      // Renova em vez de empilhar (`src: 'skill'`): seis levas de Pústula são
      // um veneno que se mantém aceso, não seis venenos em paralelo — que
      // ticariam em compassos diferentes e viraria uma chuva de números.
      if (def.dot && def.dot.pct > 0) {
        const alvo = t.e;
        if (!alvo.dots) alvo.dots = [];
        alvo.dots = alvo.dots.filter(x => x.src !== 'skill');
        alvo.dots.push({
          dmg:  Math.max(1, Math.round(relicDamageFor(player, { ...def, damagePct: def.dot.pct }))),
          tick: def.dot.tickMs || 1000,
          dur:  def.dot.durMs  || 3000,
          next: Date.now() + (def.dot.tickMs || 1000),
          ownerId: player.id, effect: def.dot.effect || 'fire', src: 'skill',
        });
      }
    });

    // O SILÊNCIO saiu daqui em 2026-09-05. Ele nunca fez sentido na mão do
    // jogador — NPC não usa relíquia, então em PvE era uma linha de texto sem
    // efeito — e o Coro, única skill que o tinha, convergiu para a salva de
    // rostos. Do lado do BICHO ele continua vivo, agora como o campo
    // `silenceMs` lido no laço de acerto do attack-manager (não mais como um
    // `special`, porque silêncio é debuff, não forma de resolver área).

    // ── Sorvo sem Olhos: o golpe cobra em MANA ───────────────────────────────
    // Único efeito do jogo que ataca o recurso em vez da vida. Contra quem não
    // tem mana (todo NPC) a fome vira dano extra — senão a relíquia seria letra
    // morta em PvE, que é onde ela mais vai ser usada.
    if (def.special === 'manaburn') {
      const queima = def.manaBurn || 0;
      // ── O sorvo BEBE: o que ele queima volta para quem lançou ────────────
      // "Sorvo" nunca quis dizer "apagar": a criatura cega procura o que faz o
      // casco brilhar porque ela SE ALIMENTA disso. Queimar a mana do outro e
      // não ganhar nada fazia a relíquia custar 7 de mana para produzir um
      // efeito que o lançador não sentia — e num jogo com regeneração de 0,5/s
      // sete de mana é caro. Agora ela se paga: sorver o bastante devolve o
      // custo do uso, que é o que fecha a fantasia da skill.
      let sorvido = 0;
      for (const t of targets) {
        const e = t.e;
        if (!t.isNPC && e.maxMana != null) {
          const antes = e.mana || 0;
          e.mana = Math.max(0, antes - queima);
          const perdeu = antes - e.mana;
          sorvido += perdeu;
          if (perdeu > 0) {
            this.ctx.sendTo(e.ws, {
              type: 'mana_burn', targetId: e.id, amount: perdeu,
              mana: e.mana, maxMana: e.maxMana,
            });
          }
        } else {
          // Sem mana para queimar: o sorvo come carne.
          const extra = relicDamageFor(player, { ...def, damagePct: def.noManaDamagePct || 0 });
          if (extra > 0) {
            const h = this._damage(player, t, extra);
            out.push(h);
          }
          // Sem mana para beber, a criatura tira do próprio bicho: uma fração
          // do que ela sorveria de um jogador. Senão a relíquia continuaria
          // sendo pura despesa em PvE, que é onde ela mais vai ser usada.
          sorvido += queima * 0.5;
        }
      }
      // Devolve UMA vez por leva, com teto — a soma de seis levas sobre cinco
      // alvos encheria o copo sozinha e a mana deixaria de ser recurso.
      if (sorvido > 0 && player.maxMana != null) {
        const ganho = Math.min(Math.round(sorvido), Math.max(0, player.maxMana - (player.mana || 0)));
        if (ganho > 0) {
          player.mana = (player.mana || 0) + ganho;
          this.ctx.sendTo(player.ws, {
            type: 'mana_siphon', targetId: player.id, amount: ganho,
            mana: player.mana, maxMana: player.maxMana,
          });
        }
      }
    }

    // ── Sanguessuga: parte do dano volta como cura pro caster ────────────────
    if (def.special === 'drain' && drained > 0) {
      const heal = Math.round(drained * (def.drainHealPct || 0.5));
      player.hp = Math.min(player.maxHp || player.hp, player.hp + heal);
      // `targetId` sem o qual o cliente desenha o "+N" mas não mexe na barra de
      // vida: o handler só atualiza o HUD quando o alvo da cura é você, e sem o
      // campo ele nunca casava (ver _handle_heal em main.gd).
      this.ctx.sendTo(player.ws, {
        type: 'heal', targetId: player.id, amount: heal,
        hp: player.hp, maxHp: player.maxHp, source: 'relic_drain',
      });
    }
    return out;
  }

  // ── Specials ───────────────────────────────────────────────────────────────

  /**
   * Espiral do Abismo (r25) e Marcha Fúnebre (r47): o anel é PAREDE.
   *
   * ── O problema que isto resolve ───────────────────────────────────────────
   * As duas desenham a mesma coisa — uma coroa (esferas / espinhos) que fecha
   * o cerco em passos — e as duas resolviam como um `ring` comum: uma linha de
   * dano que se desviava SAINDO dela. Ou seja, a resposta certa era atravessar
   * a parede que a tela mostrava se aproximando. O desenho e a mecânica diziam
   * coisas opostas, e a queixa do playtest ("não faz sentido com o visual")
   * era exatamente isso.
   *
   * ── O que ele faz ─────────────────────────────────────────────────────────
   * A cada leva o anel tem um raio (de `radius` até `collapseTo`, em
   * `phaseCount` passos). Quem estiver ALÉM dele é empurrado para dentro: a
   * coroa é sólida, e ela varre. Quem já está dentro só leva o tique do
   * roçar — a punição por estar perto da parede, não por existir.
   *
   * No fim, se `burstAtCenter`, o miolo explode com o dano CHEIO num raio de
   * `collapseRadius`/`eruptRadius`. É o clímax que o desenho sempre teve e que
   * nenhum dos dois motores chegava a bater — na Marcha Fúnebre a explosão
   * central estava até na descrição da relíquia.
   *
   * A leitura vira: deixe-se apertar (não adianta correr da parede) e escolha
   * ONDE estar quando o miolo abrir. Duas decisões, nenhuma delas "fuja".
   *
   * ── Por que empurrar por posição e não por wallManager ───────────────────
   * Um anel de obstáculos reais seria uma dúzia de paredes reposicionadas a
   * cada 220 ms. O wallManager foi feito para retângulos que ficam parados
   * (Muro de Pedra, Jaula de Patas); mover doze deles dez vezes daria
   * tranco no `pushOutOfWalls` e o barco pularia. A borda móvel é uma conta só
   * — e é a mesma família do `cc.pullTo`, que o motor já aplica assim.
   */
  _castCollapsingRing(player, def, ox, oz, castMs, effectPayload) {
    const { addEvent, wallManager } = this.ctx;
    const mapLvl = player.mapLevel || 1;
    const ticks  = def.ticks || { count: 8, intervalMs: 500, pct: 0.2 };
    const total  = Math.max(1, ticks.count || 8);
    const step   = ticks.intervalMs || 500;
    const deR    = def.radius || 100;
    const ateR   = def.collapseTo || def.finalRadius || def.eruptRadius || 30;
    const banda  = def.band || Math.max(12, (deR - ateR) / total);
    const hits   = [];
    // Último PASSO em que a coroa de espinhos foi (re)plantada — ver a nota do
    // `tangible` mais abaixo. -1 = ainda nenhum.
    let passoPlantado = -1;

    for (let i = 0; i < total; i++) {
      setTimeout(() => {
        if (player.dead) return;
        // Raio do anel NESTA leva.
        //
        // O aperto acontece em `phaseCount` PASSOS, não numa rampa contínua: é
        // o que o desenho 2D mostra ("a arena aperta em 4 passos") e é o que dá
        // à skill o compasso que se lê. As levas de dano são mais frequentes
        // que os passos — várias levas caem no mesmo raio, e é assim que o
        // roçar na parede cobra por continuar encostado nela.
        const passos = Math.max(1, def.phaseCount || total);
        const passo  = passos === 1 ? 0 : Math.floor((i * passos) / total) / (passos - 1);
        const raio   = deR + (ateR - deR) * Math.min(1, passo);
        // Onde a parede estava no passo ANTERIOR. No primeiro passo ela vem de
        // fora do anel inicial, então o raio de partida é o próprio `deR`.
        const passoAnt = passos === 1 ? 0 : Math.max(0, Math.floor((i * passos) / total) - 1) / (passos - 1);
        const raioAnt  = i === 0 ? deR : deR + (ateR - deR) * Math.min(1, passoAnt);

        // ── Quem a coroa alcança nesta leva ─────────────────────────────────
        // NÃO é uma faixa fina no raio atual: é tudo o que está entre o anel de
        // agora e onde ele estava no passo anterior — a área que a parede
        // acabou de VARRER. Com faixa fina, um passo de 30 un sobre uma faixa
        // de 12 deixava 60% do caminho sem tocar em nada, e quem não é
        // empurrado (chefe) simplesmente nunca era atingido: a Marcha Fúnebre
        // não fazia dano nenhum num chefe, que é onde uma lendária mais precisa
        // fazer. A parede varre o que ela passa.
        const anelDef = {
          ...def,
          radius: Math.max(raioAnt, raio) + banda / 2,
          safeRadius: Math.max(0, raio - banda / 2),
        };
        const batch = this._resolveOnce(player, anelDef, 'ring', ox, oz, 0, 1, null, ticks, i);
        for (const h of batch) hits.push(h);

        // ── Espinhos TANGÍVEIS ──────────────────────────────────────
        // O empurrão por posição (logo abaixo) reposiciona quem está fora do
        // anel UMA vez por leva. Entre uma leva e outra dava para remar de volta
        // para fora, e a coroa que a tela mostra fechando não segurava ninguém:
        // o desenho prometia parede e a física entregava um empurrãozinho.
        //
        // Com `tangible` os espinhos entram no wallManager — as MESMAS caixas
        // que o Muro de Pedra e a Jaula usam, respeitadas por jogador e por NPC
        // no mesmo ponto de colisão. Plantados uma vez por PASSO (4 no golpe
        // inteiro), não por leva: reposicionar uma dúzia de caixas a cada 500 ms
        // é o que o wallManager aguenta sem dar tranco no barco; a cada leva não
        // seria.
        //
        // Os dois se completam em vez de competir: o empurrão É o aperto (ele
        // traz quem está fora para dentro), e a parede é o que impede de sair de
        // novo — `pushOutOfWalls` empurra para a saída MAIS PERTO, que para quem
        // já está dentro do anel é para dentro.
        const passoIdx = Math.floor((i * passos) / total);
        if (def.tangible && wallManager && passoIdx !== passoPlantado) {
          passoPlantado = passoIdx;
          const n = Math.max(6, Math.min(18, def.spikeCount || 14));
          // Meia-largura que SELA o anel: o arco entre dois espinhos vizinhos
          // (2πR/n) tem de caber no comprimento de um (2·meia). O 1,06 é a folga
          // que impede um vazamento fino na quina de duas caixas.
          const meia = (Math.PI * raio / n) * 1.06;
          const esp  = Math.max(3, banda * 0.25);
          // Vale até o passo seguinte; o wallManager filtra por tempo sozinho.
          const dura = Math.ceil((step * total) / Math.max(1, passos)) + 150;
          const stamp = Date.now();
          for (let k = 0; k < n; k++) {
            const a = (k / n) * Math.PI * 2;
            // Tangente ao círculo. O eixo do COMPRIMENTO de uma caixa é o
            // basis.x = (cos rot, −sin rot); igualar isso a (−sin a, cos a) dá
            // rot = −(a + π/2). Errar aqui põe os espinhos radiais e o anel vaza
            // por toda parte.
            wallManager.addWall(mapLvl, {
              id: `fm_${player.id}_${stamp}_${k}`,
              x: ox + Math.cos(a) * raio, z: oz + Math.sin(a) * raio,
              hw: meia, hh: esp, rot: -(a + Math.PI / 2), durationMs: dura,
            });
          }
        }

        // ── E o empurrão ────────────────────────────────────────────────────
        // Todo inimigo além do anel é trazido para a borda de dentro. Chefe
        // fica de fora pela convenção do projeto (chefe não é deslocado), mas
        // continua levando o tique do roçar como qualquer um.
        const fora = this._targetsIn(player, { radius: deR + banda * 2 }, 'circle', ox, oz, 0, 1, null);
        const empurrados = [];
        for (const t2 of fora) {
          const e = t2.e;
          if (e.isBoss) continue;
          const dx = e.x - ox, dz = e.z - oz;
          const d  = Math.hypot(dx, dz);
          if (d <= raio || d < 0.001) continue;
          e.x = ox + (dx / d) * raio;
          e.z = oz + (dz / d) * raio;
          this.ctx.clampToMap(e);
          empurrados.push({ id: e.id, x: e.x, z: e.z });
        }

        addEvent({
          type: 'relic_collapse_step', casterId: player.id, skill: def.skill,
          vfx: def.vfx, originX: ox, originZ: oz, radius: raio, band: banda,
          step: i, stepCount: total, pushed: empurrados,
        }, mapLvl);

        if (batch.length > 0) {
          addEvent({
            type: 'monster_skill_strike', casterId: player.id, skill: def.skill,
            vfx: def.vfx, originX: ox, originZ: oz, points: null, hits: batch,
            radius: raio, tick: i,
          }, mapLvl);
        }
      }, castMs + i * step);
    }

    // ── O miolo ────────────────────────────────────────────────────────────
    if (def.burstAtCenter) {
      setTimeout(() => {
        if (player.dead) return;
        const raio = def.collapseRadius || def.eruptRadius || ateR;
        // `damagePct` cheio (não o `ticks.pct`): a explosão central é O golpe,
        // e os tiques do aperto eram o preço de chegar até aqui. Passar `null`
        // no lugar de `ticks` é o que faz o _resolveOnce usar o dano cheio.
        const batch = this._resolveOnce(player, { ...def, radius: raio, safeRadius: 0 },
          'circle', ox, oz, 0, 1, null, null, 0);
        for (const h of batch) hits.push(h);
        // Visual: o clarão do miolo abrindo. Sem `hits` — ver a nota acima.
        addEvent({
          type: 'relic_collapse_burst', casterId: player.id, skill: def.skill,
          vfx: def.vfx, originX: ox, originZ: oz, radius: raio,
        }, mapLvl);
        // `tick: total` porque o miolo É a última leva de uma sequência de
        // levas, e o cliente escolhe a apresentação do número pela PRESENÇA
        // dessa marca. Anunciá-lo sem ela faria a explosão passar por golpe
        // avulso no meio de um fluxo — ver relic-tick-reporting.test.js.
        addEvent({
          type: 'monster_skill_strike', casterId: player.id, skill: def.skill,
          vfx: def.vfx, originX: ox, originZ: oz, points: null, hits: batch,
          radius: raio, tick: total,
        }, mapLvl);
        const npcHits = hits.filter(h => h.isNPC).length;
        if (npcHits > 0) this.ctx.grantSkillXp(player, 'reliquia', npcHits * 14);
      }, castMs + total * step);
    }

    effectPayload.targetX = ox;
    effectPayload.targetZ = oz;
    effectPayload.castMs  = castMs;
  }

  /**
   * Sonar do Abismo: as ondas CORREM, em vez de resolverem em N levas grossas.
   *
   * Cópia fiel do `_runSonar` do attack-manager, do lado da relíquia — a versão
   * jogável nunca teve simulador e caía no cálculo de reserva do `inShape`
   * (`front = radius * (k+1)/n`). Com band 11 sobre raio 95 em 4 levas, a
   * frente pulava 24 un por vez sobre uma faixa de 11: **mais da metade do raio
   * nunca era tocada**, e quem via o anel passar por cima não levava nada.
   *
   * A varredura é a do `sonarSweep`, a MESMA que o bicho usa: faixas
   * encostadas que ladrilham [0, radius], amostradas no centro de cada uma.
   * Ver a nota do utils/sonar-sweep.js — o relógio que estava aqui deixava a
   * última faixa de fora, e quem estava parado na borda escapava.
   *
   * `_sweepSeen`: uma onda cobra UMA vez de cada alvo. Antes isso era acidente
   * da aritmética e só valia para alvo PARADO; um NPC afastando-se junto com a
   * parede levava a mesma onda duas ou três vezes.
   */
  _runSonar(player, def, ox, oz, castMs, gapFacing, effectPayload) {
    const { addEvent } = this.ctx;
    const mapLvl = player.mapLevel || 1;
    const rings  = def.ringCount || (def.ticks && def.ticks.count) || 4;
    const gapMs  = (def.ticks && def.ticks.intervalMs) || 1200;
    const { steps, stepMs, fronts, timeAt, endMs } = sonarSweep(def);
    const hits   = [];

    // Uma cadeia de timers POR ONDA: as ondas saem defasadas de `gapMs`, que
    // não é múltiplo de `stepMs`. Num relógio único só a onda 0 cairia nos
    // instantes certos — era o que abria o buraco na borda.
    const sweep = (i, k, seen) => {
      if (player.dead) return;
      const tickDef = {
        ...def, shape: 'ring',
        _frontRadius: fronts[k], _ringIndex: i, _gapFacing: gapFacing,
        _sweepSeen: seen,
      };
      const batch = this._resolveOnce(player, tickDef, 'ring', ox, oz, 0, 1, null, def.ticks, i);
      if (batch.length > 0) {
        for (const h of batch) hits.push(h);
        addEvent({
          type: 'monster_skill_strike', casterId: player.id, skill: def.skill,
          vfx: def.vfx, originX: ox, originZ: oz, points: null, hits: batch,
          radius: fronts[k], tick: i,
        }, mapLvl);
      }
      if (k + 1 < steps) setTimeout(() => sweep(i, k + 1, seen), stepMs);
    };

    for (let i = 0; i < rings; i++) {
      const seen = new Set();
      setTimeout(() => sweep(i, 0, seen), castMs + i * gapMs + timeAt(0));
    }
    // XP uma vez só, quando a última onda acabou de varrer.
    setTimeout(() => {
      const npcHits = hits.filter(h => h.isNPC).length;
      if (npcHits > 0) this.ctx.grantSkillXp(player, 'reliquia', npcHits * 14);
    }, castMs + (rings - 1) * gapMs + endMs);

    effectPayload.targetX = ox;
    effectPayload.targetZ = oz;
    effectPayload.castMs  = castMs;
  }

  // ── O que morava aqui ──────────────────────────────────────────────────────
  // `_castMark` (a marca que andava com a vítima) e `_castBrood` (os ovos que
  // chocavam sozinhos). As duas skills viraram invocações em 2026-09-04, e
  // desde então estes dois métodos não eram alcançados por dado nenhum —
  // ninguém percebeu porque motor sem dono não dá erro, só envelhece. Saíram
  // em 2026-09-05, quando o guarda de órfãos passou a olhar para os dois lados.
  // Estão no git.

  /**
   * Bocarra Torácica: ENGOLE uma vítima. Ela é presa (mesmo `stunExpires` que o
   * resto do jogo já respeita), colada no lançador leva a leva, e no fim é
   * CUSPIDA para trás dele.
   *
   * Uma vítima só, e nunca um boss — a convenção do projeto é que chefe só leva
   * slow, e engolir um chefe seria a exceção mais gritante possível.
   *
   * A posição é reescrita a cada leva em vez de uma vez no começo: quem engoliu
   * continua navegando, e a graça é justamente ser levado junto.
   */
  _castSwallow(player, def, ox, oz, castMs, effectPayload) {
    const { addEvent, relicDamageFor } = this.ctx;
    const mapLvl = player.mapLevel || 1;
    const hold   = def.holdMs   || 2000;
    const spit   = def.spitDist || 55;
    const ticks  = def.ticks;
    const total  = Math.max(1, ticks ? (ticks.count || 1) : 1);
    const step   = ticks ? (ticks.intervalMs || 400) : 0;

    setTimeout(() => {
      if (player.dead) return;
      // A presa é a mais PRÓXIMA dentro do raio — a bocarra é curta, então quem
      // está colado é quem entra.
      //
      // Chefe entra na lista: ele não é ENGOLIDO (a convenção do projeto é que
      // boss só leva slow), mas leva as cinco levas de dano igual. Filtrá-lo
      // fora daqui fazia a relíquia não ter efeito NENHUM contra chefe — o
      // alvo em que uma épica de mapa 10 mais precisa ter efeito.
      const dentro = this._targetsIn(player, def, 'circle', player.x, player.z, 0, 1, null);
      if (dentro.length === 0) return;
      dentro.sort((a, b) =>
        Math.hypot(a.e.x - player.x, a.e.z - player.z) -
        Math.hypot(b.e.x - player.x, b.e.z - player.z));
      // Prefere quem PODE ser engolido; só cai no chefe se não houver mais nada.
      const presa = dentro.find(t => !t.e.isBoss) || dentro[0];
      const e = presa.e;
      const engolivel = !e.isBoss;
      const fim = Date.now() + hold;
      if (engolivel) {
        e.stunExpires  = Math.max(e.stunExpires || 0, fim);
        e._swallowedBy = player.id;
      }

      addEvent({
        type: 'relic_effect', casterId: player.id, effect: 'swallow',
        vfx: def.vfx, skill: def.skill, targetId: e.id, duration: hold,
      }, mapLvl);

      const hits = [];
      for (let i = 0; i < total; i++) {
        setTimeout(() => {
          if (player.dead || e.dead) return;
          // Cola a presa no lançador — é isto que faz "engolido" e não "parado".
          if (engolivel) {
            e.x = player.x;
            e.z = player.z;
          }
          const dmg = relicDamageFor(player,
            { ...def, damagePct: (ticks && ticks.pct != null) ? ticks.pct : def.damagePct });
          const h = this._damage(player, presa, dmg);
          hits.push(h);
          addEvent({
            type: 'monster_skill_strike', casterId: player.id, skill: def.skill,
            vfx: def.vfx, originX: player.x, originZ: player.z, points: null,
            hits: [h], radius: def.radius || 32, tick: i,
          }, mapLvl);
        }, i * step);
      }

      // Cuspida: sair da bocarra NÃO te devolve onde você entrou.
      setTimeout(() => {
        if (e.dead) return;
        if (engolivel) {
          const proa = player.rotation || 0;
          e.x = player.x - Math.sin(proa) * spit;
          e.z = player.z - Math.cos(proa) * spit;
          this.ctx.clampToMap(e);
          delete e._swallowedBy;
          addEvent({
            type: 'relic_effect', casterId: player.id, effect: 'spit_out',
            targetId: e.id, x: e.x, z: e.z,
          }, mapLvl);
        }
        const npcHits = hits.filter(h => h.isNPC).length;
        if (npcHits > 0) this.ctx.grantSkillXp(player, 'reliquia', npcHits * 14);
      }, hold);
    }, castMs);

    effectPayload.castMs = castMs;
  }

  /**
   * Espelho do Córtex: repete o ÚLTIMO golpe de bestiário que o alvo usou.
   *
   * Na mão do jogador o alvo é o inimigo — então ele devolve ao bicho o próprio
   * repertório dele (`npc._lastAttackId`, gravado pelo attack-manager). Sem
   * nada para copiar, cai no `fallbackSkill` em vez de perder o uso.
   *
   * O guard `_mirrorDepth` existe porque o espelho pode copiar um espelho: sem
   * ele, dois desses em cena entrariam em recursão infinita.
   */
  _castMirror(player, def, cx, cz, castMs, effectPayload) {
    const { addEvent } = this.ctx;
    const mapLvl = player.mapLevel || 1;

    setTimeout(() => {
      if (player.dead) return;
      const alvo = this._nearestEnemy(player, cx, cz);
      const copiada = (alvo && alvo._lastAttackId) || def.fallbackSkill;
      const skill = copiada && MONSTER_SKILLS[copiada];
      // Nunca copiar outro espelho (recursão) nem algo sem versão de relíquia.
      if (!skill || skill.special === 'mirror' || (player._mirrorDepth || 0) > 0) {
        addEvent({
          type: 'relic_effect', casterId: player.id, effect: 'mirror_failed',
          skill: def.skill,
        }, mapLvl);
        return;
      }
      addEvent({
        type: 'relic_effect', casterId: player.id, effect: 'mirror',
        skill: def.skill, copiedSkill: copiada, copiedName: skill.name,
      }, mapLvl);

      // Monta a versão de RELÍQUIA da skill copiada e lança com o poder desta.
      const espelhada = {
        ...skill.relic, skill: copiada, vfx: skill.vfx, shape: skill.shape,
        special: skill.special || null, follow: skill.follow || false,
        pattern: skill.pattern || null, gapAngle: skill.gapAngle || null,
        atCaster: !!skill.atCaster, turnRate: skill.turnRate || null,
        // O dano é o DESTA relíquia, não o da copiada: o espelho reproduz a
        // FORMA do golpe, senão copiar uma lendária sairia mais barato que usá-la.
        damagePct: def.damagePct,
      };
      player._mirrorDepth = 1;
      try {
        this.cast(player, espelhada, cx, cz, {});
      } finally {
        player._mirrorDepth = 0;
      }
    }, castMs);

    effectPayload.castMs = castMs;
  }

  /** Carapaça Eriçada: mitigação + reflexão temporária no próprio caster. */
  _castBulwark(player, def, castMs, effectPayload) {
    const { addEvent } = this.ctx;
    setTimeout(() => {
      if (player.dead) return;
      player.relicBulwarkExpires   = Date.now() + (def.durationMs || 5000);
      player.relicBulwarkReduction = def.damageReduction || 0.4;
      player.relicBulwarkReflect   = def.reflectPct || 0.3;
      addEvent({
        type: 'relic_effect', casterId: player.id, effect: 'bulwark',
        vfx: def.vfx, skill: def.skill, duration: def.durationMs || 5000,
      }, player.mapLevel || 1);
    }, castMs);
    effectPayload.castMs = castMs;
  }

  /**
   * Muralha de Maré (relíquia): a onda VIAJA de `ox/oz` até `length` em
   * `travelMs`, machucando quem ela alcança — uma vez só.
   *
   * Espelha o `_runTideWall` do bicho. Sem isto o mesmo golpe resolvia o
   * corredor inteiro de uma vez na mão do jogador e viajava de verdade na mão
   * do bicho — a promessa da tabela é que as duas faces acertem igual.
   */
  _castTideWall(player, def, ox, oz, dx, dz, castMs, effectPayload) {
    const { addEvent } = this.ctx;
    const mapLvl = player.mapLevel || 1;
    const reach  = def.length || 200;
    const band   = def.band || 20;
    const travel = def.travelMs || 1200;
    const stepMs = Math.max(60, Math.round((travel * band) / Math.max(reach, 1)));
    const hits   = [];
    let   relato = 0;                       // nº de anúncios já enviados

    setTimeout(() => {
      const start = Date.now();
      const step = () => {
        if (player.dead) return;
        const el = Date.now() - start;
        const front = reach * Math.min(el / travel, 1);
        const batch = this._resolveOnce(player, { ...def, _frontDistance: front },
          'line', ox, oz, dx, dz, null, null, 0);
        // O número sai QUANDO a frente passa por você, não 1,2 s depois que a
        // onda inteira terminou o percurso — mesma correção das canalizadas.
        if (batch.length) {
          hits.push(...batch);
          addEvent({
            type: 'monster_skill_strike', casterId: player.id, skill: def.skill,
            vfx: def.vfx, originX: ox + dx * front, originZ: oz + dz * front,
            points: null, hits: batch, radius: band, tick: relato++,
          }, mapLvl);
        }
        if (el >= travel) {
          const npcHits = hits.filter(h => h.isNPC).length;
          if (npcHits > 0) this.ctx.grantSkillXp(player, 'reliquia', npcHits * 14);
          return;
        }
        setTimeout(step, stepMs);
      };
      step();
    }, castMs);

    effectPayload.targetX = ox;
    effectPayload.targetZ = oz;
  }

  /**
   * Orbe Caçadora (relíquia): espelho do `_runHunterOrb` do bicho — a orbe
   * NASCE no lançador, viaja atrás do alvo vivo, corrói quem estiver dentro dela
   * a cada `orbTickMs` e estoura (dano cheio + atordoamento) ao alcançar.
   *
   * O `special: 'orb'` não tinha implementação nenhuma neste motor: a relíquia
   * caía na resolução comum e resolvia UM círculo de raio 18 EM CIMA DO PRÓPRIO
   * BARCO no fim do cast, enquanto o desenho voava atrás de um alvo escolhido
   * pelo cliente. Ou seja: a orbe que se via não era a que machucava, e o dano
   * saía onde não havia nada. Agora a posição é autoritativa e vai no
   * `relic_orb_move` — o desenho segue o mesmo ponto do dano.
   */
  _castHunterOrb(player, def, cx, cz, castMs, effectPayload) {
    const { addEvent } = this.ctx;
    const mapLvl  = player.mapLevel || 1;
    const tickMs  = def.orbTickMs   || 400;
    const life    = def.lifeMs      || 4000;
    const speed   = def.orbSpeed    || 45;      // unidades por segundo
    const radius  = def.radius      || 18;
    const catchR  = def.catchRadius || 12;
    const orb     = { x: player.x, z: player.z };
    // A presa é escolhida no CURSOR e reavaliada a cada leva: se ela morrer ou
    // trocar de mapa, a orbe passa a caçar o inimigo mais perto DELA.
    let prey = this._nearestEnemy(player, cx, cz);
    let startAt = 0;

    // `corrosao`: a orbe corrói a cada 400 ms enquanto viaja — são LEVAS, e o
    // número tem de sair como fluxo (senão os ~10 tiques da viagem empilham no
    // mesmo ponto, igual às canalizadas). O estouro final é golpe avulso.
    const strike = (hits, bx, bz, corrosao = false) => {
      if (!hits.length) return;
      const ev = {
        type: 'monster_skill_strike', casterId: player.id, skill: def.skill,
        vfx: def.vfx, originX: bx, originZ: bz, points: null, hits, radius,
      };
      if (corrosao) ev.tick = 1;
      addEvent(ev, mapLvl);
      const npcHits = hits.filter(h => h.isNPC).length;
      if (npcHits > 0) this.ctx.grantSkillXp(player, 'reliquia', npcHits * 14);
    };

    const burst = (bx, bz) => {
      // O estouro é o acerto cheio (índice 0 = é ele que aplica o cc/stun).
      strike(this._resolveOnce(player, def, 'circle', bx, bz, 0, 1, null, null, 0), bx, bz);
      addEvent({ type: 'relic_orb_end', casterId: player.id, x: bx, z: bz }, mapLvl);
    };

    const step = () => {
      if (player.dead) return;
      if (!prey || prey.dead || (prey.mapLevel || 1) !== mapLvl) {
        prey = this._nearestEnemy(player, orb.x, orb.z);
      }
      if (prey) {
        const dx = prey.x - orb.x, dz = prey.z - orb.z;
        const d  = Math.hypot(dx, dz) || 1;
        const stepDist = speed * (tickMs / 1000);
        if (d <= stepDist || d <= catchR) {        // alcançou
          orb.x = prey.x; orb.z = prey.z;
          // `sticky`: alcançar NÃO acaba o golpe — a coisa GRUDA no alvo e
          // continua moendo até a vida dela terminar. É o que separa um
          // projétil teleguiado (a Orbe) de uma tromba d'água que persegue: se
          // ela estourasse ao encostar, "segue o alvo dando dano por tique"
          // seria uma promessa de um tique só.
          if (!def.sticky) return burst(orb.x, orb.z);
        } else {
          orb.x += (dx / d) * stepDist;
          orb.z += (dz / d) * stepDist;
        }
      }
      addEvent({ type: 'relic_orb_move', casterId: player.id, x: orb.x, z: orb.z, radius }, mapLvl);

      // Corrosão: fração do dano em quem estiver DENTRO da orbe agora. Índice 1
      // de propósito — o atordoamento é só do estouro.
      strike(this._resolveOnce(player,
        { ...def, damagePct: (def.damagePct || 0.9) * (def.orbTickPct || 0.18) },
        'circle', orb.x, orb.z, 0, 1, null, null, 1), orb.x, orb.z, true);

      if (Date.now() - startAt >= life) return burst(orb.x, orb.z);
      setTimeout(step, tickMs);
    };

    setTimeout(() => { startAt = Date.now(); step(); }, castMs);

    effectPayload.targetX = player.x;
    effectPayload.targetZ = player.z;
    effectPayload.castMs  = castMs;
  }

  /**
   * BICHOS INVOCADOS — quatro leituras, um motor só (`summonMode`).
   *
   * O que as quatro têm em comum: o golpe não é uma forma que resolve num
   * instante, é uma ou mais CRIATURAS que existem no mar por alguns segundos,
   * andam por conta própria e batem quando encostam. Isso muda a pergunta que a
   * skill faz: não é mais "onde vai cair?", é "para onde eu corro agora?".
   *
   *   hunt    — nascem no ponto mirado e CAÇAM o inimigo mais perto desde já.
   *   ambush  — nascem espalhadas e ficam PARADAS; só investem quando alguém
   *             entra no `triggerRadius`. Vira campo minado com paciência.
   *   volley  — saem do CASCO em salva e voam no alvo mais perto de uma vez.
   *   escort  — ficam em órbita do lançador e só saltam quando ELE acerta
   *             alguma coisa (ver `notifyPlayerHit`). Não tem relógio próprio.
   *
   * O alvo é reavaliado a cada leva, então matar a presa não "trava" a criatura:
   * ela procura outra. E o cliente só DESENHA — a posição de cada criatura chega
   * em `relic_summon_move`, a mesma divisão da Orbe e dos Faróis de Carne.
   */
  _castSummons(player, def, cx, cz, castMs, effectPayload) {
    const { addEvent } = this.ctx;
    const modo = def.summonMode || 'hunt';
    if (modo === 'escort') return this._armSummonEscort(player, def, castMs, effectPayload);

    const mapLvl  = player.mapLevel || 1;
    const n       = Math.max(1, def.count || 3);
    const tickMs  = def.summonTickMs || 180;
    const life    = def.lifeMs || 5000;
    const speed   = def.moveSpeed || 55;
    const raio    = def.radius || 20;
    const catchR  = def.catchRadius || 14;
    const gatilho = def.triggerRadius || 45;
    const spread  = def.spread || 0;

    // De onde elas nascem: o mar apontado (emboscada) ou o próprio casco. A
    // salva sempre sai de dentro do barco; a caçada também, quando o dado pede
    // (`spawnAtCaster`) — numa skill cuja graça é a PERSEGUIÇÃO, nascer longe
    // transforma o cursor num teste de mira que a skill nem quer cobrar.
    const noCasco = modo === 'volley' || def.spawnAtCaster;
    const ox = noCasco ? player.x : cx;
    const oz = noCasco ? player.z : cz;

    for (let i = 0; i < n; i++) {
      const ang  = (i / n) * Math.PI * 2 + Math.random() * 0.5;
      const dist = spread > 0 ? spread * Math.sqrt(0.25 + Math.random() * 0.75) : 0;
      const cria = {
        x: ox + Math.cos(ang) * dist,
        z: oz + Math.sin(ang) * dist,
        // A emboscada nasce DORMINDO — ela não persegue, ela espera.
        acordada: modo !== 'ambush',
        alvo: null,
        fim: 0,
      };

      const fim = (bateu) => {
        addEvent({
          type: 'relic_summon_end', casterId: player.id, index: i,
          skill: def.skill, vfx: def.vfx, x: cria.x, z: cria.z,
          radius: raio, hit: !!bateu,
        }, mapLvl);
      };

      const bater = () => {
        // Chance de atordoar POR CRIATURA (o Coro): é sorteio por rosto, não um
        // stun garantido. Entra pelo `cc` porque é o único caminho que já
        // respeita a convenção de chefe-não-toma-stun.
        const azar = def.stunChance > 0 && Math.random() < def.stunChance;
        const golpe = azar
          ? { ...def, cc: { ...(def.cc || {}), stunMs: def.stunMs || 900 } }
          : def;
        const hits = this._resolveOnce(player, golpe, 'circle',
          cria.x, cria.z, 0, 1, null, null, 0);
        if (hits.length === 0) return;
        addEvent({
          type: 'monster_skill_strike', casterId: player.id, skill: def.skill,
          vfx: def.vfx, originX: cria.x, originZ: cria.z, points: null,
          hits, radius: raio,
        }, mapLvl);
        const npcHits = hits.filter(h => h.isNPC).length;
        if (npcHits > 0) this.ctx.grantSkillXp(player, 'reliquia', npcHits * 14);
      };

      const passo = () => {
        if (player.dead) return;
        if (Date.now() >= cria.fim) return fim(false);

        if (!cria.alvo || cria.alvo.dead || (cria.alvo.mapLevel || 1) !== mapLvl) {
          cria.alvo = this._nearestEnemy(player, cria.x, cria.z);
        }
        const alvo = cria.alvo;
        if (alvo && !cria.acordada) {
          // Emboscada: acorda quando alguém chega perto o bastante — e aí não
          // dorme mais, mesmo que o sujeito se afaste.
          if (Math.hypot(alvo.x - cria.x, alvo.z - cria.z) <= gatilho) cria.acordada = true;
        }
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
        addEvent({
          type: 'relic_summon_move', casterId: player.id, index: i,
          x: cria.x, z: cria.z, awake: cria.acordada,
        }, mapLvl);
        setTimeout(passo, tickMs);
      };

      setTimeout(() => {
        if (player.dead) return;
        cria.fim = Date.now() + life;
        addEvent({
          type: 'relic_summon_spawn', casterId: player.id, index: i,
          skill: def.skill, vfx: def.vfx, x: cria.x, z: cria.z,
          radius: raio, lifeMs: life, mode: modo, awake: cria.acordada,
        }, mapLvl);
        passo();
      }, castMs);
    }

    effectPayload.targetX = cx;
    effectPayload.targetZ = cz;
    effectPayload.castMs  = castMs;
  }

  /**
   * ESCOLTA — as criaturas ficam em órbita do lançador esperando ELE acertar
   * alguma coisa. Não têm relógio próprio: a janela (`durationMs`) só começa a
   * contar no PRIMEIRO salto, então guardar a escolta para a briga certa é parte
   * da jogada em vez de desperdício.
   *
   * Cada criatura é uma CARGA: salta uma vez, bate e some. Três cargas, três
   * saltos — e a recarga curta impede que uma salva de canhão de quatro balas
   * gaste as três no mesmo instante, que seria a skill inteira num piscar.
   */
  _armSummonEscort(player, def, castMs, effectPayload) {
    const { addEvent } = this.ctx;
    const mapLvl = player.mapLevel || 1;
    setTimeout(() => {
      if (player.dead) return;
      player._summonEscort = {
        // Quantas caveiras estão em órbita. Elas NÃO são cargas gastas uma a uma:
        // saltam todas juntas a cada salva (ver notifyPlayerHit).
        vivas:     Math.max(1, def.count || 3),
        janelaMs:  def.durationMs || 6000,
        recargaMs: def.leapCooldownMs || 1500,
        expira:    0,          // 0 = a janela ainda nem abriu
        proximo:   0,
        saltando:  false,
        mapLvl, def,
      };
      addEvent({
        type: 'relic_summon_spawn', casterId: player.id, index: 0,
        skill: def.skill, vfx: def.vfx, x: player.x, z: player.z,
        radius: def.radius || 22, orbitRadius: def.orbitRadius || 26,
        lifeMs: 0, mode: 'escort',
        count: player._summonEscort.vivas,
      }, mapLvl);
    }, castMs);
    effectPayload.castMs = castMs;
  }

  /**
   * O lançador acertou alguma coisa — a escolta salta.
   *
   * Chamado dos DOIS funis de dano do jogador: o de canhão
   * (projectile-manager `_applyTalentOnHit`) e o de relíquia (`_damage` logo
   * acima). Ligar num só deixaria metade da promessa de pé — "seja outra
   * relíquia ou tiro de canhão" é literalmente o pedido.
   *
   * `saltando` é a trava de reentrância e não é zelo excessivo: o próprio salto
   * causa dano, que volta em `_damage`, que chamaria aqui de novo — recursão
   * infinita até a pilha estourar.
   */
  notifyPlayerHit(player, alvo) {
    const e = player && player._summonEscort;
    if (!e || e.saltando || e.vivas <= 0) return;
    if (!alvo || alvo.dead) return;
    if ((alvo.mapLevel || 1) !== (player.mapLevel || 1)) return;

    const { addEvent } = this.ctx;
    const agora = Date.now();
    if (e.expira === 0) {
      // A janela abre AGORA — e só agora. Antes disso a escolta espera o tempo
      // que for, o que faz dela uma decisão de QUANDO começar a briga.
      e.expira = agora + e.janelaMs;
      setTimeout(() => {
        if (player._summonEscort !== e) return;   // já acabou por outro caminho
        player._summonEscort = null;
        addEvent({
          type: 'relic_summon_end', casterId: player.id, index: 0,
          skill: e.def.skill, vfx: e.def.vfx, x: player.x, z: player.z,
          radius: e.def.radius || 22, hit: false,
        }, e.mapLvl);
      }, e.janelaMs + 50);
    } else if (agora > e.expira) {
      player._summonEscort = null;
      return;
    }
    if (agora < e.proximo) return;
    e.proximo = agora + e.recargaMs;

    const raio = e.def.radius || 22;
    // AS TRÊS DE UMA VEZ. `count` diz ao desenho quantas saem do casco; o dano
    // é UM golpe — o `damagePct` do dado é o da salva inteira, não o de cada
    // caveira (ver a nota no monster_skills.js).
    addEvent({
      type: 'relic_summon_leap', casterId: player.id, index: 0,
      skill: e.def.skill, vfx: e.def.vfx, x: alvo.x, z: alvo.z,
      radius: raio, count: e.vivas,
    }, e.mapLvl);

    e.saltando = true;
    try {
      const hits = this._resolveOnce(player, e.def, 'circle',
        alvo.x, alvo.z, 0, 1, null, null, 0);
      if (hits.length > 0) {
        addEvent({
          type: 'monster_skill_strike', casterId: player.id, skill: e.def.skill,
          vfx: e.def.vfx, originX: alvo.x, originZ: alvo.z, points: null,
          hits, radius: raio,
        }, e.mapLvl);
        const npcHits = hits.filter(h => h.isNPC).length;
        if (npcHits > 0) this.ctx.grantSkillXp(player, 'reliquia', npcHits * 14);
      }
    } finally {
      e.saltando = false;
    }
  }

  /**
   * Cardume de Torpedos (r35): `count` torpedos saem do casco um atrás do
   * outro, cada um curvando até o que estiver à frente.
   *
   * Por que não cabe no laço de levas do `cast()`: lá toda leva resolve a MESMA
   * forma no MESMO ponto. Aqui cada torpedo tem alvo próprio, origem própria (o
   * casco no instante do disparo, que se move) e chega no próprio tempo de voo.
   *
   * O alvo é travado NO DISPARO, não no cast: os seis saem ao longo de ~0,9 s e
   * cada um busca o inimigo mais perto dentro do cone de mira NAQUELE instante.
   * É o que faz a salva "acompanhar" uma briga que se mexe em vez de despejar
   * tudo onde o alvo estava quando se clicou. Sem ninguém no cone, o torpedo vai
   * reto — aberto em leque, alternando um lado e outro, para seis tiros lerem
   * como salva e não como fila indiana.
   *
   * A CURVA do voo é puramente do cliente: o servidor só diz de onde, para onde
   * e em quanto tempo. Curva desenhada não muda quem é atingido — quem decide
   * isso é o círculo de `radius` no ponto de chegada, na hora da chegada.
   */
  _castTorpedoes(player, def, dx, dz, castMs, effectPayload) {
    const { addEvent } = this.ctx;
    const mapLvl  = player.mapLevel || 1;
    const n       = Math.max(1, def.count || 6);
    const gapMs   = def.salvoMs || 150;
    const flyMs   = def.travelMs || 480;
    const alcance = def.length || 95;
    const meio    = ((def.angle || 60) * Math.PI / 180) / 2;
    const leque   = ((def.fanAngle || 40) * Math.PI / 180) / 2;
    const base    = Math.atan2(dz, dx);

    for (let i = 0; i < n; i++) {
      setTimeout(() => {
        if (player.dead) return;
        const fx = player.x, fz = player.z;
        const alvo = this._coneTarget(player, fx, fz, dx, dz, alcance, meio);

        // Leque simétrico: 0, +1, -1, +2, -2… normalizado pelo número de tiros.
        const lado = (i % 2 === 0 ? 1 : -1) * Math.ceil(i / 2);
        const ang  = base + (n > 1 ? (lado / Math.ceil(n / 2)) * leque : 0);
        const tx = alvo ? alvo.e.x : fx + Math.cos(ang) * alcance;
        const tz = alvo ? alvo.e.z : fz + Math.sin(ang) * alcance;

        addEvent({
          type: 'relic_torpedo', casterId: player.id, skill: def.skill,
          vfx: def.vfx, index: i, side: lado >= 0 ? 1 : -1,
          fromX: fx, fromZ: fz, toX: tx, toZ: tz,
          travelMs: flyMs, radius: def.radius || 15,
          homed: !!alvo,
          // Quem o torpedo está perseguindo. O cliente curva o desenho para a
          // posição VIVA dele durante o voo — sem isso o torpedo desenhado iria
          // para o ponto do disparo enquanto o estouro sai em cima do alvo.
          targetId: alvo ? alvo.e.id : null,
          homingRadius: def.homing ? (def.homingRadius || 55) : 0,
        }, mapLvl);

        setTimeout(() => {
          if (player.dead) return;
          // ── RE-MIRA na chegada ───────────────────────────────────
          // O alvo andou durante o voo. Se ele continua vivo, no mesmo mapa e
          // ainda perto do ponto anunciado, o estouro acontece EM CIMA dele —
          // é um torpedo teleguiado, não um obus. O `homingRadius` é a corda que
          // ele tem: alvo que fugiu MAIS que isso ganhou a corrida, e aí o
          // torpedo estoura onde foi anunciado (e o desenho concorda, porque o
          // cliente para de seguir pelo mesmo critério).
          let ax = tx, az = tz;
          if (def.homing && alvo && !alvo.e.dead
              && (alvo.e.mapLevel || 1) === mapLvl
              && Math.hypot(alvo.e.x - tx, alvo.e.z - tz) <= (def.homingRadius || 55)) {
            ax = alvo.e.x; az = alvo.e.z;
          }
          const hits = this._resolveOnce(player, { ...def, count: 1 }, 'circle',
            ax, az, dx, dz, null, null, 0);
          addEvent({
            type: 'monster_skill_strike', casterId: player.id, skill: def.skill,
            vfx: def.vfx, originX: ax, originZ: az, points: null, hits,
            radius: def.radius || 15,
          }, mapLvl);
          const npcHits = hits.filter(h => h.isNPC).length;
          if (npcHits > 0) this.ctx.grantSkillXp(player, 'reliquia', npcHits * 14);
        }, flyMs);
      }, castMs + i * gapMs);
    }

    effectPayload.targetX = player.x;
    effectPayload.targetZ = player.z;
    effectPayload.castMs  = castMs;
  }

  /**
   * Inimigo mais perto dentro de um cone à frente do lançador — a mira do
   * torpedo. Reaproveita o `_enemyPool` (que já filtra mapa, morte e regra de
   * PvP) e só acrescenta a geometria.
   */
  _coneTarget(player, ox, oz, dx, dz, reach, halfAngle) {
    let best = null, bestD = Infinity;
    for (const t of this._enemyPool(player)) {
      const rx = t.e.x - ox, rz = t.e.z - oz;
      const d = Math.hypot(rx, rz);
      if (d > reach || d < 0.001 || d >= bestD) continue;
      const cosA = (rx * dx + rz * dz) / d;
      if (Math.acos(Math.max(-1, Math.min(1, cosA))) > halfAngle) continue;
      bestD = d; best = t;
    }
    return best;
  }

  /** O inimigo válido mais próximo de um ponto, ou null. Mesmas regras de alvo
   *  do `_targetsIn` (NPC do mapa vivo + jogador que a relíquia pode acertar). */
  _nearestEnemy(player, x, z) {
    const { projectileManager, players, relicCanHitPlayer } = this.ctx;
    let best = null, bestD = Infinity;
    projectileManager.npcs.forEach(npc => {
      if (npc.dead || (npc.mapLevel || 1) !== (player.mapLevel || 1)) return;
      const d = Math.hypot(npc.x - x, npc.z - z);
      if (d < bestD) { bestD = d; best = npc; }
    });
    players.forEach(p => {
      if (!relicCanHitPlayer(player, p)) return;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < bestD) { bestD = d; best = p; }
    });
    return best;
  }

  /**
   * CHUVA MIRADA — uma queda por `dropIntervalMs`, cada uma em ONDE O ALVO
   * ESTÁ naquele instante, com `dropWarnMs` de janela de fuga.
   *
   * Nasceu no Cemitério de Naufrágios (espelhando o `_runWreckRain` do bicho) e
   * hoje serve as três que largavam tudo de uma vez: Naufrágios, Salva de
   * Morteiro e Tentáculos do Abismo. O defeito era o mesmo nas três — uma salva
   * simultânea espalhada é SORTEIO: ou o alvo estava debaixo de alguma sub-área
   * ou não estava, e ficar parado era a jogada mais segura porque o miolo do
   * espalhamento é justamente o buraco. Caindo uma a uma em cima de quem está
   * sendo caçado, a leitura vira perseguição: quem para, leva; quem anda, gasta
   * a salva inteira correndo. É o mesmo que o anel mirado (`aimed_ring`)
   * tentava comprar com geometria, sem depender de ler o desenho num piscar.
   *
   * O alvo é uma PESSOA, não um lugar: escolhido no cursor e reavaliado a cada
   * queda (se ele morrer, a chuva segue para o inimigo mais perto do lançador).
   *
   * `special: 'obstacles'` é o extra do Cemitério — além do dano, cada peça vira
   * bloqueio real. As outras duas só batem, e a do polvo AGARRA pelo `cc`.
   */
  _castAimedRain(player, def, cx, cz, castMs, effectPayload) {
    const { addEvent, wallManager, getMapManagerFor } = this.ctx;
    const mapLvl = player.mapLevel || 1;
    const drops  = Math.max(1, def.count || 6);
    const gapMs  = def.dropIntervalMs || 1000;
    const warnMs = def.dropWarnMs || 700;
    const raio   = def.radius || 24;
    // So o Cemiterio planta obstaculo; morteiro e tentaculo caem e acabou.
    const planta = def.special === 'obstacles';
    const hold   = def.holdMs || 8000;
    const r      = def.obstacleRadius || 8;
    let prey = this._nearestEnemy(player, cx, cz);

    for (let i = 0; i < drops; i++) {
      setTimeout(() => {
        if (player.dead) return;
        if (!prey || prey.dead || (prey.mapLevel || 1) !== mapLvl) {
          prey = this._nearestEnemy(player, player.x, player.z);
        }
        const dx = prey ? prey.x : cx;
        const dz = prey ? prey.z : cz;

        // Aviso DESTA queda. `count: 1` e `spread: 0` prendem o destroço no
        // ponto anunciado — sem isso a skill sorteia o ponto dela dentro do
        // `spread_radius` e a marcação aparece longe de onde a peça cai.
        addEvent({
          type: 'monster_skill_cast', casterId: player.id, crit: player._relicCrit,
          skill: def.skill, vfx: def.vfx, shape: def.shape || 'multi', special: null,
          originX: dx, originZ: dz, targetX: dx, targetZ: dz, dirX: 0, dirZ: 1,
          castMs: warnMs, points: [{ x: 0, z: 0 }],
          params: {
            radius: raio, count: 1, spread: 0,
            obstacleRadius: r, holdMs: hold, dropIndex: i,
          },
        }, mapLvl);

        // Cada queda e uma zona de perigo de verdade. Sem isto o NPC cacado
        // ficava parado esperando o obus e a leitura "nao pare" so valia para
        // jogador - o cast normal avisa uma vez, mas aqui o ponto MUDA.
        if (getMapManagerFor) {
          getMapManagerFor(mapLvl)?.notifyDangerZone(dx, dz, raio, warnMs);
        }

        setTimeout(() => {
          if (player.dead) return;
          const hits = this._resolveOnce(player, { ...def, count: 1 },
            'circle', dx, dz, 0, 1, null, null, 0);
          addEvent({
            type: 'monster_skill_strike', casterId: player.id, skill: def.skill,
            vfx: def.vfx, originX: dx, originZ: dz, points: null, hits,
            radius: raio,
          }, mapLvl);

          if (planta) {
            // E o destroço vira obstáculo de verdade (mesmo wallManager do bicho).
            if (wallManager) {
              wallManager.addWall(mapLvl, {
                id: `ms_${player.id}_${Date.now()}_${i}`,
                x: dx, z: dz, hw: r, hh: r, rot: 0, durationMs: hold,
              });
            }
            addEvent({
              type: 'monster_skill_obstacles', casterId: player.id, skill: def.skill,
              vfx: def.vfx, originX: dx, originZ: dz,
              points: [{ x: 0, z: 0 }], radius: r, holdMs: hold,
            }, mapLvl);
          }

          const npcHits = hits.filter(h => h.isNPC).length;
          if (npcHits > 0) this.ctx.grantSkillXp(player, 'reliquia', npcHits * 14);
        }, warnMs);
      }, castMs + i * gapMs);
    }

    effectPayload.targetX = cx;
    effectPayload.targetZ = cz;
    effectPayload.castMs  = castMs;
  }

  /**
   * Cemitério de Naufrágios / Jaula de Patas: obstáculos FÍSICOS temporários.
   * Reaproveita o wallManager do Muro de Pedra — caixinhas quadradas no lugar
   * de um retângulo longo. Jogador e NPC já respeitam essas caixas.
   */
  /**
   * Todo alvo legítimo do lançador no mapa, NPC ou jogador, já filtrado pelas
   * regras de PvP. Mesmo pool que a Cadeia monta — extraído porque as três
   * skills do arauto escolhem alvo por conta própria em vez de por geometria.
   */
  _enemyPool(player) {
    const { projectileManager, players, relicCanHitPlayer } = this.ctx;
    const pool = [];
    projectileManager.npcs.forEach(npc => {
      if (npc.dead || !this._podeAcertarNpc(player, npc)) return;
      if ((npc.mapLevel || 1) === (player.mapLevel || 1)) pool.push({ e: npc, isNPC: true });
    });
    players.forEach(p => { if (relicCanHitPlayer(player, p)) pool.push({ e: p, isNPC: false }); });
    return pool;
  }

  /**
   * PILARES DO JUÍZO — uma coluna sobre CADA alvo dentro do alcance, até
   * `maxTargets`, todas ao mesmo tempo.
   *
   * A posição é travada AGORA e a coluna cai depois do cast: quem andar durante
   * o telegraph escapa, quem ficar não. É a única relíquia do jogo que não tem
   * "onde clicar" — o clique só diz quando.
   */
  _castPillars(player, def, shape, castMs, effectPayload) {
    const { addEvent } = this.ctx;
    const mapLvl = player.mapLevel || 1;
    const alcance = def.seekRadius || 150;
    const max = def.maxTargets || 4;

    const perto = this._enemyPool(player)
      .map(t => ({ t, d: Math.hypot(t.e.x - player.x, t.e.z - player.z) }))
      .filter(o => o.d <= alcance)
      .sort((a, b) => a.d - b.d)
      .slice(0, max);
    // Posições TRAVADAS no cast — não as entidades. Se elas se moverem, o pilar
    // cai onde estavam, que é exatamente a jogada que a skill oferece.
    const marcas = perto.map(o => ({ x: o.t.e.x, z: o.t.e.z }));

    addEvent({
      type: 'monster_skill_pillars', casterId: player.id, skill: def.skill,
      vfx: def.vfx, points: marcas, radius: def.radius, castMs,
    }, mapLvl);

    if (marcas.length === 0) return;

    setTimeout(() => {
      if (player.dead) return;
      const hits = [];
      for (const m of marcas) {
        const batch = this._resolveOnce(player, def, shape, m.x, m.z, 0, 1, null, null, 0);
        for (const h of batch) hits.push(h);
      }
      addEvent({
        type: 'monster_skill_strike', casterId: player.id, skill: def.skill,
        vfx: def.vfx, originX: player.x, originZ: player.z,
        points: marcas, hits, radius: def.radius || 24,
      }, mapLvl);
    }, castMs);
  }

  /**
   * FARÓIS DE CARNE — `lightCount` luzes TELEGUIADAS, uma por alvo sorteado.
   *
   * Espelho do `_runHunterLights` do attack-manager (a versão do bicho): as
   * duas nascem no lançador, voam atrás da posição VIVA da presa, não machucam
   * no caminho e implodem ao alcançar (`catchRadius`) ou no fim de `lifeMs`. Se
   * uma mudar, a outra muda junto — é o mesmo golpe dos dois lados do canhão.
   */
  _castLights(player, def, castMs, effectPayload) {
    const { addEvent } = this.ctx;
    const mapLvl  = player.mapLevel || 1;
    const life    = def.lifeMs || 5000;
    const speed   = def.lightSpeed || 40;
    const catchR  = def.catchRadius || 14;
    const raio    = def.radius || 34;
    const tickMs  = MonsterSkillManager.LIGHT_TICK_MS;
    const alcance = def.seekRadius || 150;

    const pool = this._enemyPool(player)
      .filter(t => Math.hypot(t.e.x - player.x, t.e.z - player.z) <= alcance);
    if (pool.length === 0) return;

    const n = Math.min(def.lightCount || 3, pool.length);
    for (let i = 0; i < n; i++) {
      const j = i + Math.floor(Math.random() * (pool.length - i));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    for (let i = 0; i < n; i++) {
      const alvo = pool[i].e;
      // Nasce no lançador — a luz é um projétil, não uma marca no alvo.
      const luz = { x: player.x, z: player.z };
      let nasceuEm = 0;

      const implodir = (bx, bz) => {
        addEvent({
          type: 'monster_skill_light_burst', casterId: player.id, skill: def.skill,
          vfx: def.vfx, targetId: alvo.id, index: i,
          x: bx, z: bz, radius: raio,
        }, mapLvl);
        const hits = this._resolveOnce(player, def, 'circle', bx, bz, 0, 1, null, null, 0);
        if (hits.length > 0) {
          addEvent({
            type: 'monster_skill_strike', casterId: player.id, skill: def.skill,
            vfx: def.vfx, originX: bx, originZ: bz,
            hits, radius: raio,
          }, mapLvl);
        }
      };

      const passo = () => {
        if (player.dead) return;
        const vivo = !alvo.dead && (alvo.mapLevel || 1) === mapLvl;
        if (vivo) {
          const dx = alvo.x - luz.x, dz = alvo.z - luz.z;
          const d  = Math.hypot(dx, dz) || 1;
          const avanco = speed * (tickMs / 1000);
          if (d <= avanco || d <= catchR) {
            luz.x = alvo.x; luz.z = alvo.z;
            return implodir(luz.x, luz.z);
          }
          luz.x += (dx / d) * avanco;
          luz.z += (dz / d) * avanco;
        }
        addEvent({
          type: 'monster_skill_light_move', casterId: player.id, index: i,
          x: luz.x, z: luz.z,
        }, mapLvl);
        // Presa morta no meio do voo: a luz não fica dando volta até o timeout.
        if (!vivo) return implodir(luz.x, luz.z);
        if (Date.now() - nasceuEm >= life) return implodir(luz.x, luz.z);
        setTimeout(passo, tickMs);
      };

      setTimeout(() => {
        if (player.dead) return;
        nasceuEm = Date.now();
        addEvent({
          type: 'monster_skill_light', casterId: player.id, skill: def.skill,
          vfx: def.vfx, targetId: alvo.id, index: i,
          x: luz.x, z: luz.z, originX: player.x, originZ: player.z,
          lifeMs: life, radius: raio, lightSpeed: speed,
        }, mapLvl);
        passo();
      }, castMs);
    }
  }

  /**
   * PRISÃO DE TERRA — quatro muros retos formando uma caixa fechada em volta do
   * cursor. Sem brecha (é o que a separa da Jaula de Patas) e sem dano: o preço
   * é o tempo. Gêmea de `_raisePrisonWalls` no attack-manager — mesma geometria
   * dos dois lados, senão a cela do jogador e a do bicho prenderiam diferente.
   */
  _castPrison(player, def, cx, cz, castMs, effectPayload) {
    const { wallManager, addEvent } = this.ctx;
    if (!wallManager) return;
    const mapLvl = player.mapLevel || 1;
    const meia = (def.wallLength || 34) / 2;
    const esp  = (def.wallThickness || 5) / 2;
    const hold = def.holdMs || 6000;
    // Espessura POR FORA: o interior útil é o `wallLength` cheio, senão um barco
    // de raio 14 não manobra dentro de uma cela de 34.
    const d = meia + esp;
    const muros = [
      { x:  0, z: -d, rot: 0 },
      { x:  0, z:  d, rot: 0 },
      { x: -d, z:  0, rot: Math.PI / 2 },
      { x:  d, z:  0, rot: Math.PI / 2 },
    ];

    setTimeout(() => {
      if (player.dead) return;
      const stamp = Date.now();
      const pontos = [];
      muros.forEach((m, i) => {
        wallManager.addWall(mapLvl, {
          id: `prison_${player.id}_${stamp}_${i}`,
          x: cx + m.x, z: cz + m.z,
          hw: meia, hh: esp, rot: m.rot, durationMs: hold,
        });
        pontos.push({ x: m.x, z: m.z, rot: m.rot });
      });
      addEvent({
        type: 'monster_skill_obstacles', casterId: player.id, skill: def.skill,
        vfx: def.vfx, originX: cx, originZ: cz, points: pontos,
        radius: def.radius, holdMs: hold,
        wallLength: def.wallLength, wallThickness: def.wallThickness,
      }, mapLvl);
    }, castMs);
  }

  _castObstacles(player, def, ox, oz, pts, castMs, dx = 0, dz = 1) {
    const { wallManager, addEvent } = this.ctx;
    if (!wallManager) return;
    const mapLvl = player.mapLevel || 1;
    const hold   = def.holdMs || 6000;
    const r      = def.obstacleRadius || 8;

    // ── Barragem Rolante: uma parede POR PASSO, no ritmo do avanço ──────────
    // Cada leva ergue a pedra na linha daquele passo e ela expira antes da
    // próxima — a barreira anda com a barragem em vez de virar um labirinto.
    if (def.wallPerStep) {
      const steps = def.stepCount || 5;
      const first = def.firstDistance || 20;
      const gap   = def.stepDistance || 20;
      const halfW = (def.width || 80) / 2;
      const step  = (def.ticks && def.ticks.intervalMs) || 550;
      const perp  = { x: -dz, z: dx };          // eixo da parede = perpendicular
      for (let i = 0; i < steps; i++) {
        setTimeout(() => {
          if (player.dead) return;
          const d = first + i * gap;
          const cx = ox + dx * d, cz = oz + dz * d;
          const spots = [];
          const n = Math.max(2, Math.round(halfW / Math.max(r, 1)));
          for (let k = -n; k <= n; k++) {
            const t = (k / n) * halfW;
            spots.push({ x: perp.x * t + dx * d, z: perp.z * t + dz * d });
            wallManager.addWall(mapLvl, {
              id: `ms_${player.id}_${Date.now()}_${i}_${k}`,
              x: cx + perp.x * t, z: cz + perp.z * t,
              hw: r, hh: r, rot: 0, durationMs: hold,
            });
          }
          addEvent({
            type: 'monster_skill_obstacles', casterId: player.id, skill: def.skill,
            vfx: def.vfx, originX: ox, originZ: oz, points: spots,
            radius: r, holdMs: hold, facing: Math.atan2(dx, dz),
          }, mapLvl);
        }, castMs + i * step);
      }
      return;
    }

    // Jaula = anel de patas com UMA brecha; Naufrágios = destroços espalhados.
    //
    // As patas vêm PRONTAS do cast() — ele já sorteou o `gapFacing`, montou os
    // pontos com cageSpots() e os mandou no broadcast. Sortear uma segunda
    // brecha aqui (o que este bloco fazia) punha PEDRA em cima do lugar
    // desenhado como saída e deixava um vão aberto onde o desenho mostrava
    // pata: quem lia a jaula certa batia num muro invisível. É o mesmo erro
    // que o comentário do cast() diz não cometer, cometido logo abaixo dele.
    const spots = pts && pts.length
      ? pts
      : MonsterSkillManager.scatter(def.count || 6, def.spread || 75, def);

    setTimeout(() => {
      spots.forEach((p, i) => {
        wallManager.addWall(mapLvl, {
          id: `ms_${player.id}_${Date.now()}_${i}`,
          x: ox + p.x, z: oz + p.z, hw: r, hh: r, rot: 0, durationMs: hold,
        });
      });
      addEvent({
        type: 'monster_skill_obstacles', casterId: player.id, skill: def.skill,
        vfx: def.vfx, originX: ox, originZ: oz, points: spots,
        radius: r, holdMs: hold,
      }, mapLvl);
    }, castMs);
  }

  /**
   * Sobrecarga do Núcleo: carrega por `chargeMs` e só então detona.
   * INTERROMPÍVEL — qualquer dano no caster durante a carga cancela tudo.
   * É a leitura invertida do ataque original ("para de fugir e bate NELE").
   */
  _castCharge(player, def, ox, oz, dx, dz, pts, effectPayload) {
    const { addEvent } = this.ctx;
    const castMs  = def.castMs || 800;
    const charge  = def.chargeMs || 5000;
    const mapLvl  = player.mapLevel || 1;
    const startHp = player.hp;
    player._msCharging = true;

    setTimeout(() => {
      player._msCharging = false;
      if (player.dead) return;
      // Levou dano durante a carga → interrompido, sem explosão.
      if (player.hp < startHp) {
        addEvent({
          type: 'monster_skill_interrupted', casterId: player.id,
          skill: def.skill, vfx: def.vfx, originX: ox, originZ: oz,
        }, mapLvl);
        return;
      }
      const hits = this._resolveOnce(player, def, 'circle', ox, oz, dx, dz, pts, null, 0);
      addEvent({
        type: 'monster_skill_strike', casterId: player.id, skill: def.skill,
        vfx: def.vfx, originX: ox, originZ: oz, points: pts, hits,
        radius: def.radius || def.length || 40,
      }, mapLvl);
      const npcHits = hits.filter(h => h.isNPC).length;
      if (npcHits > 0) this.ctx.grantSkillXp(player, 'reliquia', npcHits * 14);
    }, castMs + charge);

    effectPayload.castMs  = castMs;
    effectPayload.chargeMs = charge;
    effectPayload.targetX = ox;
    effectPayload.targetZ = oz;
  }
}

module.exports = MonsterSkillManager;
