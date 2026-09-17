const pet = document.getElementById('pet');
const sprite = document.getElementById('sprite');

const FRAME_MS = {
  idle: 160,
  run: 110,
  runFast: 78,
  dead: 140,
  getup: 140,
  dragging: 160,
};

const DRAG_THRESHOLD = 4;

let CHARACTER = 'sayo2';
let ANIM = {
  idle: [],
  run: [],
  dead: [],
};

let dragging = false;
let dragArmed = false;
let didDrag = false;
let quitting = false;
let lastX = 0;
let lastY = 0;
let lastMoveAt = 0;
let velX = 0;
let velY = 0;
let happyTimer = null;
let frameTimer = null;
let frameIndex = 0;
let walkFacing = 'right';
let remoteAnim = 'idle';
let remotePace = 'normal';
let remoteBehavior = 'idle';
let mode = 'idle';
let ready = false;

function buildAnim(id) {
  return {
    idle: [1, 2, 3, 4].map((n) => `assets/${id}_idle_0${n}.png`),
    run: [1, 2, 3, 4].map((n) => `assets/${id}_run_0${n}.png`),
    dead: [1, 2, 3, 4].map((n) => `assets/${id}_dead_0${n}.png`),
  };
}

function preloadAnim() {
  Object.values(ANIM)
    .flat()
    .forEach((src) => {
      const img = new Image();
      img.src = src;
    });
}

function animKey() {
  if (mode === 'dead' || mode === 'getup') return 'dead';
  if (mode === 'walking' || mode === 'dragging') return 'run';
  return 'idle';
}

function frameDelay() {
  if (mode === 'dragging') return 55;
  if (mode === 'walking' && remotePace === 'fast') return FRAME_MS.runFast;
  if (mode === 'walking') return FRAME_MS.run;
  if (mode === 'dead') return FRAME_MS.dead;
  if (mode === 'getup') return FRAME_MS.getup;
  if (mode === 'happy') return 90;
  return FRAME_MS.idle;
}

function paintFrame() {
  if (!ready) return;
  const frames = ANIM[animKey()];
  if (!frames.length) return;
  const idx = Math.max(0, Math.min(frames.length - 1, frameIndex));
  sprite.src = frames[idx];

  pet.classList.remove(
    'idle',
    'happy',
    'dragging',
    'walking',
    'dead',
    'getup',
    'face-left',
    'face-right'
  );
  const visual = mode === 'getup' ? 'dead' : mode;
  pet.classList.add(visual);
  pet.classList.add(walkFacing === 'left' ? 'face-left' : 'face-right');
}

function startFrames() {
  clearInterval(frameTimer);
  if (!ready) return;
  const frames = ANIM[animKey()];

  if (mode === 'getup') {
    frameIndex = frames.length - 1;
  } else {
    frameIndex = 0;
  }
  paintFrame();

  const ms = frameDelay();
  frameTimer = setInterval(() => {
    const list = ANIM[animKey()];

    if (mode === 'dead') {
      if (frameIndex >= list.length - 1) {
        paintFrame();
        return;
      }
      frameIndex += 1;
      paintFrame();
      return;
    }

    if (mode === 'getup') {
      if (frameIndex <= 0) {
        paintFrame();
        return;
      }
      frameIndex -= 1;
      paintFrame();
      return;
    }

    frameIndex = (frameIndex + 1) % list.length;
    paintFrame();
  }, ms);
}

function setMode(next) {
  if (quitting && next !== 'dead') return;
  if (mode === next) return;
  mode = next;
  startFrames();
}

function applyRemoteState(state) {
  if (quitting || !ready) return;
  remoteBehavior = state.behavior || 'idle';
  remoteAnim = state.anim || 'idle';
  const prevPace = remotePace;
  remotePace = state.pace || 'normal';

  const facingChanged = !!(state.facing && state.facing !== walkFacing);
  if (state.facing) walkFacing = state.facing;

  if (dragging || mode === 'happy') {
    if (facingChanged) paintFrame();
    return;
  }

  let next = 'idle';
  if (remoteBehavior === 'drag' || remoteBehavior === 'rescue') next = 'dragging';
  else if (remoteAnim === 'dead') next = 'dead';
  else if (remoteAnim === 'getup') next = 'getup';
  else if (remoteAnim === 'run') next = 'walking';

  if (mode === next) {
    if (facingChanged) paintFrame();
    if (next === 'walking' && prevPace !== remotePace) {
      const keep = frameIndex;
      startFrames();
      frameIndex = keep;
      paintFrame();
    }
    return;
  }
  setMode(next);
}

window.petAPI.onState(applyRemoteState);

window.petAPI.onForceUndrag(() => {
  // 救援成功：主进程已结束 drag，这里只清本地抓取状态，不再发 dragEnd
  dragging = false;
  dragArmed = false;
  didDrag = true;
  if (mode === 'dragging') setMode('idle');
});

pet.addEventListener('pointerdown', (e) => {
  if (!ready || e.button !== 0 || quitting) return;
  dragArmed = true;
  dragging = false;
  didDrag = false;
  lastX = e.screenX;
  lastY = e.screenY;
  lastMoveAt = performance.now();
  velX = 0;
  velY = 0;
  pet.setPointerCapture(e.pointerId);
});

pet.addEventListener('pointermove', (e) => {
  if (!dragArmed) return;
  const now = performance.now();
  const dt = Math.max(8, now - lastMoveAt);
  const dx = e.screenX - lastX;
  const dy = e.screenY - lastY;

  if (!dragging) {
    if (Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
    dragging = true;
    didDrag = true;
    setMode('dragging');
    window.petAPI.dragStart();
  }

  const scale = 16 / dt;
  velX = dx * scale;
  velY = dy * scale;

  lastX = e.screenX;
  lastY = e.screenY;
  lastMoveAt = now;
  window.petAPI.move(dx, dy);
});

pet.addEventListener('pointerup', (e) => {
  if (!dragArmed) return;
  dragArmed = false;
  try {
    pet.releasePointerCapture(e.pointerId);
  } catch (_) {}

  if (dragging) {
    dragging = false;
    window.petAPI.dragEnd({ vx: velX, vy: velY });
    setMode('idle');
  }
});

pet.addEventListener('pointercancel', (e) => {
  if (!dragArmed) return;
  dragArmed = false;
  if (dragging) {
    dragging = false;
    window.petAPI.dragEnd({ vx: 0, vy: 0 });
    setMode('idle');
  }
});

pet.addEventListener('click', () => {
  if (!ready || quitting) return;
  if (didDrag) {
    didDrag = false;
    return;
  }
  window.petAPI.interact();
});

pet.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (!ready || quitting) return;
  window.petAPI.openMenu();
});

function applyCharacter(id) {
  CHARACTER = id;
  ANIM = buildAnim(CHARACTER);
  preloadAnim();
  quitting = false;
  setMode('idle');
}

window.petAPI.onCharacterChanged(({ character }) => {
  if (!character) return;
  applyCharacter(character);
});

window.petAPI.onPrepareQuit(() => {
  if (quitting) return;
  quitting = true;
  dragging = false;
  dragArmed = false;
  setMode('dead');
  setTimeout(() => window.petAPI.quit(), FRAME_MS.dead * ANIM.dead.length + 200);
});

function applyScale(scale) {
  document.documentElement.style.setProperty('--scale', String(scale || 1));
}

window.petAPI.onScaleChanged(({ scale }) => {
  applyScale(scale);
});

async function bootRenderer() {
  CHARACTER = (await window.petAPI.getCharacter()) || 'sayo2';
  const scale = (await window.petAPI.getScale()) || 1;
  applyScale(scale);
  ANIM = buildAnim(CHARACTER);
  preloadAnim();
  sprite.src = ANIM.idle[0];
  ready = true;
  setMode('idle');
}

bootRenderer();
