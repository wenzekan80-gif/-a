// server.js
// npm i ws
const WebSocket = require("ws");
const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: PORT });

/** -----------------------------
 *  Game constants
 * ------------------------------ */
const FACTIONS = ["前政党", "建制派", "民粹党", "民主党派", "境外势力"];
const ROLES = ["普通政客", "民粹强人", "独裁强人"]; // 暗面身份
const MAX_TURNS = 8;

const ACTIONS = [
  { key: "mobilize_unify", name: "动员·团结", desc: "+L +1, 花R1", costR: 1 },
  { key: "mobilize_divide", name: "动员·煽动", desc: "+C +1, -L1, 花R1", costR: 1 },
  { key: "infiltrate", name: "渗透机构", desc: "+C +2, -L1, 花R2", costR: 2 },
  { key: "agenda", name: "推动议程", desc: "推进本阵营进度 +1, 花R2", costR: 2 },
  { key: "investigate", name: "调查/爆料", desc: "提高对手暴露度/削弱其R, 花R1", costR: 1 },
  { key: "foreign_ops", name: "对外操作", desc: "+E +2, -L1, 花R1", costR: 1 },
  { key: "trade", name: "政策交易", desc: "给/要资源（简化：自己+R1，-L1）", costR: 0 },
];

const SECRET_SKILLS = {
  "普通政客": { name: "无", desc: "无" },
  "民粹强人": { name: "夺取议程", desc: "本回合将一次行动效果翻倍，但暴露度+2（每局一次）" },
  "独裁强人": { name: "冻结机构", desc: "本回合令对手C增益无效，并暴露度+1（每局一次）" },
};

// 事件牌：影响全局 + 提供回合特性
const EVENTS = [
  { name: "经济放缓", effects: { P: -1, L: -1 }, text: "蛋糕变小，情绪上头。" },
  { name: "外部制裁", effects: { E: +1, P: -1, L: -1 }, text: "外部压力上升，内部互相甩锅。" },
  { name: "科技突破", effects: { P: +2, L: +1 }, text: "短期繁荣，合法性回暖。" },
  { name: "丑闻曝光", effects: { L: -2 }, text: "公共信任崩一截。" },
  { name: "边境摩擦", effects: { E: +1, C: +1, L: -1 }, text: "安全叙事抬头。" },
  { name: "大规模失业", effects: { P: -2, L: -2 }, text: "社会温度骤降。" },
  { name: "国际援助", effects: { E: +1, P: +1, L: +1 }, text: "外部介入加深，但缓解了危机。" },
  { name: "街头运动", effects: { L: -1, C: -1 }, text: "秩序与正当性同时被拷打。" },
];

/** -----------------------------
 *  Utilities
 * ------------------------------ */
function randInt(n) { return Math.floor(Math.random() * n); }
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

function safeSend(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj) {
  room.players.forEach(p => {
    if (p.kind === "human") safeSend(p.ws, obj);
  });
}

/** -----------------------------
 *  Room state
 * ------------------------------ */
const rooms = new Map();

/**
 * player: {
 *   id, name, kind: "human"|"ai",
 *   ws? (human only),
 *   faction, role (secret),
 *   R, agenda, exposure,
 *   usedSecret (bool)
 * }
 */
function createRoom(roomId) {
  const deck = shuffle(EVENTS);
  const room = {
    id: roomId,
    createdAt: Date.now(),
    players: [],
    started: false,
    turn: 0,
    phase: "lobby", // lobby | event | action | shadow | end
    currentPlayerIdx: 0,
    eventDeck: deck,
    discard: [],
    log: [],
    // global tracks
    L: 6, C: 5, P: 6, E: 3,
    crisis: 0,
    winner: null,
    ending: null,
  };
  rooms.set(roomId, room);
  return room;
}

function getRoom(roomId) {
  return rooms.get(roomId) || createRoom(roomId);
}

function publicState(room) {
  return {
    id: room.id,
    started: room.started,
    turn: room.turn,
    phase: room.phase,
    currentPlayerIdx: room.currentPlayerIdx,
    L: room.L, C: room.C, P: room.P, E: room.E,
    crisis: room.crisis,
    winner: room.winner,
    ending: room.ending,
    eventTop: room.currentEvent ? { name: room.currentEvent.name, text: room.currentEvent.text, effects: room.currentEvent.effects } : null,
    players: room.players.map(p => ({
      id: p.id, name: p.name, kind: p.kind,
      faction: p.faction, // 阵营明牌
      R: p.R, agenda: p.agenda, exposure: p.exposure,
      // role 不公开
      usedSecret: p.usedSecret
    })),
    log: room.log.slice(-80),
  };
}

function privateState(room, playerId) {
  const p = room.players.find(x => x.id === playerId);
  if (!p) return null;
  return {
    me: {
      id: p.id, name: p.name,
      faction: p.faction,
      role: p.role, // 暗面仅自己可见
      secretSkill: SECRET_SKILLS[p.role],
      R: p.R, agenda: p.agenda, exposure: p.exposure,
      usedSecret: p.usedSecret,
    }
  };
}

/** -----------------------------
 *  Game setup / start
 * ------------------------------ */
function addHuman(room, ws, name) {
  const id = `H${Date.now()}_${Math.random().toString(16).slice(2, 6)}`;
  room.players.push({
    id, name, kind: "human", ws,
    faction: null, role: null,
    R: 4, agenda: 0, exposure: 0, usedSecret: false,
  });
  return id;
}

function addAI(room, name) {
  const id = `A${Date.now()}_${Math.random().toString(16).slice(2, 6)}`;
  room.players.push({
    id, name, kind: "ai",
    faction: null, role: null,
    R: 4, agenda: 0, exposure: 0, usedSecret: false,
  });
  return id;
}

function dealFactionsAndRoles(room) {
  const factions = shuffle(FACTIONS);
  // 让“境外势力”出现概率适中：如果玩家>=3则必有一个；否则随机
  // 这里简单：从洗好的阵营里顺序发
  room.players.forEach((p, i) => {
    p.faction = factions[i % factions.length];
  });

  // 暗面身份：每局至少一个强人（民粹强人/独裁强人随机）
  const rolesPool = room.players.map(() => "普通政客");
  const strongIdx = randInt(room.players.length);
  rolesPool[strongIdx] = randInt(2) === 0 ? "民粹强人" : "独裁强人";
  // 额外强人（可选）：人数>=4再给一个
  if (room.players.length >= 4) {
    let idx2 = randInt(room.players.length);
    if (idx2 === strongIdx) idx2 = (idx2 + 1) % room.players.length;
    rolesPool[idx2] = randInt(2) === 0 ? "民粹强人" : "独裁强人";
  }
  room.players.forEach((p, i) => p.role = rolesPool[i]);
}

function startGame(room) {
  if (room.started) return;
  if (room.players.length < 2) return;
  room.started = true;
  room.turn = 1;
  room.phase = "event";
  room.currentPlayerIdx = randInt(room.players.length);
  dealFactionsAndRoles(room);
  room.log.push(`🎲 游戏开始！先手：${room.players[room.currentPlayerIdx].name}`);
  drawEvent(room);
  broadcastState(room);
  // 如果先手是AI，推进
  maybeRunAI(room);
}

function drawEvent(room) {
  if (room.eventDeck.length === 0) {
    room.eventDeck = shuffle(room.discard);
    room.discard = [];
  }
  const ev = room.eventDeck.pop();
  room.currentEvent = ev;
  room.discard.push(ev);

  // 应用事件效果
  if (ev.effects) {
    if (ev.effects.L) room.L += ev.effects.L;
    if (ev.effects.C) room.C += ev.effects.C;
    if (ev.effects.P) room.P += ev.effects.P;
    if (ev.effects.E) room.E += ev.effects.E;
  }
  room.L = clamp(room.L, 0, 10);
  room.C = clamp(room.C, 0, 10);
  room.P = clamp(room.P, 0, 10);
  room.E = clamp(room.E, 0, 10);

  room.log.push(`📰 事件：${ev.name}（${ev.text}）`);
  room.phase = "action";
}

function broadcastState(room) {
  broadcast(room, { type: "state", state: publicState(room) });
  // 每个玩家也发私密信息
  room.players.forEach(p => {
    if (p.kind === "human") {
      safeSend(p.ws, { type: "private", state: privateState(room, p.id) });
    }
  });
}

function endGame(room, winnerFaction, ending) {
  room.phase = "end";
  room.winner = winnerFaction;
  room.ending = ending;
  room.log.push(`🏁 终局：${ending} —— 胜利方：${winnerFaction}`);
  broadcastState(room);
}

/** -----------------------------
 *  Win conditions / crisis
 * ------------------------------ */
function checkCrisisAndWin(room) {
  // 危机：合法性或繁荣过低
  if (room.L <= 2 || room.P <= 2) {
    room.crisis += 1;
    room.log.push(`🚨 国家危机升级！(危机层数 ${room.crisis})`);
  }

  // 立即胜利：境外势力
  if (room.E >= 8) {
    endGame(room, "境外势力", "外部影响阈值触发：国家进入外部锁定结局");
    return true;
  }

  // 常规路线：民主/建制（合法性高且没崩）
  if (room.L >= 9 && room.P >= 6 && room.crisis <= 1) {
    // 这俩阵营更可能吃到这个结局：但胜利方按议程进度更高者优先
    const best = pickBestByAgenda(room, ["民主党派", "建制派"]);
    endGame(room, best || "建制派", "高合法性稳定结局：制度化/修补成功");
    return true;
  }

  // 民粹/强人：控制力高
  if (room.C >= 9 && room.L <= 6) {
    const best = pickBestByAgenda(room, ["民粹党"]);
    endGame(room, best || "民粹党", "控制力压倒性胜利：议程被强行改写");
    return true;
  }

  // 前政党：控制力高但改革停滞（用 agenda 作为“旧秩序运作”的替代）
  // 这里简化：前政党议程>=4 且 L 介于 3-7
  const old = room.players.filter(p => p.faction === "前政党");
  if (old.some(p => p.agenda >= 4) && room.L >= 3 && room.L <= 7) {
    endGame(room, "前政党", "旧秩序回潮结局：机构与人事重新锁死");
    return true;
  }

  // 崩盘：危机过高或回合耗尽
  if (room.crisis >= 3) {
    // 崩盘结算：谁的 C+agenda 更高谁吃到权力碎片；境外势力若E>=6优先赢
    if (room.E >= 6) {
      endGame(room, "境外势力", "崩盘外溢结局：外部趁乱完成锁定");
      return true;
    }
    const best = room.players.slice().sort((a, b) => (b.CScore || 0) - (a.CScore || 0));
    // 计算简单分数：个人agenda + (全局C/2) - 暴露度惩罚
    let top = null;
    let topScore = -1e9;
    for (const p of room.players) {
      const score = p.agenda + room.C / 2 - p.exposure * 0.3 + (p.faction === "民粹党" ? 0.3 : 0);
      p.CScore = score;
      if (score > topScore) { topScore = score; top = p; }
    }
    endGame(room, top ? top.faction : "民粹党", "崩盘碎片结局：赢家只是最后站着的人");
    return true;
  }

  if (room.turn >= MAX_TURNS) {
    // 到点结算：按 faction 的“议程总和”决定
    const totals = {};
    for (const f of FACTIONS) totals[f] = 0;
    room.players.forEach(p => totals[p.faction] += p.agenda);
    const bestFaction = Object.entries(totals).sort((a, b) => b[1] - a[1])[0][0];
    endGame(room, bestFaction, "时间到：以议程推进为准的妥协结局");
    return true;
  }

  return false;
}

function pickBestByAgenda(room, factions) {
  const candidates = room.players.filter(p => factions.includes(p.faction));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.agenda - a.agenda);
  return candidates[0].faction;
}

/** -----------------------------
 *  Apply actions
 * ------------------------------ */
function getPlayer(room, playerId) {
  return room.players.find(p => p.id === playerId);
}
function isPlayersTurn(room, playerId) {
  return room.players[room.currentPlayerIdx]?.id === playerId;
}

function factionModifiers(player, room) {
  // 每个阵营一个小被动（原型级别）
  // 前政党：渗透成本-1
  // 建制派：事件负面减轻（这里简化为行动修补+1）
  // 民粹党：动员更强（团结/煽动额外+1效果，但更易降L）
  // 民主党派：调查更强（investigate额外提高对手暴露）
  // 境外势力：对外更强（foreign_ops额外+1E）
  return {
    infiltrateCostDiscount: player.faction === "前政党" ? 1 : 0,
    reformBonus: player.faction === "建制派" ? 1 : 0,
    mobilizeBonus: player.faction === "民粹党" ? 1 : 0,
    investigateBonus: player.faction === "民主党派" ? 1 : 0,
    foreignBonus: player.faction === "境外势力" ? 1 : 0,
  };
}

function nextTurn(room) {
  // 行动阶段：每人一次行动 -> 进入暗线阶段 -> 下一回合事件
  // 这里我们简化：每次行动后换人；当回合每人都行动过一次后进入 shadow
  // 用一个计数器 room.actionsThisTurn
  room.actionsThisTurn = (room.actionsThisTurn || 0) + 1;
  const totalPlayers = room.players.length;

  // 换到下一个玩家
  room.currentPlayerIdx = (room.currentPlayerIdx + 1) % totalPlayers;

  if (room.actionsThisTurn >= totalPlayers) {
    // 进入暗线阶段：允许每人一次暗线技能（强人可用）
    room.phase = "shadow";
    room.shadowQueue = room.players.map(p => p.id);
    room.log.push("🌑 进入暗线阶段：可发动隐藏技能（若有且未用）。");
    // 暗线结束后结算/下一回合
  } else {
    room.phase = "action";
  }
}

function finishShadowAndAdvance(room) {
  // 暗线结束 -> 结算胜负 -> 下一回合
  room.phase = "event";
  room.actionsThisTurn = 0;
  room.turn += 1;

  // 基础回合收入：每人+R1；部分阵营额外
  room.players.forEach(p => {
    p.R += 1;
    if (p.faction === "前政党") p.R += 1; // 旧系统吸血
    if (p.faction === "民主党派" && room.L >= 7) p.R += 1; // 社会组织动员
    p.R = clamp(p.R, 0, 10);
  });

  // 全局自然漂移：P 太低进一步拖累 L
  if (room.P <= 3) room.L = clamp(room.L - 1, 0, 10);

  // 抽事件
  drawEvent(room);

  // 胜负检查
  if (checkCrisisAndWin(room)) return;

  broadcastState(room);
  maybeRunAI(room);
}

function applyAction(room, playerId, actionKey, payload = {}) {
  if (!room.started || room.phase !== "action") return { ok: false, err: "不在行动阶段" };
  if (!isPlayersTurn(room, playerId)) return { ok: false, err: "还没轮到你" };

  const p = getPlayer(room, playerId);
  if (!p) return { ok: false, err: "玩家不存在" };

  const mods = factionModifiers(p, room);
  const action = ACTIONS.find(a => a.key === actionKey);
  if (!action) return { ok: false, err: "未知行动" };

  let cost = action.costR;
  if (actionKey === "infiltrate") cost = Math.max(0, cost - mods.infiltrateCostDiscount);
  if (p.R < cost) return { ok: false, err: "资源不足" };

  p.R -= cost;

  // 处理行动效果
  let logLine = `▶️ ${p.name}（${p.faction}）行动：${action.name}`;

  if (actionKey === "mobilize_unify") {
    room.L = clamp(room.L + 1 + mods.mobilizeBonus, 0, 10);
    if (p.faction === "民粹党") room.P = clamp(room.P - 1, 0, 10); // 民粹动员的经济代价
  }

  if (actionKey === "mobilize_divide") {
    room.C = clamp(room.C + 1 + mods.mobilizeBonus, 0, 10);
    room.L = clamp(room.L - 1 - (p.faction === "民粹党" ? 1 : 0), 0, 10);
    p.exposure = clamp(p.exposure + 1, 0, 10);
  }

  if (actionKey === "infiltrate") {
    room.C = clamp(room.C + 2, 0, 10);
    room.L = clamp(room.L - 1, 0, 10);
    if (p.faction === "前政党") p.agenda += 1; // 旧系统渗透=推进旧议程
  }

  if (actionKey === "agenda") {
    p.agenda += 1;
    // 阵营差异：民主议程提高L；建制议程提高P；民粹议程提高C；境外议程提高E；前政党议程提高C但降L
    if (p.faction === "民主党派") room.L = clamp(room.L + 1, 0, 10);
    if (p.faction === "建制派") room.P = clamp(room.P + 1, 0, 10);
    if (p.faction === "民粹党") room.C = clamp(room.C + 1, 0, 10);
    if (p.faction === "境外势力") room.E = clamp(room.E + 1, 0, 10);
    if (p.faction === "前政党") { room.C = clamp(room.C + 1, 0, 10); room.L = clamp(room.L - 1, 0, 10); }
  }

  if (actionKey === "investigate") {
    // 选一个对手：简化为“当前最大威胁者”
    const target = pickThreat(room, p.id);
    if (target) {
      const extra = 1 + mods.investigateBonus;
      target.exposure = clamp(target.exposure + extra, 0, 10);
      // 爆料可能让对方掉资源
      if (target.exposure >= 5 && target.R > 0) target.R -= 1;
      logLine += ` → 针对 ${target.name}（暴露+${extra}）`;
    }
  }

  if (actionKey === "foreign_ops") {
    room.E = clamp(room.E + 2 + mods.foreignBonus, 0, 10);
    room.L = clamp(room.L - 1, 0, 10);
    // 外部影响上升也会拖繁荣
    room.P = clamp(room.P - 1, 0, 10);
  }

  if (actionKey === "trade") {
    // 简化交易：自己+R1 但 -L1（暗箱交易侵蚀合法性）
    p.R = clamp(p.R + 1, 0, 10);
    room.L = clamp(room.L - 1, 0, 10);
  }

  room.log.push(logLine);

  // 行动后检查胜负（行动可能触发阈值）
  if (checkCrisisAndWin(room)) {
    broadcastState(room);
    return { ok: true };
  }

  nextTurn(room);
  broadcastState(room);
  maybeRunAI(room);
  return { ok: true };
}

function pickThreat(room, attackerId) {
  // 威胁：优先找议程高、阵营目标接近胜利的
  const others = room.players.filter(p => p.id !== attackerId);
  if (others.length === 0) return null;
  others.sort((a, b) => (b.agenda + b.R * 0.2) - (a.agenda + a.R * 0.2));
  return others[0];
}

function applyShadow(room, playerId, skillKey) {
  if (!room.started || room.phase !== "shadow") return { ok: false, err: "不在暗线阶段" };
  if (!room.shadowQueue || room.shadowQueue.length === 0) return { ok: false, err: "暗线队列异常" };

  const nextId = room.shadowQueue[0];
  if (nextId !== playerId) return { ok: false, err: "还没轮到你发动暗线" };

  const p = getPlayer(room, playerId);
  if (!p) return { ok: false, err: "玩家不存在" };

  if (skillKey === "skip") {
    room.log.push(`🌑 ${p.name} 选择不发动暗线技能。`);
    room.shadowQueue.shift();
  } else {
    if (p.usedSecret) return { ok: false, err: "你本局已经用过暗线技能" };
    if (p.role === "普通政客") return { ok: false, err: "你没有可用暗线技能" };

    // 强人技能实现
    if (p.role === "民粹强人" && skillKey === "populist_overdrive") {
      // 让自己下一次行动翻倍：用一个标记
      p.usedSecret = true;
      p.overdrive = true;
      p.exposure = clamp(p.exposure + 2, 0, 10);
      room.log.push(`🔥 ${p.name} 发动「夺取议程」：下次行动效果翻倍，但暴露度+2。`);
      room.shadowQueue.shift();
    } else if (p.role === "独裁强人" && skillKey === "autocrat_freeze") {
      p.usedSecret = true;
      // 冻结对手C增益：给全局一个标记，持续到下一回合结束
      room.freezeCFor = room.players.find(x => x.id !== p.id)?.id || null;
      p.exposure = clamp(p.exposure + 1, 0, 10);
      room.log.push(`🧊 ${p.name} 发动「冻结机构」：对手下回合C增益无效，暴露度+1。`);
      room.shadowQueue.shift();
    } else {
      return { ok: false, err: "暗线参数不匹配" };
    }
  }

  // 暗线阶段结束
  if (room.shadowQueue.length === 0) {
    // 清算冻结标记的生命周期在行动应用中处理（这里简单：下一回合开始仍有效，直到该玩家行动时消耗）
    // 直接推进下一回合
    if (checkCrisisAndWin(room)) {
      broadcastState(room);
      return { ok: true };
    }
    finishShadowAndAdvance(room);
  } else {
    // 轮到下一个暗线玩家
    broadcastState(room);
    maybeRunAI(room);
  }
  return { ok: true };
}

/** -----------------------------
 *  Overdrive / Freeze hooks
 * ------------------------------ */
function maybeApplySpecialHooks(room, player, actionKey) {
  // 行动前的特殊：独裁冻结
  if (room.freezeCFor && room.freezeCFor === player.id) {
    // 该玩家本次行动若会提高C，则取消C增益
    // 我们用一个标记在 applyAction 内部做差异处理太麻烦，这里用简化方式：
    // 若 actionKey 可能加C，则事后减回去。
    player.frozenThisAction = true;
    // 消耗冻结（只影响一次行动）
    room.freezeCFor = null;
  }
}

function postAdjustAfterAction(room, player, actionKey, beforeC) {
  if (player.frozenThisAction) {
    const deltaC = room.C - beforeC;
    if (deltaC > 0) {
      room.C = clamp(room.C - deltaC, 0, 10);
      room.log.push(`🧊 冻结生效：${player.name} 的控制力增益被抵消。`);
    }
    player.frozenThisAction = false;
  }
}

// 为了让 hook 生效，我们在 applyAction 里轻度改造：记录 beforeC，检查 overdrive
const _applyActionOriginal = applyAction;
applyAction = function(room, playerId, actionKey, payload = {}) {
  if (!room.started || room.phase !== "action") return { ok: false, err: "不在行动阶段" };
  if (!isPlayersTurn(room, playerId)) return { ok: false, err: "还没轮到你" };

  const p = getPlayer(room, playerId);
  if (!p) return { ok: false, err: "玩家不存在" };

  // hooks before
  const beforeC = room.C;
  maybeApplySpecialHooks(room, p, actionKey);

  // overdrive: 民粹强人下一次行动翻倍（简单实现：执行两次同一行动，但第二次不再扣费）
  const isOverdrive = !!p.overdrive;
  if (isOverdrive) p.overdrive = false;

  // 执行一次正常行动
  const res1 = _applyActionOriginal(room, playerId, actionKey, payload);
  if (!res1.ok) return res1;

  // overdrive 的第二次效果：只重复效果，不重复扣R、不重复换人/阶段
  if (isOverdrive && room.phase !== "end") {
    // 还原“换人/阶段推进”会非常麻烦，所以我们把翻倍实现为“补一次同等增益到关键轨道”
    // 也就是：根据行动类型再加一次主要效果（不触发再次nextTurn）
    const p2 = getPlayer(room, playerId);
    if (p2) {
      room.log.push(`🔥 夺取议程加成：${p2.name} 的行动效果被放大。`);
      if (actionKey === "mobilize_unify") room.L = clamp(room.L + 1, 0, 10);
      if (actionKey === "mobilize_divide") room.C = clamp(room.C + 1, 0, 10);
      if (actionKey === "infiltrate") room.C = clamp(room.C + 2, 0, 10);
      if (actionKey === "agenda") p2.agenda += 1;
      if (actionKey === "foreign_ops") room.E = clamp(room.E + 2, 0, 10);
      if (actionKey === "investigate") {
        const t = pickThreat(room, playerId);
        if (t) t.exposure = clamp(t.exposure + 1, 0, 10);
      }
      if (actionKey === "trade") p2.R = clamp(p2.R + 1, 0, 10);
    }
    // 强力可能触发胜利
    if (checkCrisisAndWin(room)) {
      broadcastState(room);
      return { ok: true };
    }
    broadcastState(room);
  }

  // hooks after（冻结抵消）
  postAdjustAfterAction(room, p, actionKey, beforeC);
  return { ok: true };
};

/** -----------------------------
 *  AI logic
 * ------------------------------ */
function aiChooseAction(room, aiPlayer) {
  // 简单启发式：按阵营目标拉轨道/推议程
  // 同时如果资源够就 agenda，否则做阵营倾向的行动
  const can = (key) => {
    const act = ACTIONS.find(a => a.key === key);
    if (!act) return false;
    let cost = act.costR;
    if (key === "infiltrate" && aiPlayer.faction === "前政党") cost = Math.max(0, cost - 1);
    return aiPlayer.R >= cost;
  };

  // 终局冲刺
  if (aiPlayer.faction === "境外势力") {
    if (room.E >= 7 && can("foreign_ops")) return "foreign_ops";
    if (can("agenda")) return "agenda";
    if (can("foreign_ops")) return "foreign_ops";
  }
  if (aiPlayer.faction === "民主党派") {
    if (room.L <= 6 && can("agenda")) return "agenda"; // 议程带L
    if (can("mobilize_unify")) return "mobilize_unify";
    if (can("investigate") && room.L <= 5) return "investigate";
  }
  if (aiPlayer.faction === "建制派") {
    if (room.P <= 5 && can("agenda")) return "agenda";
    if (can("mobilize_unify")) return "mobilize_unify";
    if (can("trade")) return "trade";
  }
  if (aiPlayer.faction === "民粹党") {
    if (room.C <= 7 && can("mobilize_divide")) return "mobilize_divide";
    if (can("agenda")) return "agenda";
    if (can("infiltrate")) return "infiltrate";
  }
  if (aiPlayer.faction === "前政党") {
    if (can("infiltrate")) return "infiltrate";
    if (can("agenda")) return "agenda";
    if (can("trade")) return "trade";
  }

  // 通用：能推议程就推
  if (can("agenda")) return "agenda";
  // 否则找最便宜的
  const cheap = ["mobilize_unify", "mobilize_divide", "investigate", "foreign_ops", "trade"].find(can);
  return cheap || "trade";
}

function aiMaybeUseShadow(room, aiPlayer) {
  if (aiPlayer.usedSecret) return "skip";
  if (aiPlayer.role === "民粹强人") {
    // 如果快接近赢或资源充足，就开
    if (aiPlayer.R >= 2 || aiPlayer.agenda >= 3) return "populist_overdrive";
  }
  if (aiPlayer.role === "独裁强人") {
    // 如果对手控制力高或快冲刺就开
    if (room.C >= 7) return "autocrat_freeze";
  }
  return "skip";
}

function maybeRunAI(room) {
  if (!room.started || room.phase === "end") return;

  // 行动阶段：如果轮到 AI，自动走
  if (room.phase === "action") {
    const current = room.players[room.currentPlayerIdx];
    if (current && current.kind === "ai") {
      const a = aiChooseAction(room, current);
      // 轻微延迟感更像“在线”
      setTimeout(() => {
        applyAction(room, current.id, a);
      }, 400);
    }
  }

  // 暗线阶段：如果轮到 AI 暗线，自动走
  if (room.phase === "shadow" && room.shadowQueue && room.shadowQueue.length > 0) {
    const nextId = room.shadowQueue[0];
    const p = getPlayer(room, nextId);
    if (p && p.kind === "ai") {
      const s = aiMaybeUseShadow(room, p);
      setTimeout(() => {
        applyShadow(room, p.id, s);
      }, 400);
    }
  }
}

/** -----------------------------
 *  WebSocket protocol
 * ------------------------------ */
wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }

    const type = data.type;
    const roomId = data.roomId;

    if (type === "join") {
      const room = getRoom(roomId);
      const name = (data.name || "玩家").slice(0, 20);

      const pid = addHuman(room, ws, name);
      ws._roomId = roomId;
      ws._playerId = pid;

      room.log.push(`👤 ${name} 加入房间。`);

      safeSend(ws, { type: "joined", playerId: pid, state: publicState(room) });
      safeSend(ws, { type: "private", state: privateState(room, pid) });

      broadcastState(room);
      return;
    }

    if (type === "add_ai") {
      const room = getRoom(roomId);
      if (room.started) return;
      const n = clamp(Number(data.count || 1), 1, 6);
      for (let i = 0; i < n; i++) addAI(room, `AI_${room.players.length + 1}`);
      room.log.push(`🤖 添加 AI x${n}`);
      broadcastState(room);
      return;
    }

    if (type === "start") {
      const room = getRoom(roomId);
      startGame(room);
      return;
    }

    if (type === "action") {
      const room = getRoom(roomId);
      const pid = ws._playerId;
      const res = applyAction(room, pid, data.actionKey, data.payload || {});
      if (!res.ok) safeSend(ws, { type: "error", message: res.err });
      return;
    }

    if (type === "shadow") {
      const room = getRoom(roomId);
      const pid = ws._playerId;
      const res = applyShadow(room, pid, data.skillKey);
      if (!res.ok) safeSend(ws, { type: "error", message: res.err });
      return;
    }

    if (type === "chat") {
      const room = getRoom(roomId);
      const pid = ws._playerId;
      const p = getPlayer(room, pid);
      if (!p) return;
      const text = String(data.text || "").slice(0, 200);
      room.log.push(`💬 ${p.name}: ${text}`);
      broadcastState(room);
      return;
    }

    if (type === "ping_state") {
      const room = getRoom(roomId);
      safeSend(ws, { type: "state", state: publicState(room) });
      safeSend(ws, { type: "private", state: privateState(room, ws._playerId) });
      return;
    }
  });

  ws.on("close", () => {
    const roomId = ws._roomId;
    const pid = ws._playerId;
    if (!roomId || !pid) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const idx = room.players.findIndex(p => p.id === pid);
    if (idx >= 0) {
      const name = room.players[idx].name;
      room.players.splice(idx, 1);
      room.log.push(`👋 ${name} 断开连接。`);
      // 若房间空了，清理
      if (room.players.length === 0) rooms.delete(roomId);
      else broadcastState(room);
    }
  });
});

console.log("✅ 空壳之国服务器已启动：ws://localhost:3000");
