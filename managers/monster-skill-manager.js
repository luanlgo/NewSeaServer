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
const { isInvincible } = require('../utils/invincibility');
const { applyGoldShield } = require('../utils/gold-shield');

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

  /** Todos os inimigos válidos do caster dentro da forma. */
  _targetsIn(player, def, shape, ox, oz, dx, dz, pts) {
    const { projectileManager, players, relicCanHitPlayer } = this.ctx;
    const out = [];
    projectileManager.npcs.forEach(npc => {
      if (npc.dead) return;
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
      if (!npc.dead && (npc.mapLevel || 1) === (player.mapLevel || 1)) pool.push({ e: npc, isNPC: true });
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

    e.hp = Math.max(0, e.hp - dmg);
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
    const fromCaster = (shape === 'cone' || shape === 'line' || shape === 'rays'
                     || def.special === 'orb' || def.atCaster);
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
      return this._castWreckRain(player, def, cx, cz, castMs, effectPayload);
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
    // Sentença do Crânio: as marcas ANDAM com quem foi carimbado.
    if (def.special === 'mark') {
      this._castMark(player, def, cx, cz, castMs, pts, effectPayload);
      return;
    }
    // Ninhada Pútrida: ovos que chocam — ou pulam em quem passar perto.
    if (def.special === 'brood') {
      this._castBrood(player, def, cx, cz, castMs, pts, effectPayload);
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
        addEvent({
          type: 'monster_skill_strike', casterId: player.id, skill: def.skill,
          vfx: def.vfx, originX: ox, originZ: oz, points: pts, hits,
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
    const targets = (shape === 'chain')
      ? this._chainTargets(player, def, ox, oz)
      : this._targetsIn(player, def, shape, ox, oz, dx, dz, pts);
    if (targets.length === 0) return [];

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

    // ── Coro dos Rostos: SILÊNCIO ────────────────────────────────────────────
    // Trava o uso de relíquia (lido por handleUseRelic). Só faz sentido em
    // jogador: NPC não usa relíquia, e travar um deles seria efeito invisível.
    if (def.special === 'silence' && def.silenceMs) {
      for (const t of targets) {
        if (t.isNPC) continue;
        const e = t.e;
        e._silencedUntil = Math.max(e._silencedUntil || 0, Date.now() + def.silenceMs);
        this.ctx.sendTo(e.ws, {
          type: 'silenced', targetId: e.id, durationMs: def.silenceMs,
        });
      }
    }

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
    const { addEvent } = this.ctx;
    const mapLvl = player.mapLevel || 1;
    const ticks  = def.ticks || { count: 8, intervalMs: 500, pct: 0.2 };
    const total  = Math.max(1, ticks.count || 8);
    const step   = ticks.intervalMs || 500;
    const deR    = def.radius || 100;
    const ateR   = def.collapseTo || def.finalRadius || def.eruptRadius || 30;
    const banda  = def.band || Math.max(12, (deR - ateR) / total);
    const hits   = [];

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
   * O passo sai da própria faixa (`expandMs × band / radius`), então a frente
   * avança exatamente `band` por passo: a varredura fica CONTÍNUA (sem buraco)
   * e ninguém leva a mesma onda duas vezes — o dano total continua sendo um
   * por onda, como o desenho promete.
   */
  _runSonar(player, def, ox, oz, castMs, gapFacing, effectPayload) {
    const { addEvent } = this.ctx;
    const mapLvl = player.mapLevel || 1;
    const rings  = def.ringCount || (def.ticks && def.ticks.count) || 4;
    const gapMs  = (def.ticks && def.ticks.intervalMs) || 1200;
    const expand = def.expandMs || 3200;
    const radius = def.radius || 95;
    const band   = def.band || 11;
    const stepMs = Math.max(60, Math.round((expand * band) / Math.max(radius, 1)));
    const total  = (rings - 1) * gapMs + expand;
    const hits   = [];

    const start = Date.now() + castMs;
    const step = () => {
      if (player.dead) return;
      const el = Date.now() - start;

      for (let i = 0; i < rings; i++) {
        const t = el - i * gapMs;
        if (t < 0 || t > expand) continue;         // ainda não saiu / já acabou
        const front = radius * (t / expand);
        const tickDef = {
          ...def, shape: 'ring',
          _frontRadius: front, _ringIndex: i, _gapFacing: gapFacing,
        };
        const batch = this._resolveOnce(player, tickDef, 'ring', ox, oz, 0, 1, null, def.ticks, i);
        if (batch.length === 0) continue;
        for (const h of batch) hits.push(h);
        addEvent({
          type: 'monster_skill_strike', casterId: player.id, skill: def.skill,
          vfx: def.vfx, originX: ox, originZ: oz, points: null, hits: batch,
          radius: front, tick: i,
        }, mapLvl);
      }

      if (el >= total) {
        const npcHits = hits.filter(h => h.isNPC).length;
        if (npcHits > 0) this.ctx.grantSkillXp(player, 'reliquia', npcHits * 14);
        return;
      }
      setTimeout(step, stepMs);
    };
    setTimeout(step, castMs);

    effectPayload.targetX = ox;
    effectPayload.targetZ = oz;
    effectPayload.castMs  = castMs;
  }

  /**
   * Sentença do Crânio: carimba N inimigos e a marca ANDA COM ELES.
   *
   * O `special: 'mark'` estava no dado desde que a skill nasceu e nunca teve
   * implementação: a relíquia caía na resolução `multi` genérica, ou seja
   * explodia NA HORA em pontos sorteados em volta do cursor — quase nunca em
   * cima de alguém. Era o "não está dando o dano", e a marca também nunca
   * andava, porque não havia marca nenhuma.
   *
   * Agora o carimbo é numa PESSOA: o alvo leva a explosão onde estiver quando o
   * pavio queimar, e a única defesa é se afastar dos outros — porque a explosão
   * ainda é uma área, e dois marcados juntos somam.
   */
  _castMark(player, def, cx, cz, castMs, pts, effectPayload) {
    const { addEvent } = this.ctx;
    const mapLvl = player.mapLevel || 1;
    const fuse   = def.fuseMs || 4000;
    const raio   = def.radius || 22;

    setTimeout(() => {
      if (player.dead) return;

      // Os candidatos são os inimigos dentro do `spread` do cursor, os mais
      // próximos primeiro — carimbar quem está do outro lado do mapa faria a
      // mira não querer dizer nada.
      const alcance = { ...def, radius: def.spread || 60 };
      const alvos = this._targetsIn(player, alcance, 'circle', cx, cz, 0, 1, null)
        .sort((a, b) => Math.hypot(a.e.x - cx, a.e.z - cz) - Math.hypot(b.e.x - cx, b.e.z - cz))
        .slice(0, def.count || 3);

      if (alvos.length === 0) return;

      for (const t of alvos) {
        addEvent({
          type: 'relic_mark_set', casterId: player.id, skill: def.skill,
          vfx: def.vfx, targetId: t.e.id, isNPC: t.isNPC,
          fuseMs: fuse, radius: raio,
        }, mapLvl);
      }

      setTimeout(() => {
        if (player.dead) return;
        const hits = [];
        for (const t of alvos) {
          const e = t.e;
          if (e.dead) continue;
          // A explosão acontece ONDE O ALVO ESTÁ — é a marca que andou com ele.
          // E é uma ÁREA de verdade: quem estiver junto do marcado também leva.
          const batch = this._resolveOnce(player, def, 'circle', e.x, e.z, 0, 1, null, null, 0);
          for (const h of batch) hits.push(h);
          addEvent({
            type: 'relic_mark_burst', casterId: player.id, skill: def.skill,
            vfx: def.vfx, targetId: e.id, x: e.x, z: e.z, radius: raio,
          }, mapLvl);
          // Golpe avulso (sem `tick`): número cheio, que é o que o pavio de
          // 4 s promete. Sem este anúncio o dano saía e a tela ficava muda.
          addEvent({
            type: 'monster_skill_strike', casterId: player.id, skill: def.skill,
            vfx: def.vfx, originX: e.x, originZ: e.z, points: null,
            hits: batch, radius: raio,
          }, mapLvl);
        }
        const npcHits = hits.filter(h => h.isNPC).length;
        if (npcHits > 0) this.ctx.grantSkillXp(player, 'reliquia', npcHits * 14);
      }, fuse);
    }, castMs);

    effectPayload.targetX = cx;
    effectPayload.targetZ = cz;
    effectPayload.castMs  = castMs;
  }

  /**
   * Ninhada Pútrida: ovos que chocam sozinhos — ou PULAM em quem passar perto.
   *
   * Mesma história do `mark`: o `special: 'brood'` nunca existiu no motor, e a
   * skill resolvia como um `multi` instantâneo. Não havia ovo, não havia
   * chocagem, e o dano saía no cast em pontos sorteados.
   *
   * O ovo é uma ameaça PACIENTE: fica no lugar, e quem chegar a `triggerRadius`
   * dele o faz pular. Isso dá à skill uma leitura que nenhuma outra tem — ela
   * transforma um pedaço do mar em terreno que o inimigo tem de contornar, e
   * quem não contorna decide a hora da própria explosão.
   */
  _castBrood(player, def, cx, cz, castMs, pts, effectPayload) {
    const { addEvent } = this.ctx;
    const mapLvl  = player.mapLevel || 1;
    const hatch   = def.hatchMs || 6000;
    const raio    = def.radius || 9;
    const gatilho = def.triggerRadius || 26;
    const puloMs  = def.jumpMs || 350;
    const POLL_MS = 150;

    setTimeout(() => {
      if (player.dead) return;
      const ovos = (pts || MonsterSkillManager.scatter(def.count || 5, def.spread || 65, def))
        .map((pt, i) => ({ id: player.id + '_' + Date.now() + '_' + i, x: cx + pt.x, z: cz + pt.z, vivo: true }));

      addEvent({
        type: 'relic_brood_lay', casterId: player.id, skill: def.skill, vfx: def.vfx,
        eggs: ovos.map(o => ({ id: o.id, x: o.x, z: o.z })),
        radius: raio, hatchMs: hatch, triggerRadius: gatilho,
      }, mapLvl);

      const hits = [];
      const estourar = (ovo, ex, ez) => {
        const batch = this._resolveOnce(player, def, 'circle', ex, ez, 0, 1, null, null, 0);
        for (const h of batch) hits.push(h);
        addEvent({
          type: 'relic_brood_burst', casterId: player.id, skill: def.skill, vfx: def.vfx,
          eggId: ovo.id, x: ex, z: ez, radius: raio,
        }, mapLvl);
        addEvent({
          type: 'monster_skill_strike', casterId: player.id, skill: def.skill,
          vfx: def.vfx, originX: ex, originZ: ez, points: null,
          hits: batch, radius: raio,
        }, mapLvl);
      };

      const nascidoEm = Date.now();
      const vigiar = () => {
        if (player.dead) return;
        const restam = ovos.filter(o => o.vivo);

        for (const ovo of restam) {
          // O ovo procura quem chegou perto DELE — o raio de gatilho é bem
          // maior que o de dano, senão o pulo aconteceria depois de o alvo já
          // ter passado por cima e a mecânica não teria como ser vista.
          const perto = this._targetsIn(player, { radius: gatilho }, 'circle', ovo.x, ovo.z, 0, 1, null);
          if (perto.length === 0) continue;
          perto.sort((a, b) => Math.hypot(a.e.x - ovo.x, a.e.z - ovo.z) - Math.hypot(b.e.x - ovo.x, b.e.z - ovo.z));
          const presa = perto[0].e;
          ovo.vivo = false;                         // reservado: não pula duas vezes
          addEvent({
            type: 'relic_brood_jump', casterId: player.id, skill: def.skill, vfx: def.vfx,
            eggId: ovo.id, targetId: presa.id, x: presa.x, z: presa.z, jumpMs: puloMs,
          }, mapLvl);
          // O ovo estoura onde o alvo estiver quando ele CHEGAR, não onde ele
          // estava quando pulou — o pulo persegue.
          setTimeout(() => {
            estourar(ovo, presa.dead ? ovo.x : presa.x, presa.dead ? ovo.z : presa.z);
          }, puloMs);
        }

        if (Date.now() - nascidoEm >= hatch) {
          // Fim da chocagem: o que sobrou estoura no lugar.
          for (const ovo of ovos) {
            if (!ovo.vivo) continue;
            ovo.vivo = false;
            estourar(ovo, ovo.x, ovo.z);
          }
          const npcHits = hits.filter(h => h.isNPC).length;
          if (npcHits > 0) this.ctx.grantSkillXp(player, 'reliquia', npcHits * 14);
          return;
        }
        setTimeout(vigiar, POLL_MS);
      };
      setTimeout(vigiar, POLL_MS);
    }, castMs);

    effectPayload.targetX = cx;
    effectPayload.targetZ = cz;
    effectPayload.castMs  = castMs;
  }

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
          return burst(orb.x, orb.z);
        }
        orb.x += (dx / d) * stepDist;
        orb.z += (dz / d) * stepDist;
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
   * Cemitério de Naufrágios (relíquia): espelha o `_runWreckRain` do bicho —
   * UMA queda por `dropIntervalMs`, cada uma mirada em ONDE O ALVO ESTÁ naquele
   * instante, com `dropWarnMs` de janela de fuga.
   *
   * Antes as seis caíam juntas em pontos sorteados num disco de 75 un: virava
   * sorteio, o alvo raramente estava debaixo de alguma, e a skill que o bicho
   * usa como perseguição virava confete na mão do jogador. Agora a leitura é a
   * mesma dos dois lados: quem parar, leva; e cada destroço fecha a arena.
   *
   * O alvo é uma PESSOA, não um lugar: escolhido no cursor e reavaliado a cada
   * queda (se ele morrer, a chuva segue para o inimigo mais perto do lançador).
   */
  _castWreckRain(player, def, cx, cz, castMs, effectPayload) {
    const { addEvent, wallManager } = this.ctx;
    const mapLvl = player.mapLevel || 1;
    const drops  = Math.max(1, def.count || 6);
    const gapMs  = def.dropIntervalMs || 1000;
    const warnMs = def.dropWarnMs || 700;
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
          skill: def.skill, vfx: def.vfx, shape: 'multi', special: null,
          originX: dx, originZ: dz, targetX: dx, targetZ: dz, dirX: 0, dirZ: 1,
          castMs: warnMs, points: [{ x: 0, z: 0 }],
          params: {
            radius: def.radius, count: 1, spread: 0,
            obstacleRadius: r, holdMs: hold, dropIndex: i,
          },
        }, mapLvl);

        setTimeout(() => {
          if (player.dead) return;
          const hits = this._resolveOnce(player, { ...def, count: 1 },
            'circle', dx, dz, 0, 1, null, null, 0);
          addEvent({
            type: 'monster_skill_strike', casterId: player.id, skill: def.skill,
            vfx: def.vfx, originX: dx, originZ: dz, points: null, hits,
            radius: def.radius || 24,
          }, mapLvl);

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
      if (!npc.dead && (npc.mapLevel || 1) === (player.mapLevel || 1)) pool.push({ e: npc, isNPC: true });
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
        ...effectPayload,
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
            hits, radius: raio, ...effectPayload,
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
        ...effectPayload,
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
