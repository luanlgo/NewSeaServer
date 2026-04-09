// managers/player-manager.js
const { uid, rand, clamp, sendTo } = require('../utils/helpers');
const { MAX_HP, SHIP_SPEED, MAX_CANNON_SLOTS, CANNON_DEFS, PIRATE_DEFS, MAP_DEFS } = require('../constants');

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
          bala_sangue: 0
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
      cannonLifesteal: 0,
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

  // Marcar jogador como visto (útil para detectar inatividade)
  markSeen(player) {
    if (player) {
      player.lastSeen = Date.now();
    }
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

  update(dt) {
    const now = Date.now();
    
    // Usar for...of em vez de forEach para melhor performance
    for (const player of this.players.values()) {
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

        const targetAngle = Math.atan2(dx, dz);
        let diff = targetAngle - player.rotation;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        player.rotation += diff * 0.3;

        const relicSpeed = 1 + (player.relicSpeedBonus || 0);
        // Penalidade de cast: ao atirar canhão ou usar relíquia o jogador fica lento
        // Não multiplica com slowMult — usa o pior dos dois para não empilhar (ex: aura -25% + cast 15% = quase parado)
        const hasCast   = !!(player.castExpires && player.castExpires > now);
        const slowMult  = player.slowMult || 1;
        const castMult  = hasCast ? Math.min(0.50, slowMult) : 1.0; // 50% during cast, or slower if already debuffed
        player.speed = SHIP_SPEED * slowMult * (player.shipSpeedMult || 1.0) *
                      (player.skillSpeedMult || 1.0) * (player.sailSpeedMult || 1.0) * relicSpeed * castMult;
        player.x += dx * player.speed * dt * 30;
        player.z += dz * player.speed * dt * 30;
      } else {
        player.speed = 0;
      }

      player.damageMultiplier = 1.0;

      // Status effects
      this._processStatusEffects(player, now);

      // Cannon cooldown
      this._processCannonCooldown(player, dt, now);

      // Island/structure avoidance — colisão física com ilhas e torres (dinâmico)
      const _mapLvl = player.mapLevel || 1;
      const _mapDef = MAP_DEFS[_mapLvl];
      if (_mapDef) {
        // Ilhas com islandRadius + center (market, lighthouse, banking, etc.)
        for (const val of Object.values(_mapDef)) {
          if (!val || typeof val !== 'object' || !val.islandRadius || !val.center) continue;
          const cx = val.center.x || 0;
          const cz = val.center.z || 0;
          const r  = val.islandRadius + 6;
          const dx = player.x - cx;
          const dz = player.z - cz;

          if (val.islandShape === 'square') {
            // AABB: empurra pelo eixo de menor penetração
            if (Math.abs(dx) < r && Math.abs(dz) < r) {
              const penX = r - Math.abs(dx);
              const penZ = r - Math.abs(dz);
              if (penX < penZ) {
                player.x = cx + Math.sign(dx || 1) * r;
              } else {
                player.z = cz + Math.sign(dz || 1) * r;
              }
            }
          } else {
            // Círculo
            const dist2 = dx * dx + dz * dz;
            if (dist2 < r * r && dist2 > 0) {
              const dist = Math.sqrt(dist2);
              player.x = cx + (dx / dist) * r;
              player.z = cz + (dz / dist) * r;
            }
          }
        }
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
    // Dot (Damage over Time)
    if (player.dot && now >= player.dot.next) {
      player.hp = Math.max(0, player.hp - player.dot.dmg);
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

  recalcCannonStats(p) {
    if (!p || !p.cannons || !p.cannons.length) {
      p.cannonRange = 80;
      p.cannonCooldownMax = 5000;
      p.cannonLifesteal = 0;
      p.cannonCooldown = 0;
    } else {
      let range = 0, sumCd = 0, bestLifesteal = 0;
      for (const cid of p.cannons) {
        const def = CANNON_DEFS[cid];
        if (def) {
          range = Math.max(range, def.range);
          sumCd += def.cooldown;
          bestLifesteal = Math.max(bestLifesteal, def.lifesteal || 0);
        }
      }
      p.cannonRange = range;
      p.cannonCooldownMax = Math.round(sumCd / p.cannons.length);
      // show highest lifesteal available; actual healing occurs per shot
      p.cannonLifesteal = Math.min(bestLifesteal, 0.5);
      p.cannonCooldown = 0;
    }
  }

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