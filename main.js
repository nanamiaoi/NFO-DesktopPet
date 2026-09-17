const { app, BrowserWindow, screen, ipcMain, Menu } = require('electron');
const path = require('path');
const {
  listCharacters,
  parseCharacterArg,
  loadSettings,
  saveSettings,
  getCharacterScale,
} = require('./characters');

/** @typedef {{
 *  id: string,
 *  character: string,
 *  window: Electron.BrowserWindow | null,
 *  behavior: string,
 *  facing: string,
 *  targetX: number,
 *  targetY: number,
 *  velX: number,
 *  velY: number,
 *  hardThrow: boolean,
 *  tickTimer: NodeJS.Timeout | null,
 *  actionTimer: NodeJS.Timeout | null,
 *  followTargetId: string | null,
 *  followUntil: number,
 *  meetCooldownUntil: number,
 *  trail: { x: number, y: number }[],
 *  actionMode: 'free' | 'mouse' | 'dnd',
 *  followMoving?: boolean,
 *  dragChainTimer?: NodeJS.Timeout | null,
 *  rescueTimer?: NodeJS.Timeout | null,
 *  _rescuerId?: string | null,
 *  _rescueSide?: 'left' | 'right',
 * }} Pet */

/** @type {Map<string, Pet>} */
const pets = new Map();
let nextPetId = 1;
let pickerWindow = null;
let sizeWindow = null;
let displayScale = 1;
let meetTimer = null;

const BASE_WIN_W = 130;
const BASE_WIN_H = 130;
const STEP_WALK = 2.6;
const STEP_FOLLOW = 3.2;
const FRICTION = 0.9;
const THROW_SLIDE_MIN = 8;
const THROW_HARD = 28;
const DEAD_FRAME_MS = 140;
const DEAD_FRAMES = 4;
const FALL_MS = DEAD_FRAME_MS * DEAD_FRAMES;
const GETUP_MS = DEAD_FRAME_MS * DEAD_FRAMES;
const LIE_MS = 700;
const FOLLOW_MS = 5 * 60 * 1000;
const MEET_DIST = 100;
/** 中途被打断后的短冷却 */
const MEET_COOLDOWN_MS = 20 * 1000;
/** 5 分钟正常散队后的冷却：双方都不能立刻再结伴 */
const MEET_COOLDOWN_AFTER_FOLLOW_MS = 90 * 1000;
/** 排队间距（沿前一位走过的路径回退） */
const FOLLOW_GAP = 64;
const TRAIL_MAX = 120;
const TRAIL_SAMPLE = 3;
const STEP_MOUSE = 3.8;
const MOUSE_STOP_DIST = 14;
/** 拖拽时身后链环间距（略大于排队，方便看出下垂） */
const HANG_GAP = 66;
/** 链子重力（px / frame²，约 60fps）——越大越沉、越不飘 */
const HANG_GRAVITY = 0.95;
/** 空气阻尼：越接近 1 摆得越久；略低可更快停稳 */
const HANG_DAMPING = 0.952;
/** 距离约束迭代次数（越多绳越硬） */
const HANG_CONSTRAINT_ITERS = 6;
/** 积分帧把约束位移部分写回 old，吃掉多余弹性，避免越甩越飘 */
const HANG_CONSTRAINT_BLEED = 0.35;
/** 抓住后多久开始第一次救援 */
const RESCUE_FIRST_DELAY_MS = 700;
/** 两次救援尝试间隔 */
const RESCUE_NEXT_DELAY_MS = 450;
/** 面对面挣扎时长 */
const RESCUE_STRUGGLE_MS = 900;
/** 救援贴近间距（面对面） */
const RESCUE_FACE_GAP = 58;
const STEP_RESCUE = 4.2;

function getEffectiveScale(character) {
  return displayScale * getCharacterScale(character);
}

function getWinSizeFor(characterOrPet) {
  const character =
    typeof characterOrPet === 'string' ? characterOrPet : characterOrPet.character;
  const scale = getEffectiveScale(character);
  return {
    w: Math.round(BASE_WIN_W * scale),
    h: Math.round(BASE_WIN_H * scale),
  };
}

function getBoundsFor(characterOrPet) {
  const area = screen.getPrimaryDisplay().workArea;
  const { w, h } = getWinSizeFor(characterOrPet);
  return {
    minX: area.x,
    minY: area.y,
    maxX: area.x + area.width - w,
    maxY: area.y + area.height - h,
  };
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function alivePets() {
  return [...pets.values()].filter((p) => p.window && !p.window.isDestroyed());
}

function getPetByWebContents(wc) {
  for (const pet of pets.values()) {
    if (pet.window && !pet.window.isDestroyed() && pet.window.webContents.id === wc.id) {
      return pet;
    }
  }
  return null;
}

function clearPetTimers(pet) {
  if (pet.tickTimer) {
    clearTimeout(pet.tickTimer);
    pet.tickTimer = null;
  }
  if (pet.actionTimer) {
    clearTimeout(pet.actionTimer);
    pet.actionTimer = null;
  }
  if (pet.dragChainTimer) {
    clearTimeout(pet.dragChainTimer);
    pet.dragChainTimer = null;
  }
}

function schedulePet(pet, fn, ms) {
  clearPetTimers(pet);
  pet.actionTimer = setTimeout(fn, ms);
}

function sendState(pet, extra = {}) {
  if (!pet.window || pet.window.isDestroyed()) return;
  let anim = 'idle';
  let pace = 'normal';

  if (pet.behavior === 'stun' || pet.behavior === 'faint') anim = 'dead';
  else if (pet.behavior === 'getup') anim = 'getup';
  else if (pet.behavior === 'drag' || pet.behavior === 'rescue') {
    anim = 'run';
    pace = 'fast';
  } else if (pet.behavior === 'follow') {
    // 跟随停住时必须是 idle；不能因为 behavior=follow 就一直发 run（否则会和 idle 狂切、动画从头播）
    anim = pet.followMoving ? 'run' : 'idle';
    pace = pet.followMoving ? 'fast' : 'normal';
  } else if (pet.behavior === 'walk' || pet.behavior === 'slide') {
    anim = 'run';
  }

  pet.window.webContents.send('pet-state', {
    behavior: pet.behavior,
    anim,
    pace,
    facing: pet.facing,
    ...extra,
  });
}

function setPos(pet, x, y) {
  if (!pet.window || pet.window.isDestroyed()) return;
  const b = getBoundsFor(pet);
  const nx = clamp(Math.round(x), b.minX, b.maxX);
  const ny = clamp(Math.round(y), b.minY, b.maxY);
  pet.window.setPosition(nx, ny);
  recordTrail(pet, nx, ny);
}

/** 记录走过的路点，供后面的队员沿路径跟随（避免按面向左右跳导致二人转） */
function recordTrail(pet, x, y) {
  if (!pet.trail) pet.trail = [];
  const last = pet.trail[pet.trail.length - 1];
  if (last && Math.hypot(x - last.x, y - last.y) < TRAIL_SAMPLE) return;
  pet.trail.push({ x, y });
  while (pet.trail.length > TRAIL_MAX) pet.trail.shift();
}

function seedTrail(pet) {
  if (!pet.window || pet.window.isDestroyed()) return;
  const [x, y] = pet.window.getPosition();
  if (!pet.trail) pet.trail = [];
  if (pet.trail.length === 0) {
    // 预填一段「身后」路点，新人一加入就能落到队尾而不是贴脸绕圈
    const back = pet.facing === 'left' ? 1 : -1;
    for (let i = 4; i >= 0; i--) {
      pet.trail.push({ x: x + back * i * (FOLLOW_GAP / 4), y });
    }
  } else {
    recordTrail(pet, x, y);
  }
}

function updateFacing(pet, dx) {
  // 跟随/拖拽链加大死区，避免落点微调导致左右狂转
  const deadzone =
    pet.behavior === 'follow' || pet.behavior === 'drag' || pet.behavior === 'rescue'
      ? 1.5
      : 0.2;
  const next = dx < -deadzone ? 'left' : dx > deadzone ? 'right' : pet.facing;
  if (next !== pet.facing) {
    pet.facing = next;
    // 跟随与拖拽链由各自循环推送状态
    if (pet.behavior !== 'follow' && pet.behavior !== 'drag') sendState(pet);
  }
}

function moveToward(pet, tx, ty, step) {
  if (!pet.window || pet.window.isDestroyed()) return true;
  const [x, y] = pet.window.getPosition();
  const dx = tx - x;
  const dy = ty - y;
  const dist = Math.hypot(dx, dy);
  if (dist <= step) {
    setPos(pet, tx, ty);
    return true;
  }
  updateFacing(pet, dx);
  setPos(pet, x + (dx / dist) * step, y + (dy / dist) * step);
  return false;
}

function petCenter(pet) {
  const { w, h } = getWinSizeFor(pet);
  const [x, y] = pet.window.getPosition();
  return { x: x + w / 2, y: y + h / 2 };
}

function pickWanderTarget(pet, scale = 1) {
  const b = getBoundsFor(pet);
  const [cx, cy] = pet.window.getPosition();
  const rangeX = (160 + Math.random() * 260) * scale;
  const rangeY = (50 + Math.random() * 110) * scale;
  pet.targetX = clamp(cx + (Math.random() - 0.5) * 2 * rangeX, b.minX, b.maxX);
  pet.targetY = clamp(cy + (Math.random() - 0.5) * 2 * rangeY, b.minY, b.maxY);
}

function isMeetBlocked(pet) {
  // 跑去救援途中用 walk，也要挡相遇并队
  if (pet._rescueSide) return true;
  return ['drag', 'slide', 'stun', 'faint', 'getup', 'rescue'].includes(pet.behavior);
}

/** 是否可参与相遇 / 并队（冷却中或异常状态则否） */
function canMeetParticipant(pet) {
  if (!pet.window || pet.window.isDestroyed()) return false;
  if (pet.actionMode === 'dnd') return false;
  if (Date.now() < pet.meetCooldownUntil) return false;
  if (isMeetBlocked(pet)) return false;
  return true;
}

/** 勿扰：选最近角落，已有人占用则沿边错开 */
function pickDndCorner(pet) {
  const b = getBoundsFor(pet);
  const corners = [
    { x: b.minX, y: b.maxY }, // 左下
    { x: b.maxX, y: b.maxY }, // 右下
    { x: b.minX, y: b.minY }, // 左上
    { x: b.maxX, y: b.minY }, // 右上
  ];
  const [cx, cy] = pet.window.getPosition();
  let best = corners[0];
  let bestD = Infinity;
  for (const c of corners) {
    const d = Math.hypot(c.x - cx, c.y - cy);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }

  const { w, h } = getWinSizeFor(pet);
  const gap = Math.max(w, h) * 0.72;
  const inwardX = best.x <= b.minX + 2 ? 1 : -1;
  const inwardY = best.y <= b.minY + 2 ? 1 : -1;
  // 优先沿底边/顶边横排，少挡中间工作区
  let slot = 0;
  for (const other of alivePets()) {
    if (other.id === pet.id || other.actionMode !== 'dnd') continue;
    if (!other.window || other.window.isDestroyed()) continue;
    const [ox, oy] = other.window.getPosition();
    if (Math.hypot(ox - best.x, oy - best.y) < gap * 2.2) slot += 1;
  }
  return {
    x: clamp(best.x + inwardX * slot * gap, b.minX, b.maxX),
    y: clamp(best.y + inwardY * Math.floor(slot / 4) * gap * 0.35, b.minY, b.maxY),
  };
}

function settleDnd(pet) {
  if (!pet.window || pet.window.isDestroyed() || pet.actionMode !== 'dnd') return;
  clearPetTimers(pet);
  pet.behavior = 'idle';
  pet.velX = 0;
  pet.velY = 0;
  sendState(pet);
}

function beginDnd(pet) {
  if (!pet.window || pet.window.isDestroyed()) return;
  clearPetTimers(pet);
  const corner = pickDndCorner(pet);
  pet.targetX = corner.x;
  pet.targetY = corner.y;
  const [x, y] = pet.window.getPosition();
  if (Math.hypot(corner.x - x, corner.y - y) < 6) {
    settleDnd(pet);
    return;
  }
  pet.behavior = 'walk';
  sendState(pet);
  tickMove(pet, STEP_WALK, () => settleDnd(pet));
}

function getChainRoot(pet) {
  let cur = pet;
  const seen = new Set();
  while (cur.followTargetId && !seen.has(cur.id)) {
    seen.add(cur.id);
    const next = pets.get(cur.followTargetId);
    if (!next || !next.window || next.window.isDestroyed()) break;
    cur = next;
  }
  return cur;
}

function getDirectFollower(pet) {
  for (const other of pets.values()) {
    if (other.followTargetId === pet.id && other.window && !other.window.isDestroyed()) {
      return other;
    }
  }
  return null;
}

/** 拖拽者身后整串队员（不含自己） */
function getPetsBehind(pet) {
  const list = [];
  let cur = getDirectFollower(pet);
  const seen = new Set([pet.id]);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    list.push(cur);
    cur = getDirectFollower(cur);
  }
  return list;
}

function hasFollower(pet) {
  return getDirectFollower(pet) !== null;
}

function chainSize(pet) {
  let n = 0;
  let cur = getChainRoot(pet);
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    n += 1;
    cur = getDirectFollower(cur);
  }
  return n;
}

/** 刷新某节点及其身后整串队员的跟随时长 */
function refreshFollowDuration(fromPet, until) {
  let cur = fromPet;
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.followTargetId) cur.followUntil = until;
    cur = getDirectFollower(cur);
  }
}

/** 若 follower 去跟 leader，是否会形成环 */
function wouldCreateFollowCycle(follower, leader) {
  let cur = leader;
  const seen = new Set();
  while (cur) {
    if (cur.id === follower.id) return true;
    if (seen.has(cur.id)) return true;
    seen.add(cur.id);
    if (!cur.followTargetId) return false;
    cur = pets.get(cur.followTargetId);
    if (!cur) return false;
  }
  return false;
}

function isFollowCycle(pet) {
  let cur = pet;
  const seen = new Set();
  while (cur && cur.followTargetId) {
    if (seen.has(cur.id)) return true;
    seen.add(cur.id);
    cur = pets.get(cur.followTargetId);
  }
  return false;
}

/** 从队伍中任一人出发，找到当前队尾 */
function getChainTail(pet) {
  let cur = getChainRoot(pet);
  const seen = new Set();
  while (true) {
    seen.add(cur.id);
    const fol = getDirectFollower(cur);
    if (!fol || seen.has(fol.id)) break;
    cur = fol;
  }
  return cur;
}

/** 带队领队若闲置且无定时器，重新带队走路（防止跟丢 AI） */
function nudgePartyLeaders() {
  for (const pet of alivePets()) {
    if (pet.followTargetId || !hasFollower(pet)) continue;
    if (pet.actionMode === 'mouse' || pet.actionMode === 'dnd') continue;
    if (isMeetBlocked(pet) || pet.behavior === 'drag' || pet.behavior === 'slide') continue;
    if (pet.behavior === 'walk' && pet.tickTimer) continue;
    if (pet.behavior === 'idle' && pet.actionTimer) continue;
    if (pet.behavior === 'idle' || !pet.tickTimer) {
      beginWalk(pet);
    }
  }
}

function startIdle(pet, delay) {
  if (pet.followTargetId) return;
  if (pet.actionMode === 'mouse') {
    // 从 drag/slide/getup 恢复时必须先清掉旧 behavior，
    // 否则 tickMouseFollow 会一直等到「非阻塞态」而永远不走
    pet.behavior = 'follow';
    pet.velX = 0;
    pet.velY = 0;
    pet.followMoving = false;
    pet._followAnim = null;
    pet._followFacing = null;
    tickMouseFollow(pet);
    return;
  }
  if (pet.actionMode === 'dnd') {
    beginDnd(pet);
    return;
  }
  pet.behavior = 'idle';
  pet.velX = 0;
  pet.velY = 0;
  sendState(pet);
  // 带队时只短停一下，避免整队长时间站桩
  const wait =
    delay ??
    (hasFollower(pet) ? 350 + Math.random() * 450 : 1800 + Math.random() * 4200);
  schedulePet(pet, () => {
    if (
      pet.behavior !== 'idle' ||
      pet.followTargetId ||
      pet.actionMode === 'mouse' ||
      pet.actionMode === 'dnd'
    ) {
      return;
    }
    pickNextAction(pet);
  }, wait);
}

function pickNextAction(pet) {
  if (pet.followTargetId || pet.actionMode === 'mouse' || pet.actionMode === 'dnd') return;
  // 有人跟着时优先继续走，不长时间发呆 / 晕倒
  if (hasFollower(pet)) {
    beginWalk(pet);
    return;
  }
  const roll = Math.random();
  if (roll < 0.28) {
    startIdle(pet, 5000 + Math.random() * 5000);
    return;
  }
  if (roll < 0.42) {
    beginFaint(pet);
    return;
  }
  beginWalk(pet);
}

function beginWalk(pet) {
  if (pet.followTargetId || pet.actionMode === 'mouse' || pet.actionMode === 'dnd') return;
  pet.behavior = 'walk';
  pickWanderTarget(pet, 1);
  sendState(pet);
  tickMove(pet, STEP_WALK, () => startIdle(pet));
}

function beginDownSequence(pet, kind) {
  if (pet.followTargetId) clearFollow(pet, false);
  pet.behavior = kind;
  sendState(pet);
  schedulePet(pet, () => {
    if (pet.behavior !== kind) return;
    pet.behavior = 'getup';
    sendState(pet);
    schedulePet(pet, () => {
      if (pet.behavior !== 'getup') return;
      startIdle(pet, 800 + Math.random() * 1200);
    }, GETUP_MS);
  }, FALL_MS + LIE_MS);
}

function beginFaint(pet) {
  beginDownSequence(pet, 'faint');
}

function beginStun(pet) {
  beginDownSequence(pet, 'stun');
}

function tickMove(pet, step, onDone) {
  clearPetTimers(pet);
  const stepOnce = () => {
    if (!pet.window || pet.window.isDestroyed() || pet.behavior !== 'walk' || pet.followTargetId) {
      return;
    }
    const arrived = moveToward(pet, pet.targetX, pet.targetY, step);
    if (arrived) {
      onDone();
      return;
    }
    pet.tickTimer = setTimeout(stepOnce, 16);
  };
  stepOnce();
}

function beginSlide(pet, vx, vy, hard) {
  if (pet.followTargetId) clearFollow(pet, false);
  pet.behavior = 'slide';
  pet.hardThrow = hard;
  pet.velX = vx;
  pet.velY = vy;
  sendState(pet);
  clearPetTimers(pet);

  const slideOnce = () => {
    if (!pet.window || pet.window.isDestroyed() || pet.behavior !== 'slide') return;
    const b = getBoundsFor(pet);
    let [x, y] = pet.window.getPosition();
    x += pet.velX;
    y += pet.velY;

    if (x <= b.minX || x >= b.maxX) {
      pet.velX *= -0.55;
      x = clamp(x, b.minX, b.maxX);
    }
    if (y <= b.minY || y >= b.maxY) {
      pet.velY *= -0.55;
      y = clamp(y, b.minY, b.maxY);
    }

    updateFacing(pet, pet.velX);
    setPos(pet, x, y);
    pet.velX *= FRICTION;
    pet.velY *= FRICTION;

    if (Math.hypot(pet.velX, pet.velY) < 0.85) {
      if (pet.hardThrow) beginStun(pet);
      else startIdle(pet, 600 + Math.random() * 1000);
      return;
    }
    pet.tickTimer = setTimeout(slideOnce, 16);
  };
  slideOnce();
}

function applyMeetCooldown(pet, ms) {
  if (!pet) return;
  pet.meetCooldownUntil = Math.max(pet.meetCooldownUntil || 0, Date.now() + ms);
}

/** 给某人所在整支队伍都加上冷却，避免散队后贴着又立刻重聚 */
function applyMeetCooldownToChain(pet, ms) {
  if (!pet) return;
  let cur = getChainRoot(pet);
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    applyMeetCooldown(cur, ms);
    cur = getDirectFollower(cur);
  }
}

function clearFollow(pet, resumeIdle = true, { naturalEnd = false } = {}) {
  const formerId = pet.followTargetId;
  const former = formerId ? pets.get(formerId) : null;
  const cooldownMs = naturalEnd ? MEET_COOLDOWN_AFTER_FOLLOW_MS : MEET_COOLDOWN_MS;

  pet.followTargetId = null;
  pet.followUntil = 0;
  pet.followMoving = false;
  clearPetTimers(pet);

  if (resumeIdle && pet.window && !pet.window.isDestroyed()) {
    applyMeetCooldown(pet, cooldownMs);
    if (former) applyMeetCooldownToChain(former, cooldownMs);
    applyMeetCooldownToChain(pet, cooldownMs);

    if (naturalEnd) {
      disperseAfterFollow(pet, formerId);
      // 原前一位若不再带队、也没在跟随，也往反方向走开
      if (
        former &&
        former.window &&
        !former.window.isDestroyed() &&
        !former.followTargetId &&
        !hasFollower(former) &&
        !isMeetBlocked(former) &&
        former.behavior !== 'drag' &&
        former.behavior !== 'slide'
      ) {
        disperseAfterFollow(former, pet.id);
      }
    } else {
      startIdle(pet, 600 + Math.random() * 1200);
    }
  }
}

/** 散队后先走开一段，降低仍在 MEET_DIST 内立刻重聚的概率 */
function disperseAfterFollow(pet, otherId) {
  if (!pet.window || pet.window.isDestroyed()) return;
  if (pet.followTargetId) return;

  const b = getBoundsFor(pet);
  const [x, y] = pet.window.getPosition();
  let awayX = (Math.random() < 0.5 ? -1 : 1) * (240 + Math.random() * 200);
  let awayY = (Math.random() - 0.5) * 140;

  if (otherId) {
    const other = pets.get(otherId);
    if (other && other.window && !other.window.isDestroyed()) {
      const [ox, oy] = other.window.getPosition();
      const dx = x - ox;
      const dy = y - oy;
      const len = Math.hypot(dx, dy);
      if (len > 1) {
        awayX = (dx / len) * (240 + Math.random() * 200);
        awayY = (dy / len) * (70 + Math.random() * 90);
      }
    }
  }

  pet.behavior = 'walk';
  pet.targetX = clamp(x + awayX, b.minX, b.maxX);
  pet.targetY = clamp(y + awayY, b.minY, b.maxY);
  sendState(pet);
  tickMove(pet, STEP_WALK, () => startIdle(pet, 900 + Math.random() * 1500));
}

function beginFollow(follower, leader) {
  if (!leader || wouldCreateFollowCycle(follower, leader)) return;
  // 跟随鼠标 / 勿扰不当队员
  if (follower.actionMode === 'mouse' || follower.actionMode === 'dnd') return;
  clearPetTimers(follower);
  seedTrail(leader);
  const until = Date.now() + FOLLOW_MS;
  follower.followTargetId = leader.id;
  follower.followUntil = until;
  follower.followMoving = false;
  follower._followAnim = null;
  follower._followFacing = null;
  follower.behavior = 'follow';
  sendState(follower);
  // 并队时身后队员一起续时，避免半截队伍先散开
  refreshFollowDuration(follower, until);
  tickFollow(follower);

  // 结伴后立刻让队头动起来，避免两人原地发呆
  const root = getChainRoot(leader);
  if (root.actionMode === 'mouse' || root.actionMode === 'dnd') return;
  if (root.window && !root.window.isDestroyed() && (root.behavior === 'idle' || !root.tickTimer)) {
    if (root.behavior === 'idle' || root.behavior === 'walk') {
      beginWalk(root);
    }
  }
}

function setActionMode(pet, mode) {
  if (!pet || (mode !== 'free' && mode !== 'mouse' && mode !== 'dnd')) return;
  if (pet.actionMode === mode) {
    if (mode === 'mouse') tickMouseFollow(pet);
    else if (mode === 'dnd') beginDnd(pet);
    return;
  }

  if (pet.followTargetId) clearFollow(pet, false);
  // 勿扰时拆队，只让自己去角落
  if (mode === 'dnd') {
    for (const other of alivePets()) {
      if (other.followTargetId === pet.id) clearFollow(other, true);
    }
  }

  pet.actionMode = mode;
  clearPetTimers(pet);
  pet.followMoving = false;
  pet._followAnim = null;
  pet._followFacing = null;

  if (mode === 'mouse') {
    pet.behavior = 'follow';
    sendState(pet);
    tickMouseFollow(pet);
  } else if (mode === 'dnd') {
    beginDnd(pet);
  } else {
    startIdle(pet, 400);
  }
}

function tickMouseFollow(pet) {
  clearPetTimers(pet);
  const stepOnce = () => {
    if (!pet.window || pet.window.isDestroyed()) return;
    if (pet.actionMode !== 'mouse') return;

    // 拖拽 / 滑行 / 倒地 / 救援由各自流程 clearPetTimers 打断；结束后会重新 startIdle
    if (['drag', 'slide', 'stun', 'faint', 'getup', 'rescue'].includes(pet.behavior)) {
      return;
    }

    const { w, h } = getWinSizeFor(pet);
    const cursor = screen.getCursorScreenPoint();
    const b = getBoundsFor(pet);
    const tx = clamp(cursor.x - w / 2, b.minX, b.maxX);
    const ty = clamp(cursor.y - h / 2, b.minY, b.maxY);
    const [fx, fy] = pet.window.getPosition();
    const dist = Math.hypot(tx - fx, ty - fy);

    if (pet.followMoving) {
      if (dist < MOUSE_STOP_DIST) pet.followMoving = false;
    } else if (dist > MOUSE_STOP_DIST + 16) {
      pet.followMoving = true;
    }

    pet.behavior = 'follow';
    if (pet.followMoving) {
      moveToward(pet, tx, ty, STEP_MOUSE);
    }

    const anim = pet.followMoving ? 'run' : 'idle';
    const pace = pet.followMoving ? 'fast' : 'normal';
    if (pet._followAnim !== anim || pet._followFacing !== pet.facing) {
      pet._followAnim = anim;
      pet._followFacing = pet.facing;
      if (pet.window && !pet.window.isDestroyed()) {
        pet.window.webContents.send('pet-state', {
          behavior: 'follow',
          anim,
          pace,
          facing: pet.facing,
        });
      }
    }

    pet.tickTimer = setTimeout(stepOnce, 16);
  };
  stepOnce();
}

/**
 * 在前一位的历史路径上，回退约 FOLLOW_GAP 的落点。
 * 像贪吃蛇一样跟着走，不依赖面向，转身不会把目标甩到对面。
 */
function followTrailTarget(leader) {
  const [lx, ly] = leader.window.getPosition();
  const b = getBoundsFor(leader);
  const trail = leader.trail || [];

  let remaining = FOLLOW_GAP;
  let px = lx;
  let py = ly;

  for (let i = trail.length - 1; i >= 0; i--) {
    const p = trail[i];
    const seg = Math.hypot(px - p.x, py - p.y);
    if (seg < 0.1) continue;
    if (seg >= remaining) {
      const t = remaining / seg;
      return {
        x: clamp(px + (p.x - px) * t, b.minX, b.maxX),
        y: clamp(py + (p.y - py) * t, b.minY, b.maxY),
      };
    }
    remaining -= seg;
    px = p.x;
    py = p.y;
  }

  if (trail.length > 0) {
    const oldest = trail[0];
    return {
      x: clamp(oldest.x, b.minX, b.maxX),
      y: clamp(oldest.y, b.minY, b.maxY),
    };
  }
  const behindX = leader.facing === 'left' ? lx + FOLLOW_GAP : lx - FOLLOW_GAP;
  return {
    x: clamp(behindX, b.minX, b.maxX),
    y: clamp(ly, b.minY, b.maxY),
  };
}

function tickFollow(pet) {
  clearPetTimers(pet);
  const stepOnce = () => {
    if (!pet.window || pet.window.isDestroyed()) return;
    if (!pet.followTargetId || Date.now() >= pet.followUntil) {
      const naturalEnd = !!(pet.followTargetId && Date.now() >= pet.followUntil);
      clearFollow(pet, true, { naturalEnd });
      return;
    }

    if (isFollowCycle(pet)) {
      clearFollow(pet, true);
      return;
    }

    const leader = pets.get(pet.followTargetId);
    if (!leader || !leader.window || leader.window.isDestroyed()) {
      clearFollow(pet, true);
      return;
    }

    // 前一位也可能在 idle，补采样当前点，路径不断档
    seedTrail(leader);

    pet.behavior = 'follow';
    const slot = followTrailTarget(leader);
    const [fx, fy] = pet.window.getPosition();
    const dist = Math.hypot(slot.x - fx, slot.y - fy);

    // 滞回：避免在落点附近 run/idle 来回切导致帧动画不断重头播放
    if (pet.followMoving) {
      if (dist < 4) pet.followMoving = false;
    } else if (dist > 18) {
      pet.followMoving = true;
    }

    if (pet.followMoving) {
      moveToward(pet, slot.x, slot.y, STEP_FOLLOW);
    } else if (pet.facing !== leader.facing) {
      // 到位后才对齐面向，且只在变化时推送（见下方）
      pet.facing = leader.facing;
    }

    const anim = pet.followMoving ? 'run' : 'idle';
    const pace = pet.followMoving ? 'fast' : 'normal';
    if (pet._followAnim !== anim || pet._followFacing !== pet.facing) {
      pet._followAnim = anim;
      pet._followFacing = pet.facing;
      if (pet.window && !pet.window.isDestroyed()) {
        pet.window.webContents.send('pet-state', {
          behavior: 'follow',
          anim,
          pace,
          facing: pet.facing,
        });
      }
    }

    pet.tickTimer = setTimeout(stepOnce, 16);
  };
  stepOnce();
}

function checkMeetings() {
  nudgePartyLeaders();
  const list = alivePets();
  if (list.length < 2) return;

  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      if (!canMeetParticipant(a) || !canMeetParticipant(b)) continue;

      const ca = petCenter(a);
      const cb = petCenter(b);
      if (Math.hypot(ca.x - cb.x, ca.y - cb.y) > MEET_DIST) continue;

      const rootA = getChainRoot(a);
      const rootB = getChainRoot(b);
      // 已是同一队，忽略
      if (rootA.id === rootB.id) continue;

      // 较小队伍的队头接到较大队伍队尾（一样大则随机），实现单人入队或两队合并
      const sizeA = chainSize(rootA);
      const sizeB = chainSize(rootB);
      let joinerRoot;
      let hostPet;
      if (sizeA < sizeB) {
        joinerRoot = rootA;
        hostPet = b;
      } else if (sizeB < sizeA) {
        joinerRoot = rootB;
        hostPet = a;
      } else if (Math.random() < 0.5) {
        joinerRoot = rootA;
        hostPet = b;
      } else {
        joinerRoot = rootB;
        hostPet = a;
      }

      // 跟随鼠标 / 勿扰不当去并入别人的队员
      if (joinerRoot.actionMode === 'mouse' || joinerRoot.actionMode === 'dnd') {
        if (hostPet === b) {
          joinerRoot = rootB;
          hostPet = a;
        } else {
          joinerRoot = rootA;
          hostPet = b;
        }
        if (joinerRoot.actionMode === 'mouse' || joinerRoot.actionMode === 'dnd') continue;
      }

      const tail = getChainTail(hostPet);
      if (tail.id === joinerRoot.id) continue;
      if (wouldCreateFollowCycle(joinerRoot, tail)) continue;

      beginFollow(joinerRoot, tail);
      return;
    }
  }
}

function startMeetLoop() {
  if (meetTimer) return;
  meetTimer = setInterval(checkMeetings, 250);
}

function stopMeetLoopIfEmpty() {
  if (alivePets().length === 0 && meetTimer) {
    clearInterval(meetTimer);
    meetTimer = null;
  }
}

function destroyPet(pet, { animate = false } = {}) {
  cancelRescue(pet);
  clearPetTimers(pet);
  pet.followTargetId = null;
  for (const other of pets.values()) {
    if (other.followTargetId === pet.id) clearFollow(other, true);
  }

  const finish = () => {
    if (pet.window && !pet.window.isDestroyed()) {
      pet.window.removeAllListeners('closed');
      pet.window.close();
    }
    pets.delete(pet.id);
    stopMeetLoopIfEmpty();
    if (alivePets().length === 0 && !pickerWindow) app.quit();
  };

  if (animate && pet.window && !pet.window.isDestroyed()) {
    pet._closing = true;
    pet.window.webContents.send('pet-prepare-quit');
    return;
  }
  finish();
}

function closeAllPets() {
  for (const pet of [...pets.values()]) {
    clearPetTimers(pet);
    if (pet.window && !pet.window.isDestroyed()) {
      pet.window.removeAllListeners('closed');
      pet.window.destroy();
    }
    pets.delete(pet.id);
  }
  stopMeetLoopIfEmpty();
}

function applyDisplayScale(scale) {
  displayScale = clamp(Number(scale) || 1, 1, 2);
  saveSettings(app.getPath('userData'), { displayScale });

  for (const pet of alivePets()) {
    const { w, h } = getWinSizeFor(pet);
    const b = getBoundsFor(pet);
    const [x, y] = pet.window.getPosition();
    const [ow, oh] = pet.window.getSize();
    const cx = x + ow / 2;
    const cy = y + oh / 2;
    const nx = clamp(Math.round(cx - w / 2), b.minX, b.maxX);
    const ny = clamp(Math.round(cy - h / 2), b.minY, b.maxY);
    pet.window.setBounds({ x: nx, y: ny, width: w, height: h });
    pet.window.webContents.send('pet-scale-changed', {
      scale: getEffectiveScale(pet.character),
    });
  }
}

function showPetMenu(pet) {
  if (!pet.window || pet.window.isDestroyed()) return;

  const menu = Menu.buildFromTemplate([
    {
      label: '行动模式',
      submenu: [
        {
          label: '自由行动',
          type: 'radio',
          checked: pet.actionMode === 'free',
          click: () => setActionMode(pet, 'free'),
        },
        {
          label: '跟随鼠标',
          type: 'radio',
          checked: pet.actionMode === 'mouse',
          click: () => setActionMode(pet, 'mouse'),
        },
        {
          label: '勿扰',
          type: 'radio',
          checked: pet.actionMode === 'dnd',
          click: () => setActionMode(pet, 'dnd'),
        },
      ],
    },
    {
      label: '打开选角窗口',
      click: () => openSwitcherPicker(),
    },
    {
      label: '大小设置',
      click: () => openSizeWindow(),
    },
    { type: 'separator' },
    {
      label: '关闭此角色',
      click: () => destroyPet(pet, { animate: true }),
    },
    {
      label: '退出全部',
      click: () => {
        for (const p of alivePets()) {
          if (p.window && !p.window.isDestroyed()) {
            p.window.webContents.send('pet-prepare-quit');
          }
        }
        setTimeout(() => app.quit(), FALL_MS + 300);
      },
    },
  ]);

  menu.popup({ window: pet.window });
}

function openSizeWindow() {
  if (sizeWindow && !sizeWindow.isDestroyed()) {
    sizeWindow.focus();
    return;
  }
  sizeWindow = new BrowserWindow({
    width: 360,
    height: 180,
    resizable: false,
    maximizable: false,
    minimizable: false,
    title: '大小设置',
    autoHideMenuBar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  sizeWindow.loadFile('size.html');
  sizeWindow.on('closed', () => {
    sizeWindow = null;
  });
}

function openSwitcherPicker() {
  if (pickerWindow && !pickerWindow.isDestroyed()) {
    pickerWindow.focus();
    return;
  }
  pickerWindow = new BrowserWindow({
    width: 640,
    height: 560,
    resizable: false,
    maximizable: false,
    title: '选择桌宠角色（可多选）',
    autoHideMenuBar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  pickerWindow.loadFile('picker.html');
  pickerWindow.on('closed', () => {
    pickerWindow = null;
  });
}

function createPetWindow(character, index = 0, total = 1) {
  const id = String(nextPetId++);
  /** @type {Pet} */
  const pet = {
    id,
    character,
    window: null,
    behavior: 'idle',
    facing: 'right',
    targetX: 0,
    targetY: 0,
    velX: 0,
    velY: 0,
    hardThrow: false,
    tickTimer: null,
    actionTimer: null,
    followTargetId: null,
    followUntil: 0,
    meetCooldownUntil: 0,
    trail: [],
    actionMode: 'free',
  };

  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
  const { w, h } = getWinSizeFor(character);
  const spread = Math.min(total, 6);
  const col = index % spread;
  const row = Math.floor(index / spread);
  const x = Math.floor(screenW * 0.55 + col * (w + 24));
  const y = Math.floor(screenH * 0.55 + row * (h + 24));
  const b = getBoundsFor(character);

  pet.window = new BrowserWindow({
    width: w,
    height: h,
    x: clamp(x, b.minX, b.maxX),
    y: clamp(y, b.minY, b.maxY),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--pet-id=${id}`, `--pet-character=${character}`],
    },
  });

  pet.window.setAlwaysOnTop(true, 'screen-saver');
  pet.window.loadFile('index.html', { query: { petId: id, character } });

  pet.window.webContents.on('did-finish-load', () => {
    pet.window.webContents.send('pet-scale-changed', {
      scale: getEffectiveScale(character),
    });
    startIdle(pet, 800 + index * 200);
  });

  pet.window.on('closed', () => {
    cancelRescue(pet);
    clearPetTimers(pet);
    for (const other of pets.values()) {
      if (other.followTargetId === pet.id) clearFollow(other, true);
    }
    pets.delete(pet.id);
    stopMeetLoopIfEmpty();
    if (alivePets().length === 0 && !pickerWindow) app.quit();
  });

  pets.set(id, pet);
  startMeetLoop();
  return pet;
}

function spawnPets(characterIds) {
  const all = listCharacters();
  const ids = [...new Set(characterIds)].filter((c) => all.includes(c));
  if (!ids.length) return;

  closeAllPets();
  ids.forEach((c, i) => createPetWindow(c, i, ids.length));
  saveSettings(app.getPath('userData'), {
    lastCharacters: ids,
    lastCharacter: ids[0],
  });
}

function createPickerWindow(isBoot = false) {
  pickerWindow = new BrowserWindow({
    width: 640,
    height: 560,
    resizable: false,
    maximizable: false,
    title: '选择桌宠角色（可多选）',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  pickerWindow.loadFile('picker.html');
  pickerWindow.on('closed', () => {
    pickerWindow = null;
    if (isBoot && alivePets().length === 0) app.quit();
  });
}

function boot() {
  const characters = listCharacters();
  if (!characters.length) {
    console.error('assets 里没有完整角色素材');
    app.quit();
    return;
  }

  const settings = loadSettings(app.getPath('userData'));
  displayScale = clamp(Number(settings.displayScale) || 1, 1, 2);
  const argChar = parseCharacterArg();
  const forcePick = process.argv.includes('--pick');

  if (argChar && characters.includes(argChar)) {
    spawnPets([argChar]);
    return;
  }

  const remembered = Array.isArray(settings.lastCharacters)
    ? settings.lastCharacters.filter((c) => characters.includes(c))
    : settings.lastCharacter && characters.includes(settings.lastCharacter)
      ? [settings.lastCharacter]
      : [];

  if (!forcePick && settings.skipPicker && remembered.length) {
    spawnPets(remembered);
    return;
  }

  createPickerWindow(true);
}

ipcMain.handle('pet-get-character', (event) => {
  const pet = getPetByWebContents(event.sender);
  return pet ? pet.character : 'sayo2';
});

ipcMain.handle('pet-get-scale', (event) => {
  const pet = getPetByWebContents(event.sender);
  return pet ? getEffectiveScale(pet.character) : displayScale;
});

ipcMain.handle('size-get', () => ({
  percent: Math.round(displayScale * 100),
  scale: displayScale,
}));

ipcMain.on('size-set', (_event, percent) => {
  applyDisplayScale(clamp(Number(percent) || 100, 100, 200) / 100);
});

ipcMain.on('size-close', () => {
  if (sizeWindow && !sizeWindow.isDestroyed()) {
    sizeWindow.close();
    sizeWindow = null;
  }
});

ipcMain.handle('picker-bootstrap', () => {
  const settings = loadSettings(app.getPath('userData'));
  const active = alivePets().map((p) => p.character);
  const last = Array.isArray(settings.lastCharacters) ? settings.lastCharacters : [];
  return {
    characters: listCharacters(),
    selectedCharacters: active.length ? active : last,
    lastCharacter: settings.lastCharacter || null,
    skipPicker: !!settings.skipPicker,
    multi: true,
  };
});

ipcMain.on('picker-start', (_event, payload = {}) => {
  const list = Array.isArray(payload.characters)
    ? payload.characters
    : payload.character
      ? [payload.character]
      : [];
  const remember = !!payload.remember;
  const valid = list.filter((c) => listCharacters().includes(c));
  if (!valid.length) return;

  saveSettings(app.getPath('userData'), {
    lastCharacters: valid,
    lastCharacter: valid[0],
    skipPicker: remember,
  });

  if (pickerWindow && !pickerWindow.isDestroyed()) {
    pickerWindow.removeAllListeners('closed');
    pickerWindow.close();
    pickerWindow = null;
  }

  spawnPets(valid);
});

ipcMain.on('picker-quit', () => {
  if (alivePets().length) {
    if (pickerWindow && !pickerWindow.isDestroyed()) {
      pickerWindow.close();
      pickerWindow = null;
    }
    return;
  }
  app.quit();
});

ipcMain.on('pet-open-menu', (event) => {
  const pet = getPetByWebContents(event.sender);
  if (pet) showPetMenu(pet);
});

ipcMain.on('pet-move', (event, { dx, dy }) => {
  const pet = getPetByWebContents(event.sender);
  if (!pet || pet.behavior !== 'drag') return;
  pet._dragVx = (pet._dragVx || 0) * 0.35 + dx * 0.65;
  pet._dragVy = (pet._dragVy || 0) * 0.35 + dy * 0.65;
  const [x, y] = pet.window.getPosition();
  setPos(pet, x + dx, y + dy);
  // 鼠标移动只重算绳长约束，不重复加重力（重力由 tick 积分）
  updateDragChain(pet, { integrate: false });
});

ipcMain.on('pet-drag-start', (event) => {
  const pet = getPetByWebContents(event.sender);
  if (!pet) return;
  // 只脱离前面的人，身后队员留着当链条一起甩
  if (pet.followTargetId) clearFollow(pet, false);

  clearPetTimers(pet);
  pet.behavior = 'drag';
  pet.velX = 0;
  pet.velY = 0;
  pet._dragVx = 0;
  pet._dragVy = 0;
  pet.trail = [];
  seedTrail(pet);
  sendState(pet);

  // 身后只挂着，不挣扎（idle）；用当前位置初始化 Verlet 状态
  for (const fol of getPetsBehind(pet)) {
    clearPetTimers(fol);
    fol.behavior = 'idle';
    const [fx, fy] = fol.window.getPosition();
    fol._hangX = fx;
    fol._hangY = fy;
    fol._hangOldX = fx;
    fol._hangOldY = fy;
    fol._followFacing = null;
    sendState(fol);
  }
  startDragChainTick(pet);
  scheduleRescue(pet, RESCUE_FIRST_DELAY_MS);
});

ipcMain.on('pet-drag-end', (event, payload = {}) => {
  const pet = getPetByWebContents(event.sender);
  if (!pet) return;
  // 已被救援挣脱时 behavior 已不是 drag，忽略后续松手
  if (pet.behavior !== 'drag') return;
  cancelRescue(pet);
  stopDragChainTick(pet);
  updateDragChain(pet);

  const behind = getPetsBehind(pet);
  const vx = Number(payload.vx) || 0;
  const vy = Number(payload.vy) || 0;
  const speed = Math.hypot(vx, vy);

  if (speed >= THROW_SLIDE_MIN) {
    beginSlide(pet, vx * 1.15, vy * 1.15, speed >= THROW_HARD);
    resumeChainFollow(behind);
    return;
  }
  startIdle(pet, 700 + Math.random() * 900);
  resumeChainFollow(behind);
});

/**
 * 拖拽时身后是带重力的 Verlet 链：
 * 队头被抓住移动时，身后各环有惯性，会自然下垂、甩出后回摆。
 * @param {{ integrate?: boolean }} [opts] integrate=false 时只拉绳长（供鼠标移动用）
 */
function updateDragChain(root, opts = {}) {
  const integrate = opts.integrate !== false;
  if (!root.window || root.window.isDestroyed() || root.behavior !== 'drag') return;

  const chain = [];
  let prev = root;
  for (const pet of getPetsBehind(root)) {
    if (!pet.window || pet.window.isDestroyed()) break;
    if (pet.followTargetId !== prev.id) break;
    chain.push(pet);
    prev = pet;
  }
  if (chain.length === 0) return;

  // 初始化 / 补齐 Verlet 状态（以浮点坐标为真源，避免整数取整抹掉速度）
  for (const pet of chain) {
    if (pet._hangX == null || pet._hangOldX == null) {
      const [x, y] = pet.window.getPosition();
      pet._hangX = x;
      pet._hangY = y;
      pet._hangOldX = x;
      pet._hangOldY = y;
    }
  }

  // 1) 惯性积分 + 重力（仅 tick；鼠标移动事件不重复积分）
  if (integrate) {
    for (const pet of chain) {
      const x = pet._hangX;
      const y = pet._hangY;
      const vx = (x - pet._hangOldX) * HANG_DAMPING;
      const vy = (y - pet._hangOldY) * HANG_DAMPING;
      pet._hangOldX = x;
      pet._hangOldY = y;
      pet._hangX = x + vx;
      pet._hangY = y + vy + HANG_GRAVITY;
    }
  }

  // 2) 固定链长约束：父节点钉死，只拉子节点（挂绳）
  for (let iter = 0; iter < HANG_CONSTRAINT_ITERS; iter++) {
    let [prevX, prevY] = root.window.getPosition();
    for (const pet of chain) {
      const beforeX = pet._hangX;
      const beforeY = pet._hangY;
      let dx = pet._hangX - prevX;
      let dy = pet._hangY - prevY;
      let dist = Math.hypot(dx, dy);
      if (dist < 1e-6) {
        dx = 0;
        dy = 1;
        dist = 1;
      }
      const pull = (dist - HANG_GAP) / dist;
      pet._hangX -= dx * pull;
      pet._hangY -= dy * pull;

      const b = getBoundsFor(pet);
      const cx = clamp(pet._hangX, b.minX, b.maxX);
      const cy = clamp(pet._hangY, b.minY, b.maxY);
      const hitX = cx !== pet._hangX;
      const hitY = cy !== pet._hangY;
      pet._hangX = cx;
      pet._hangY = cy;

      if (!integrate) {
        // 鼠标拉绳：同步平移 old，避免把约束位移当成甩出力
        pet._hangOldX += pet._hangX - beforeX;
        pet._hangOldY += pet._hangY - beforeY;
      } else {
        // 积分帧：约束位移部分写回 old，吃掉弹性，少飘
        pet._hangOldX += (pet._hangX - beforeX) * HANG_CONSTRAINT_BLEED;
        pet._hangOldY += (pet._hangY - beforeY) * HANG_CONSTRAINT_BLEED;
        // 撞边消掉朝外速度，避免贴边狂抖
        if (hitX) pet._hangOldX = pet._hangX;
        if (hitY) pet._hangOldY = pet._hangY;
      }

      prevX = pet._hangX;
      prevY = pet._hangY;
    }
  }

  // 3) 写回窗口
  prev = root;
  for (const pet of chain) {
    const [px] = prev.window.getPosition();
    updateFacing(pet, pet._hangX - px);
    setPos(pet, pet._hangX, pet._hangY);

    if (pet.behavior !== 'idle') {
      pet.behavior = 'idle';
      sendState(pet);
    } else if (pet._followFacing !== pet.facing) {
      pet._followFacing = pet.facing;
      sendState(pet);
    }
    prev = pet;
  }
}

function startDragChainTick(pet) {
  if (pet.dragChainTimer) {
    clearTimeout(pet.dragChainTimer);
    pet.dragChainTimer = null;
  }
  const stepOnce = () => {
    if (!pet.window || pet.window.isDestroyed() || pet.behavior !== 'drag') {
      pet.dragChainTimer = null;
      return;
    }
    updateDragChain(pet);
    pet.dragChainTimer = setTimeout(stepOnce, 16);
  };
  pet.dragChainTimer = setTimeout(stepOnce, 16);
}

function stopDragChainTick(pet) {
  if (pet.dragChainTimer) {
    clearTimeout(pet.dragChainTimer);
    pet.dragChainTimer = null;
  }
}

function resumeChainFollow(behind) {
  const until = Date.now() + FOLLOW_MS;
  for (const fol of behind) {
    if (!fol.window || fol.window.isDestroyed() || !fol.followTargetId) continue;
    clearPetTimers(fol);
    fol.followUntil = until;
    fol.followMoving = false;
    fol._followAnim = null;
    fol._followFacing = null;
    fol.behavior = 'follow';
    sendState(fol);
    tickFollow(fol);
  }
}

/** 某宠物所在整支队伍的成员 id */
function getChainMemberIds(pet) {
  const ids = new Set();
  let cur = getChainRoot(pet);
  while (cur && !ids.has(cur.id)) {
    ids.add(cur.id);
    cur = getDirectFollower(cur);
  }
  return ids;
}

function clearRescueTimer(pet) {
  if (!pet) return;
  if (pet.rescueTimer) {
    clearTimeout(pet.rescueTimer);
    pet.rescueTimer = null;
  }
}

function abortRescuer(rescuer) {
  if (!rescuer || !rescuer.window || rescuer.window.isDestroyed()) return;
  if (rescuer.behavior !== 'rescue' && !rescuer._rescueSide) return;
  clearPetTimers(rescuer);
  rescuer._rescueSide = null;
  if (hasFollower(rescuer)) beginWalk(rescuer);
  else startIdle(rescuer, 400 + Math.random() * 600);
}

/** 取消 victim 身上进行中的救援（放手 / 挣脱 / 销毁时） */
function cancelRescue(victim) {
  if (!victim) return;
  clearRescueTimer(victim);
  const rid = victim._rescuerId;
  victim._rescuerId = null;
  victim._rescueSide = null;
  if (!rid) return;
  const rescuer = pets.get(rid);
  if (rescuer) abortRescuer(rescuer);
}

function listRescueCandidates(victim) {
  const team = getChainMemberIds(victim);
  const busyRoots = new Set();
  for (const p of alivePets()) {
    if (p._rescuerId) busyRoots.add(p._rescuerId);
  }

  // 按队头去重：整队一起去救，不拆队
  const roots = new Map();
  for (const p of alivePets()) {
    if (team.has(p.id)) continue;
    const root = getChainRoot(p);
    if (!root.window || root.window.isDestroyed()) continue;
    if (team.has(root.id)) continue;
    if (busyRoots.has(root.id)) continue;
    if (root._rescueSide) continue;
    if (root.actionMode === 'mouse' || root.actionMode === 'dnd') continue;
    if (['drag', 'slide', 'stun', 'faint', 'getup', 'rescue'].includes(root.behavior)) {
      continue;
    }
    roots.set(root.id, root);
  }
  return [...roots.values()];
}

function scheduleRescue(victim, delay = RESCUE_NEXT_DELAY_MS) {
  if (!victim || victim.behavior !== 'drag') return;
  if (alivePets().length < 2) return;
  clearRescueTimer(victim);
  victim.rescueTimer = setTimeout(() => {
    victim.rescueTimer = null;
    beginRescueAttempt(victim);
  }, delay);
}

/** 初始化拖拽挂链的 Verlet 状态（整串） */
function initHangState(pet) {
  if (!pet.window || pet.window.isDestroyed()) return;
  const [fx, fy] = pet.window.getPosition();
  pet._hangX = fx;
  pet._hangY = fy;
  pet._hangOldX = fx;
  pet._hangOldY = fy;
  pet._followFacing = null;
}

function rescueStandTarget(victim, side) {
  const [vx, vy] = victim.window.getPosition();
  const b = getBoundsFor(victim);
  const x =
    side === 'left'
      ? clamp(vx - RESCUE_FACE_GAP, b.minX, b.maxX)
      : clamp(vx + RESCUE_FACE_GAP, b.minX, b.maxX);
  return { x, y: clamp(vy, b.minY, b.maxY) };
}

/** 面对面：victim 在右则看左，rescuer 在左则看右 */
function applyRescueFacing(victim, rescuer, side) {
  if (side === 'left') {
    // rescuer 站在 victim 左侧 → 面对面：rescuer 朝右，victim 朝左
    if (rescuer.facing !== 'right') {
      rescuer.facing = 'right';
      sendState(rescuer);
    }
    if (victim.facing !== 'left') {
      victim.facing = 'left';
      sendState(victim);
    }
  } else {
    if (rescuer.facing !== 'left') {
      rescuer.facing = 'left';
      sendState(rescuer);
    }
    if (victim.facing !== 'right') {
      victim.facing = 'right';
      sendState(victim);
    }
  }
}

function beginRescueAttempt(victim) {
  if (!victim || !victim.window || victim.window.isDestroyed()) return;
  if (victim.behavior !== 'drag') return;
  if (victim._rescuerId) return;

  const candidates = listRescueCandidates(victim);
  if (candidates.length === 0) {
    // 暂时没人可救，稍后再试
    scheduleRescue(victim, RESCUE_NEXT_DELAY_MS + 400);
    return;
  }

  const rescuer = candidates[Math.floor(Math.random() * candidates.length)];
  // 只让队头去救，身后队员继续跟随，不拆队
  clearPetTimers(rescuer);
  seedTrail(rescuer);

  const [vx] = victim.window.getPosition();
  const [rx] = rescuer.window.getPosition();
  const side = rx <= vx ? 'left' : 'right';

  victim._rescuerId = rescuer.id;
  victim._rescueSide = side;
  rescuer._rescueSide = side;
  // 跑过去用普通跑步，贴脸后再切挣扎
  rescuer.behavior = 'walk';
  sendState(rescuer);
  tickRescueApproach(rescuer, victim);
}

function tickRescueApproach(rescuer, victim) {
  clearPetTimers(rescuer);
  const stepOnce = () => {
    if (!rescuer.window || rescuer.window.isDestroyed()) {
      finishRescueLink(victim, rescuer);
      return;
    }
    if (!rescuer._rescueSide) return;
    if (!victim.window || victim.window.isDestroyed() || victim.behavior !== 'drag') {
      abortRescuer(rescuer);
      finishRescueLink(victim, rescuer);
      return;
    }
    if (victim._rescuerId !== rescuer.id) {
      abortRescuer(rescuer);
      return;
    }

    const side = rescuer._rescueSide || 'left';
    const slot = rescueStandTarget(victim, side);
    // 接近时面向目标；贴脸后再锁成面对面
    const [rx, ry] = rescuer.window.getPosition();
    const dist = Math.hypot(slot.x - rx, slot.y - ry);
    if (dist > 10) updateFacing(rescuer, slot.x - rx);

    rescuer.behavior = 'walk';
    const arrived = moveToward(rescuer, slot.x, slot.y, STEP_RESCUE);
    sendState(rescuer);

    if (arrived || dist <= STEP_RESCUE + 2) {
      beginRescueStruggle(rescuer, victim);
      return;
    }
    rescuer.tickTimer = setTimeout(stepOnce, 16);
  };
  stepOnce();
}

function beginRescueStruggle(rescuer, victim) {
  clearPetTimers(rescuer);
  const side = rescuer._rescueSide || 'left';
  const startedAt = Date.now();
  rescuer.behavior = 'rescue';
  sendState(rescuer);

  const stepOnce = () => {
    if (!rescuer.window || rescuer.window.isDestroyed()) {
      finishRescueLink(victim, rescuer);
      return;
    }
    if (!rescuer._rescueSide) return;
    if (!victim.window || victim.window.isDestroyed() || victim.behavior !== 'drag') {
      abortRescuer(rescuer);
      finishRescueLink(victim, rescuer);
      return;
    }
    if (victim._rescuerId !== rescuer.id) {
      abortRescuer(rescuer);
      return;
    }

    // 抓住者在动时，救援者贴着面对面位置跟着晃
    const slot = rescueStandTarget(victim, side);
    setPos(rescuer, slot.x, slot.y);
    applyRescueFacing(victim, rescuer, side);
    rescuer.behavior = 'rescue';
    sendState(rescuer);

    if (Date.now() - startedAt >= RESCUE_STRUGGLE_MS) {
      resolveRescue(rescuer, victim);
      return;
    }
    rescuer.tickTimer = setTimeout(stepOnce, 16);
  };
  stepOnce();
}

function finishRescueLink(victim, rescuer) {
  if (victim && victim._rescuerId === (rescuer && rescuer.id)) {
    victim._rescuerId = null;
  }
  if (rescuer) rescuer._rescueSide = null;
}

/** 救援成功：挣脱鼠标；失败：加入被抓队伍，再派下一个来救 */
function resolveRescue(rescuer, victim) {
  clearPetTimers(rescuer);
  finishRescueLink(victim, rescuer);

  if (!victim || !victim.window || victim.window.isDestroyed() || victim.behavior !== 'drag') {
    abortRescuer(rescuer);
    return;
  }

  const success = Math.random() < 0.5;
  if (success) {
    // 挣脱：强制结束拖拽；救援队头回闲置，队员仍跟着
    rescuer.behavior = 'idle';
    sendState(rescuer);
    if (hasFollower(rescuer)) beginWalk(rescuer);
    else startIdle(rescuer, 500 + Math.random() * 800);
    forceReleaseDrag(victim);
    return;
  }

  // 失败：整队并入被抓宠物队伍（挂到队尾，进入拖拽链）
  joinDragTeam(rescuer, victim);
  scheduleRescue(victim, RESCUE_NEXT_DELAY_MS);
}

function joinDragTeam(rescuer, victim) {
  if (!rescuer || !victim) return;
  const joinerRoot = getChainRoot(rescuer);
  clearPetTimers(joinerRoot);
  joinerRoot._rescueSide = null;

  // 若队头还挂在别人后面，只脱开前方，身后队伍保留
  if (joinerRoot.followTargetId) clearFollow(joinerRoot, false);

  const tail = getChainTail(victim);
  if (wouldCreateFollowCycle(joinerRoot, tail) || tail.id === joinerRoot.id) {
    if (hasFollower(joinerRoot)) beginWalk(joinerRoot);
    else startIdle(joinerRoot, 400);
    return;
  }

  seedTrail(tail);
  const until = Date.now() + FOLLOW_MS;
  joinerRoot.followTargetId = tail.id;
  joinerRoot.followUntil = until;
  joinerRoot.followMoving = false;
  joinerRoot._followAnim = null;
  joinerRoot._followFacing = null;

  // 整串加入拖拽挂链
  const joining = [joinerRoot, ...getPetsBehind(joinerRoot)];
  for (const pet of joining) {
    clearPetTimers(pet);
    pet.followUntil = until;
    initHangState(pet);
    pet.behavior = 'idle';
    sendState(pet);
  }
  refreshFollowDuration(joinerRoot, until);

  // 队头仍在 drag 时由 updateDragChain 接管；若刚好已放手则恢复跟随
  if (victim.behavior !== 'drag') {
    for (const pet of joining) {
      if (!pet.followTargetId) continue;
      pet.behavior = 'follow';
      sendState(pet);
      tickFollow(pet);
    }
  }
}

/** 主进程强制挣脱：通知渲染进程松手，并结束拖拽链 */
function forceReleaseDrag(pet) {
  if (!pet || pet.behavior !== 'drag') return;
  cancelRescue(pet);
  stopDragChainTick(pet);
  const behind = getPetsBehind(pet);
  if (pet.window && !pet.window.isDestroyed()) {
    pet.window.webContents.send('pet-force-undrag');
  }
  pet.velX = 0;
  pet.velY = 0;
  startIdle(pet, 500 + Math.random() * 700);
  resumeChainFollow(behind);
}

ipcMain.on('pet-interact', (event) => {
  const pet = getPetByWebContents(event.sender);
  if (!pet) return;
  if (['stun', 'faint', 'getup', 'drag', 'slide', 'rescue'].includes(pet.behavior)) return;
  // 点击：倒下再爬起复活
  beginFaint(pet);
});

ipcMain.on('pet-quit', (event) => {
  const pet = getPetByWebContents(event.sender);
  if (pet) {
    destroyPet(pet, { animate: false });
    return;
  }
  app.quit();
});

app.whenReady().then(boot);

app.on('window-all-closed', () => {
  for (const pet of pets.values()) clearPetTimers(pet);
  if (meetTimer) clearInterval(meetTimer);
  app.quit();
});
