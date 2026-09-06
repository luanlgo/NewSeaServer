// managers/player-manager.js
const { uid, rand, clamp, sendTo } = require('../utils/helpers');
const { pushOutOfIslands, pushOutOfWalls } = require('../utils/collision');
const { isInvincible } = require('../utils/invincibility');
const { MAX_HP, SHIP_SPEED, CANNON_DEFS, MAP_DEFS } = require('../constants');
const fx = require('../utils/talent-effects');
const status = require('../utils/talent-status');
const shield = require('../utils/shield');

// Giro base por tique (o valor que existia solto como 0.3 dentro do update).
const TURN_RATE = 0.3;
// Quanto da velocidade se perde numa curva fechada, antes do Casco Liso.
// Sem isso `drag_reduction_pct` (def_cascoliso) não teria o que reduzir.
const TURN_DRAG = 0.45;
// Rampas de aceleração/frenagem, em fração da velocidade-alvo por segundo.
// Escolhidas rápidas de propósito: a 6/s o navio chega à velocidade cheia em
// ~0,17s, então o toque continua imediato como antes e os talentos de
// aceleração (res_impulso) e de frenagem (def_ancoragem) ainda têm o que mexer.
const ACCEL_PER_SEC = 6.0;
const BRAKE_PER_SEC = 8.0;
// De quanto em quanto tempo a barra de status é REAVALIADA. O envio só acontece
// se o conjunto mudou, então isto é o atraso máximo até um ícone aparecer —
// 200ms é imperceptível e evita reavaliar 7 funções de talento a 20 Hz.
const STATUS_INTERVAL_MS = 200;

class PlayerManager {
  constructor() {
    this.players = new Map();
    
    // Mapa de timers de cleanup para jogadores inativos
    this._cleanupTimers = new Map();
    
    // Intervalo de verificação de jogadores inativos
    this._inactivityCheckInterval = setInterval(() => {
      this._checkInactivePlayers();
    }, 60000); // A cada minuto
  }

  create(ws, name) {
    const id = uid();
    
    // NÃO guardar referência direta ao WebSocket no player
    // Em vez disso, usar um wrapper ou referência fraca
    const player = {
      id,
      name,
      wsId: Symbol('ws'), // Identificador único para a conexão
      x: rand(-1000 / 2, 1000 / 2),
      y: 0,
      z: rand(-1000 / 2, 1000 / 2),
      rotation: 0,
      hp: MAX_HP,
      maxHp: MAX_HP,
      speed: 0,
      dead: false,
      input: { w: false, a: false, s: false, d: false },
      mapLevel: 1,

      // Recursos
      gold: 100,
      dobroes: 0,
      bankGold: 0,
      bankUnlocked: false,

      // Inventário - usar objetos com limites
      inventory: {
        cannons: [], // Máximo de 100 itens para prevenir crescimento infinito
        ammo: {
          bala_ferro: Infinity,
          bala_perfurante: 0,
          bala_gelo: 0,
          bala_fogo: 0,
          bala_luz: 0,
          bala_sangue: 0,
          bala_cura: 0,
        },
        pirates: [],
        ships: ['fragata'],
        sails: []
      },

      // Equipamento
      cannons: [],
      cannonCooldown: 0,
      cannonCooldownMax: 5000,
      cannonRange: 80,
      cannonAccuracy: 0,
      pirates: [],
      currentAmmo: 'bala_ferro',
      homingCharges: 0,
      damageMultiplier: 1.0,

      // Status
      lastActionTime: Date.now(),
      lastCombatTime: 0,
      healTimer: 0,
      dot: null,
      slowMult: 1,
      slowExpires: 0,
      stunExpires: 0,
      lastCooldownSent: 0,

      // Metadados
      createdAt: Date.now(),
      lastSeen: Date.now(),
      
      // Stats para debug/monitoramento
      _stats: {
        shotsFired: 0,
        damageDealt: 0,
        deaths: 0
      }
    };

    // Guardar referência ao WebSocket no player (usado pelo server.js) e no mapa separado
    player.ws = ws;
    this._wsMap = this._wsMap || new Map();
    this._wsMap.set(player.wsId, ws);
    ws._playerWsId = player.wsId;
    ws._playerId = player.id;

    this.players.set(id, player);
    
    console.log(`👤 Player created: ${name} (${id})`);
    return player;
  }

  // Método para obter WebSocket do jogador
  getWebSocket(player) {
    return this._wsMap?.get(player.wsId);
  }

  remove(id) {
    const player = this.players.get(id);
    if (!player) return;

    console.log(`👤 Removing player: ${player.name} (${id})`);

    // Cancelar qualquer timer de cleanup pendente
    if (this._cleanupTimers.has(id)) {
      clearTimeout(this._cleanupTimers.get(id));
      this._cleanupTimers.delete(id);
    }

    // Limpar referência ao WebSocket
    if (this._wsMap && player.wsId) {
      this._wsMap.delete(player.wsId);
    }
    player.ws = null;

    // Limpar arrays grandes
    this._cleanupPlayerData(player);

    // Remover do Map principal
    this.players.delete(id);
  }

  _cleanupPlayerData(player) {
    // Limpar objetos de efeitos
    player.dot = null;
    player.input = null;
    player._stats = null;
    // NÃO zerar arrays de inventário — corrompe saves em andamento
    // O GC libera a memória quando o objeto sai de todos os Maps
  }

  // Verificar jogadores inativos
  _checkInactivePlayers() {
    const now = Date.now();
    const INACTIVE_TIMEOUT = 5 * 60 * 1000; // 5 minutos
    
    for (const [id, player] of this.players.entries()) {
      // Se o jogador está inativo (sem ação por 5 minutos) E não tem WebSocket conectado
      if (now - player.lastSeen > INACTIVE_TIMEOUT) {
        const ws = this.getWebSocket(player);
        if (!ws || ws.readyState !== 1) {
          console.log(`👤 Removing inactive player: ${player.name}`);
          
          // Agendar remoção para dar tempo de salvar dados
          if (!this._cleanupTimers.has(id)) {
            const timer = setTimeout(() => {
              this.remove(id);
            }, 5000);
            this._cleanupTimers.set(id, timer);
          }
        }
      }
    }
  }

  get(id) {
    const player = this.players.get(id);
    if (player) {
      player.lastSeen = Date.now(); // Atualizar timestamp ao acessar
    }
    return player;
  }

  getAll() {
    // Retornar cópia dos valores para evitar modificações externas
    return Array.from(this.players.values());
  }

  /**
   * Barra de status: manda ao jogador a lista de talentos valendo agora.
   *
   * Só sai do servidor quando o CONJUNTO muda — a contagem regressiva o cliente
   * faz sozinho. Sem isso seriam 20 mensagens por segundo por jogador só para
   * dizer que o mesmo Frenesi continua em 3 pilhas.
   */
  _tickTalentStatus(player, now) {
    if (!player.ws || !player.tal) return;
    if (now - (player._talStatusAt || 0) < STATUS_INTERVAL_MS) return;
    player._talStatusAt = now;

    const allies = player._allyCount || 0;
    const list = status.activeStatuses(player, {
      isStill:   !player.speed,
      isMoving:  !!player.speed,
      inParty:   allies > 0,
      allyCount: allies,
      // O jogo ainda não tem penalidade de clima nem correnteza, então Vento
      // Próprio e Cavalgar as Ondas nunca acendem — acendem sozinhos no dia em
      // que esses sistemas existirem.
      badWeather:  false,
      withCurrent: false,
    }, now);

    const sig = status.signature(list, now);
    if (sig === player._talStatusSig) return;
    player._talStatusSig = sig;
    sendTo(player.ws, { type: 'talent_status', list });
  }

  /**
   * Vento de Esquadra (res_esquadra): quem tem o talento doa velocidade ao
   * grupo por perto. Calculado uma vez por tique e guardado em cada jogador,
   * porque o loop de movimento roda por jogador e não pode varrer o grupo
   * inteiro a cada um.
   */
  _refreshPartySpeedAuras() {
    if (!this.partyManager?.getPartyMembersInZone) return;
    for (const p of this.players.values()) {
      if (p.dead) continue;
      const membros = this.partyManager.getPartyMembersInZone(p.id, p.mapLevel || 1, this.players);
      let bonus = 0;
      for (const m of membros) bonus += fx.partySpeedAura(m);
      p._partySpeedBonus = bonus;
      // Moral de Ferro e Lobo do Mar leem daqui em vez de varrer o grupo de novo.
      p._allyCount = membros.length;
    }
  }

  /**
   * Calafate, Bombas de Porão e Reparos de Emergência. Acumulador fracionário
   * porque as três somam menos de 1 de vida por segundo nos primeiros níveis.
   */
  _processTalentRegen(player, dt, now) {
    if (player.dead || !player.maxHp || player.hp >= player.maxHp) {
      player._regenAcc = 0;
      return;
    }
    const perSec = fx.hpRegenPerSec(player, now);
    if (perSec <= 0) return;
    player._regenAcc = (player._regenAcc || 0) + perSec * dt;
    if (player._regenAcc >= 1) {
      const add = Math.floor(player._regenAcc);
      player._regenAcc -= add;
      player.hp = Math.min(player.maxHp, player.hp + add);
    }
  }

  update(dt) {
    const now = Date.now();
    this._refreshPartySpeedAuras();

    // Usar for...of em vez de forEach para melhor performance
    for (const player of this.players.values()) {
      // A regeneração roda ANTES do guard de stun/morte: quem está atordoado
      // continua se reparando, e quem morreu já é filtrado dentro dela.
      this._processTalentRegen(player, dt, now);
      if (player.dead || (player.stunExpires && player.stunExpires > now)) continue;

      // Atualizar timestamp
      player.lastSeen = now;

      // Movement
      let dx = 0, dz = 0;
      if (player.input?.w) dz -= 1;
      if (player.input?.s) dz += 1;
      if (player.input?.a) dx -= 1;
      if (player.input?.d) dx += 1;

      // Click-to-move (LoL mode) — only active when no WASD key is held
      if (dx === 0 && dz === 0 && player.moveTarget) {
        const mdx = player.moveTarget.x - player.x;
        const mdz = player.moveTarget.z - player.z;
        const dist = Math.hypot(mdx, mdz);
        if (dist < 8) {
          player.moveTarget = null; // reached destination
        } else {
          dx = mdx / dist;
          dz = mdz / dist;
        }
      }

      if (dx !== 0 || dz !== 0) {
        const len = Math.hypot(dx, dz);
        dx /= len;
        dz /= len;

        // Arrancada: marca a saída da imobilidade uma vez só.
        if (!player._wasMoving) {
          fx.onMoveStart(player, now);
          player._wasMoving = true;
        }

        const targetAngle = Math.atan2(dx, dz);
        let diff = targetAngle - player.rotation;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;

        // Leme Leve gira mais rápido. (A Deriva somava manobra em velocidade
        // máxima e virou precisão de canhão — o `atFullSpeed` segue calculado
        // porque o turnRateMult ainda aceita o argumento, mas hoje é inerte.)
        const atFullSpeed = (player._velFrac || 0) > 0.85;
        player.rotation += diff * Math.min(1, TURN_RATE * fx.turnRateMult(player, atFullSpeed));

        const relicSpeed = 1 + (player.relicSpeedBonus || 0);
        // Penalidade de cast: ao atirar canhão ou usar relíquia o jogador fica lento
        // Não multiplica com slowMult — usa o pior dos dois para não empilhar (ex: aura -25% + cast 15% = quase parado)
        const hasCast   = !!(player.castExpires && player.castExpires > now);
        const slowMult  = player.slowMult || 1;
        const castMult  = hasCast ? Math.min(0.50, slowMult) : 1.0; // 50% during cast, or slower if already debuffed

        // Curva fechada custa velocidade. (O Casco Liso devolvia parte da perda
        // e virou escudo de vida baixa; a ré tinha bônus da Marcha à Ré, que
        // virou resistência a navio de NPC. Os dois eixos continuam existindo,
        // agora sem talento em cima.)
        const turnDrag = 1 - (Math.abs(diff) / Math.PI) * TURN_DRAG;

        const target = SHIP_SPEED * slowMult * (player.shipSpeedMult || 1.0) *
                      (player.skillSpeedMult || 1.0) * (player.sailSpeedMult || 1.0) *
                      relicSpeed * castMult * turnDrag *
                      fx.speedMult(player, { now, partyBonus: player._partySpeedBonus || 0 });

        // Rampa de aceleração — `_velFrac` é a fração da velocidade-alvo já
        // atingida. (O Impulso encurtava a subida e virou XP de mascote.)
        const rate = ACCEL_PER_SEC;
        player._velFrac = Math.min(1, (player._velFrac || 0) + rate * dt);
        player.speed = target * player._velFrac;

        player.x += dx * player.speed * dt * 30;
        player.z += dz * player.speed * dt * 30;
      } else {
        // Sem comando o navio DESLIZA até parar, em vez de travar no lugar. A
        // rampa é curta de propósito (~0,12s). (A Ancoragem Rápida encurtava
        // este tempo e virou redução de dano de torre.)
        player._wasMoving = false;
        const brake = BRAKE_PER_SEC;
        player._velFrac = Math.max(0, (player._velFrac || 0) - brake * dt);
        if (player._velFrac > 0.01) {
          const coast = SHIP_SPEED * (player.slowMult || 1) * (player.shipSpeedMult || 1.0) *
                        (player.skillSpeedMult || 1.0) * (player.sailSpeedMult || 1.0) *
                        fx.speedMult(player, { now, partyBonus: player._partySpeedBonus || 0 });
          player.speed = coast * player._velFrac;
          player.x += Math.sin(player.rotation) * player.speed * dt * 30;
          player.z += Math.cos(player.rotation) * player.speed * dt * 30;
        } else {
          player._velFrac = 0;
          player.speed = 0;
        }
      }

      // Acúmulos e janelas dos talentos de combate.
      fx.tickCombatState(player, now);
      this._tickTalentStatus(player, now);

      player.damageMultiplier = 1.0;

      // Status effects
      this._processStatusEffects(player, now);

      // Cannon cooldown
      this._processCannonCooldown(player, dt, now);

      // Island/structure avoidance — colisão física com ilhas e torres (dinâmico)
      const _mapLvl = player.mapLevel || 1;
      const _mapDef = MAP_DEFS[_mapLvl];
      if (_mapDef) {
        // Ilhas (market/lighthouse/banking...) — formas do editor de colisão
        // (tecla 2) ou fallback círculo/quadrado do islandRadius. A lógica vive
        // em utils/collision.js e é COMPARTILHADA com os NPCs.
        pushOutOfIslands(player, _mapDef, 6);
        // Muros temporários de relíquia (ex.: Muro de Pedra) — mesmo formato
        // de forma dos colliders de ilha, mas com expiração própria.
        const _activeWalls = this.wallManager?.getActive(_mapLvl);
        if (_activeWalls && _activeWalls.length) pushOutOfWalls(player, _activeWalls, 6);
        // Torre de treino: usa dummy.x/z + collisionRadius (estrutura diferente)
        if (_mapDef.training?.dummy !== undefined) {
          const tr = _mapDef.training;
          const cx = tr.dummy.x ?? 0;
          const cz = tr.dummy.z ?? -120;
          const iRad = (tr.collisionRadius || 18) + 6;
          const dx = player.x - cx;
          const dz = player.z - cz;
          const dist2 = dx * dx + dz * dz;
          if (dist2 < iRad * iRad && dist2 > 0) {
            const dist = Math.sqrt(dist2);
            player.x = cx + (dx / dist) * iRad;
            player.z = cz + (dz / dist) * iRad;
          }
        }
      }

      // Boundaries — usar ?? para mapas sem MAP_DEFS (dungeons/bônus usam mapLevel 10-12)
      const mapBound = (MAP_DEFS[player.mapLevel || 1]?.size ?? 1200) / 2;
      player.x = clamp(player.x, -mapBound, mapBound);
      player.z = clamp(player.z, -mapBound, mapBound);
    }
  }

  _processStatusEffects(player, now) {
    // Dot (Damage over Time) — invencível (Névoa do jogador ou do pet) pausa o
    // tick, mas NÃO gasta a carga do escudo: ver utils/invincibility.js.
    if (player.dot && now >= player.dot.next && !isInvincible(player, now)) {
      player.hp = Math.max(0, player.hp - shield.absorb(player, player.dot.dmg).dmg);
      player.dot.dur -= player.dot.tick;
      
      if (player.dot.dur <= 0) {
        player.dot = null; // Limpar Dot expirado
      } else {
        player.dot.next = now + player.dot.tick;
      }
    }

    // Slow (legado — via slowExpires)
    if (player.slowExpires && now > player.slowExpires) {
      player.slowMult = 1;
      player.slowExpires = 0;
    }

    // speed_buff de activeDebuffs (auras, ataques especiais)
    const speedDebuff = player.activeDebuffs?.find(d => d.type === 'speed_buff' && d.expiresAt > now);
    if (speedDebuff) {
      player.slowMult = Math.max(0.1, 1 + speedDebuff.value); // -0.25 → 0.75 (75% speed)
    } else if (!player.slowExpires || player.slowExpires <= now) {
      player.slowMult = 1; // restaura se não tem mais debuff
    }

    // Stun
    if (player.stunExpires && now > player.stunExpires) {
      player.stunExpires = 0;
    }
  }

  _processCannonCooldown(player, dt, now) {
    if (player.cannonCooldown > 0) {
      player.cannonCooldown = Math.max(0, player.cannonCooldown - dt * 1000);
      
      if (player.cannonCooldown === 0) {
        const totalOnRefill = this.getSalvoCount(player.cannons) || 1;
        player.cannonCharges = totalOnRefill;
        player.homingCharges = 0;
        
        const ws = this.getWebSocket(player);
        if (ws && (now - (player.lastCooldownSent || 0)) > 100) {
          player.lastCooldownSent = now;
          sendTo(ws, {
            type: 'cannon_state',
            charges: totalOnRefill,
            maxCharges: totalOnRefill,
            cooldown: 0,
            cooldownMax: player.cannonCooldownMax,
            homingCharges: player.homingCharges,
          });
        }
      }
    }
  }

  // A conta de alcance/recarga/roubo de vida dos canhões mora em
  // `recalcCannons()` no server.js, que é quem todos os dez pontos de troca de
  // canhão chamam. Existia aqui uma segunda cópia que ninguém usava.

  getSalvoCount(cannons) {
    if (!cannons || !cannons.length) return 1;
    
    return cannons.reduce((sum, cid) => {
      const def = CANNON_DEFS[cid];
      return sum + (def?.doubleShot ? 2 : 1);
    }, 0);
  }

  snapshot() {
    const snapshot = [];
    
    for (const p of this.players.values()) {
      if (p.dead) continue; // Não enviar jogadores mortos no snapshot normal
      
      snapshot.push({
        id: p.id,
        name: p.name,
        x: p.x,
        y: p.y,
        z: p.z,
        activeShip: p.activeShip || 'fragata',
        rotation: p.rotation,
        hp: p.hp,
        maxHp: p.maxHp,
        speed: p.speed,
        dead: p.dead,
        isPlayer: true,
        mapLevel: p.mapLevel || 1,
        cannonCooldown: p.cannonCooldown,
        cannonCooldownMax: p.cannonCooldownMax,
        cannonRange: p.cannonRange,
        // Patente do ranking PVP (0 = sem medalha). Vai no registro completo,
        // que o AOI só manda quando a entidade entra na visão — é de graça para
        // quem já está na tela, e a faixa muda no máximo uma vez por minuto.
        // Quem mantém o campo atualizado é sweepPvpRank() no server.js.
        pvpTier: p._pvpTier || 0,
      });
    }
    
    return snapshot;
  }

  // Método para limpar todos os recursos (chamado no shutdown)
  destroy() {
    console.log('🛑 Destroying PlayerManager...');
    
    // Limpar intervalo de verificação
    if (this._inactivityCheckInterval) {
      clearInterval(this._inactivityCheckInterval);
      this._inactivityCheckInterval = null;
    }
    
    // Cancelar todos os timers de cleanup
    for (const timer of this._cleanupTimers.values()) {
      clearTimeout(timer);
    }
    this._cleanupTimers.clear();
    
    // Limpar todos os jogadores
    for (const player of this.players.values()) {
      this._cleanupPlayerData(player);
    }
    
    this.players.clear();
    
    // Limpar mapa de WebSockets
    if (this._wsMap) {
      this._wsMap.clear();
      this._wsMap = null;
    }
    
    console.log('✅ PlayerManager destroyed');
  }
}

module.exports = PlayerManager;