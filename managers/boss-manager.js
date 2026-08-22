// managers/boss-manager.js
const { uid, rand } = require('../utils/helpers');
const { MAP_DEFS, FRAGMENT_DROP_BOSS, HIT_RADIUS, difficultyRewardMult } = require('../constants');
const db = require('./db-manager');
const fx = require('../utils/talent-effects');
const { partyRewardMult } = require('./party-manager');

/** Este jogador bateu no chefe? Quem bateu recebe pelo próprio dano e não deve
 *  levar também a parte de companheiro (ver a nota da recompensa de grupo). */
function dmgMapHas(boss, playerId) {
  const m = boss._damageMap;
  if (!m) return false;
  return m.has(playerId) || m.has(Number(playerId)) || m.has(String(playerId));
}

function rollRarity(rarities) {
  const total = rarities.reduce((s, r) => s + r.chance, 0);
  let roll = Math.random() * total;
  for (const r of rarities) {
    roll -= r.chance;
    if (roll <= 0) return r;
  }
  return rarities[0];
}

class BossManager {
  constructor(wss, players, npcs, zoneLevel = 1) {
    this.wss       = wss;
    this.players   = players;
    this.npcs      = npcs;          // map-specific NPC Map (npcManager.npcs)
    this.zoneLevel = zoneLevel;
    this.bossAlive = false;
    this.pendingRarity = null;

    // Monitoramento de memória em desenvolvimento
    if (process.env.NODE_ENV === 'development') {
      this._memoryCheckInterval = setInterval(() => this._checkMemory(), 60000);
    }
  }

  rollPendingRarity() {
    const bossDef = (MAP_DEFS[this.zoneLevel] || MAP_DEFS[1]).boss || {};
    const rarities = bossDef.rarities || [{ id: 'normal', label: 'Normal', hpMult: 1, rewardMult: 1, chance: 1, color: '#aaa' }];
    this.pendingRarity = rollRarity(rarities);
    return this.pendingRarity.id;
  }

  /**
   * Spawna o boss em stats base (× raridade). A dificuldade é aplicada logo em
   * seguida pelo NPCManager.update(), que reescala o boss para a dificuldade do
   * jogador mais próximo. Não escala mais pela quantidade de kills.
   * @param {number} _killerKills  ignorado (mantido por compatibilidade de assinatura)
   */
  spawn(_killerKills = 0) {
    if (this.bossAlive) return null;
    this.bossAlive = true;

    const bossDef   = (MAP_DEFS[this.zoneLevel] || MAP_DEFS[1]).boss || {};
    const rarities  = bossDef.rarities || [];
    const rarity    = this.pendingRarity || rollRarity(rarities);
    this.pendingRarity = null;

    const baseHp  = bossDef.baseHp || 600;
    const bossHp  = Math.round(baseHp * (rarity.hpMult || 1)); // dificuldade aplicada no update()
    const id      = uid();

    const mapSize = (MAP_DEFS[this.zoneLevel] && MAP_DEFS[this.zoneLevel].size);
    const boss = {
      id,
      name:        '☠ ' + (bossDef.name || 'El Diablo Negro'),
      x:           rand(-mapSize / 3, mapSize / 3),
      y:           0,
      z:           rand(-mapSize / 3, mapSize / 3),
      rotation:    rand(0, Math.PI * 2),
      hp:          bossHp,
      maxHp:       bossHp,
      speed:       0,
      targetId:    null,
      fireTimer:   2000,
      dead:        false,
      isNPC:       true,
      isBoss:      true,
      mapLevel:    this.zoneLevel, // ← critical: marks which map this boss belongs to
      rarity:      rarity.id,
      dmgMult:     rarity.hpMult || 1,   // use hpMult as proxy for dmgMult
      rewardMult:  rarity.rewardMult || 1,
      cannonDmg:   Math.round(bossDef.baseDamage || 0), // dificuldade aplicada no update()
      hitRadius:   bossDef.hitRadius || HIT_RADIUS,
      spawnTier:   0,
      diffMult:    1,                     // reescalado pela dificuldade no update()
      _scaledForDiff: 1,
      npcModel:     bossDef.model     || null,
      npcHullColor: bossDef.hullColor  || null,
      npcSailColor: bossDef.sailColor  || null,
      npcScale:     bossDef.scale      || null,
      npcYOffset:   bossDef.yOffset    || null,
      npcRotOffset: bossDef.rotOffset  ?? null,
      moveType:     bossDef.moveType   || null,
      closeRange:   bossDef.closeRange || 200,
      moveState:    'idle',
      // ── Aggro ────────────────────────────────────────────────────────────────
      aggroState:   'passive',                       // 'passive' | 'aggressive'
      // Boss que SÓ revida: nunca inicia combate, nem por proximidade. Usado nos
      // mapas de tutorial (1 e 2) para o novato não ser atacado sem querer.
      retaliateOnly: !!bossDef.retaliateOnly,
      _aggroRange:  (bossDef.aggroRange || 350),
      _aggroTime:   (bossDef.aggroTime  || 20) * 1000, // ms
      _proximityMap: new Map(),  // playerId → timestamp de entrada no raio
      _lastCheckedDmgTime: 0,
      // dobrão drop range from MAP_DEFS
      _dobraoMin:  bossDef.dobraoMin || 5,
      _dobraoMax:  bossDef.dobraoMax || 10,
      // Rastreia dano total por jogador para dividir recompensas proporcionalmente
      _damageMap:  new Map(),  // playerId → totalDamageDealt
      lastDamageTime: 0,
      // Sistema de ataques especiais
      attacks:          bossDef.attacks  || [],
      auras:            bossDef.auras    || [],
      _attackCooldowns: {},
      _currentCast:     null,
      _castTimer:       null,
      _auraTicks:       {},   // { auraId: lastTickTimestamp }
    };

    this.npcs.set(id, boss);

    // Only broadcast to players on this zone
    this._broadcastToZone({
      type: 'boss_spawn',
      entity: {
        id: boss.id, name: boss.name,
        x: boss.x, z: boss.z, rotation: boss.rotation,
        hp: boss.hp, maxHp: boss.maxHp,
        isNPC: true, isBoss: true,
        mapLevel: this.zoneLevel,
        rarity: rarity.id, rarityLabel: rarity.label, rarityColor: rarity.color,
        npcModel: boss.npcModel,
        npcHullColor: boss.npcHullColor, npcSailColor: boss.npcSailColor,
        spawnTier: boss.spawnTier,
      }
    });
    console.log(`👹 Boss [${rarity.label.toUpperCase()}] spawned on map ${this.zoneLevel}! HP:${bossHp} Tier:${boss.spawnTier}`);
    return boss;
  }

  _processPlayerReward(playerId, damage, boss, totalDamage) {
    if (!this.players) return; // BossManager já foi destruído (race com projectile flush)
    const player = this.players.get(playerId);
    if (!player) {
      console.warn(`[boss-debug] _processPlayerReward: player ${playerId} not found`);
      return;
    }

    const bossDef = (MAP_DEFS[this.zoneLevel] || MAP_DEFS[1]).boss || {};
    const rarities = bossDef.rarities || [];
    const rarityDef = rarities.find(r => r.id === boss.rarity) || {
      rewardMult: 1,
      label: 'Normal',
      color: '#aaa'
    };

    const dobraoMin = boss._dobraoMin || bossDef.dobraoMin || 5;
    const dobraoMax = boss._dobraoMax || bossDef.dobraoMax || 10;
    const baseDrops = Math.floor(rand(dobraoMin, dobraoMax + 1));
    // Recompensa escala pela METADE da dificuldade do boss (difficultyRewardMult).
    const diffScale = difficultyRewardMult((boss.diffMult || 1) / (boss.bloodMult || 1)) * (boss.bloodMult || 1);
    const totalDrops = Math.round(baseDrops * rarityDef.rewardMult * diffScale);

    // XP de mapa do boss — proporcional ao dano, escala por raridade × dificuldade.
    // Fonte: MAP_DEFS[n].boss.xpPerKill; sem essa propriedade o boss não dá XP.
    const bossXp  = bossDef.xpPerKill || 0;
    const totalXp = Math.round(bossXp * (rarityDef.rewardMult || 1) * diffScale);

    const share = damage / totalDamage;
    let drops    = Math.max(1, Math.round(totalDrops * share));
    let fragDrop = Math.round((FRAGMENT_DROP_BOSS[boss.rarity] || FRAGMENT_DROP_BOSS.normal) * share);
    let xpShare  = bossXp > 0 ? Math.max(1, Math.round(totalXp * share)) : 0;

    // Concede XP a um jogador aplicando o talento de XP + notificação de
    // desbloqueio de mapa. Espelha a lógica de kill de NPC no server.js.
    const grantMapXp = (pl, baseXp) => {
      // Zera ANTES do guard: sem isto, um chefe que não rende XP faria o extrato
      // repetir o ganho do chefe anterior, que ficou pendurado no jogador.
      pl._bossXpGain = 0;
      if (baseXp <= 0) return;
      // lootMult('xp_boss') junta Estudioso + Sabedoria Antiga + Tesouro do
      // Abismo. O `talentXpBonus` que estava aqui só tinha o Estudioso, então
      // o talento de XP DE CHEFE não valia justamente na morte de um chefe.
      const gain = Math.round(baseXp * fx.lootMult(pl, 'xp_boss'));
      pl.mapXp = (pl.mapXp || 0) + gain;
      pl._bossXpGain = gain;   // o extrato lá embaixo precisa do valor JÁ com o talento
      const xpNeeded = (MAP_DEFS[pl.mapLevel || 1] || MAP_DEFS[1]).xpToAdvance || 99999;
      if (xpNeeded && pl.mapXp >= xpNeeded && MAP_DEFS[(pl.mapLevel || 1) + 1]) {
        if (!pl._mapUnlockNotified) {
          pl._mapUnlockNotified = true;
          this._sendTo(pl.ws, { type: 'map_level_up', level: (pl.mapLevel || 1) + 1, xpNeeded });
        }
      } else {
        pl._mapUnlockNotified = false;
      }
    };
    const xpNeededFor = (pl) => (MAP_DEFS[pl.mapLevel || 1] || MAP_DEFS[1]).xpToAdvance || 99999;

    // ── Recompensa de grupo ──────────────────────────────────────────────────
    // O chefe já reparte por DANO: este método roda uma vez por agressor, cada
    // um com o seu `share`. Em cima disso o grupo ainda dividia de novo, e
    // caçar chefe acompanhado saía duas vezes pior — o mesmo castigo que os
    // abates comuns tinham e que agora acabou.
    //
    // Aqui a regra não pode ser "todo mundo leva a parte cheia de todo mundo":
    // num grupo de quatro em que os quatro bateram, cada um receberia a própria
    // parte MAIS a dos outros três, e o chefe pagaria quatro vezes o que vale.
    // Então: quem bateu leva a SUA parte com o bônus por companheiro, e quem
    // estava no grupo sem bater (o curandeiro da vez) leva uma parte, uma vez
    // só — o `_partyPaid` no próprio chefe é quem garante o "uma vez só", já
    // que este método é chamado em laço sobre o mapa de dano.
    const partyMembers = this.partyManager
      ? this.partyManager.getPartyMembersInZone(playerId, this.zoneLevel, this.players)
      : [];
    const partyMult = partyRewardMult(partyMembers.length);
    if (partyMult > 1.0) {
      drops    = Math.max(1, Math.round(drops    * partyMult));
      fragDrop = Math.max(0, Math.round(fragDrop * partyMult));
      xpShare  = Math.max(0, Math.round(xpShare  * partyMult));
    }

    if (!boss._partyPaid) boss._partyPaid = new Set();
    boss._partyPaid.add(playerId);
    const semParte = partyMembers.filter(m => !boss._partyPaid.has(m.id) && !dmgMapHas(boss, m.id));

    if (semParte.length > 0) {
      const memberDrops = drops;
      const memberFrags = fragDrop;
      const memberXp    = xpShare;

      for (const m of semParte) {
        boss._partyPaid.add(m.id);
        m.dobroes      = (m.dobroes      || 0) + memberDrops;
        m.mapFragments = (m.mapFragments || 0) + memberFrags;
        grantMapXp(m, memberXp);
        this.journal?.ledger(m, 'boss',
          { dobroes: memberDrops, xp: m._bossXpGain || 0 }, { target: boss.name });
        db.save(m, true).catch(e => console.error('Save error:', e));
        this._sendTo(m.ws, {
          type:     'currency_update',
          gold:     m.gold,
          dobroes:  m.dobroes,
          reward:   { type: 'dobrao', amount: memberDrops, share: Math.round(share * 100) },
          mapFragments: m.mapFragments,
          mapXp:        m.mapXp,
          mapLevel:     m.mapLevel || 1,
          mapXpNeeded:  xpNeededFor(m),
        });
      }
    }

    player.dobroes = (player.dobroes || 0) + drops;
    player.mapFragments = (player.mapFragments || 0) + fragDrop;
    grantMapXp(player, xpShare);
    // Chefe é evento raro e com nome — vai direto para o extrato, sem agregar.
    this.journal?.ledger(player, 'boss',
      { dobroes: drops, xp: player._bossXpGain || 0 }, { target: boss.name });

    db.save(player, true).catch(e => console.error('Save error:', e));
    console.log(`[boss-debug] rewarding player ${playerId}: damage=${damage} totalDmg=${totalDamage} xp=${xpShare} wsReady=${!!player.ws && player.ws.readyState === 1}`);

    this._sendTo(player.ws, {
      type: 'currency_update',
      gold: player.gold,
      dobroes: player.dobroes,
      reward: {
        type: 'dobrao',
        amount: drops,
        share: Math.round(share * 100)
      },
      mapFragments: player.mapFragments,
      mapXp:        player.mapXp,
      mapLevel:     player.mapLevel || 1,
      mapXpNeeded:  xpNeededFor(player),
    });
  }

  /**
   * Distribui recompensas proporcionalmente ao dano causado por cada jogador.
   * O matador recebe o crédito total se ninguém mais contribuiu.
   */
  onBossDead(boss, killerId) {
    if (!this.players) return; // BossManager já foi destruído
    this.bossAlive = false;
    const bossDef    = (MAP_DEFS[this.zoneLevel] || MAP_DEFS[1]).boss || {};
    const rarities   = bossDef.rarities || [];
    const rarityDef  = rarities.find(r => r.id === boss.rarity) || { rewardMult: 1, label: 'Normal', color: '#aaa' };
    const dobraoMin  = boss._dobraoMin || bossDef.dobraoMin || 5;
    const dobraoMax  = boss._dobraoMax || bossDef.dobraoMax || 10;
    const baseDrops  = Math.floor(rand(dobraoMin, dobraoMax + 1));
    // Escala a recompensa pela METADE da dificuldade do boss (difficultyRewardMult).
    const diffScale  = difficultyRewardMult((boss.diffMult || 1) / (boss.bloodMult || 1)) * (boss.bloodMult || 1);
    const totalDrops = Math.round(baseDrops * rarityDef.rewardMult * diffScale);

    // ── Calcular share de cada jogador pelo dano causado ─────────────────────
    const dmgMap = boss._damageMap || new Map();
    if (dmgMap.size === 0) {
      // Ninguém registrado → crédito total para o killer
      dmgMap.set(killerId, 1);
    }

    const totalDmg = Math.max(1, [...dmgMap.values()].reduce((a, b) => a + b, 0));
    for (const [playerId, dmg] of dmgMap.entries()) {
      this._processPlayerReward(playerId, dmg, boss, totalDmg);
    }

    // Callback bossAssists: todos os participantes (antes de limpar o damageMap)
    if (this._onBossAssist && this.players) {
      for (const [participantId] of dmgMap.entries()) {
        const participant = this.players.get(participantId);
        if (participant) this._onBossAssist(participant);
      }
    }

    // 🔥 CRÍTICO: Limpeza de memória
    boss._damageMap?.clear();
    boss._damageMap = null;
    this.npcs.delete(boss.id);

    // Callback para missões diárias (killer recebe crédito de boss kill)
    if (this._onBossKill && this.players) {
      const killer = this.players.get(killerId);
      if (killer) this._onBossKill(killer);
    }

    // Notificar jogadores (inclui mapa e total de drops para mensagem cliente)
    this._broadcastToZone({
      type: 'boss_dead', 
      bossId: boss.id, 
      killerId,
      rarity: boss.rarity,
      mapLevel: boss.mapLevel,
      drops: totalDrops,
    });
  }

  // Broadcast only to players on this zone
  _broadcastToZone(data) {
    if (!this.players) return; // BossManager já foi destruído
    // Serializar uma única vez
    const msg = JSON.stringify(data);
    this.players.forEach(p => {
      if ((p.mapLevel || 1) === this.zoneLevel && p.ws?.readyState === 1) {
        p.ws.send(msg);
      }
    });
  }

  _checkMemory() {
    const mem = process.memoryUsage();
    const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(mem.heapTotal / 1024 / 1024);
    
    console.log(`[Zone ${this.zoneLevel}] Heap: ${heapUsedMB}/${heapTotalMB}MB | NPCs: ${this.npcs.size}`);
    
    // Alerta se memória estiver alta
    if (heapUsedMB > 500) { // 500MB threshold
      console.warn(`⚠️ Alta memória na zona ${this.zoneLevel}: ${heapUsedMB}MB`);
    }
  }

  // 🔥 MÉTODO DE CLEANUP OBRIGATÓRIO
  destroy() {
    if (this._memoryCheckInterval) {
      clearInterval(this._memoryCheckInterval);
    }
    
    this.pendingRarity = null;
    this.wss = null;
    this.players = null;
    
    // Limpar NPCs desta zona
    if (this.npcs) {
      for (const [id, npc] of this.npcs) {
        if (npc.mapLevel === this.zoneLevel) {
          if (npc._damageMap) {
            npc._damageMap.clear();
            npc._damageMap = null;
          }
          if (npc._proximityMap) {
            npc._proximityMap.clear();
            npc._proximityMap = null;
          }
          this.npcs.delete(id);
        }
      }
    }
    
    this.npcs = null;
  }

  _sendTo(ws, data) {
    if (ws?.readyState === 1) ws.send(JSON.stringify(data));
  }
}

module.exports = BossManager;
