const fs = require('fs');
const path = require('path');

/**
 * 各角色相对基准的显示倍率（1 = 默认）。
 * 素材偏大就调小，偏小就调大；可与右键「大小设置」叠乘。
 * 括号内为 idle 帧大致像素，方便对照。
 */
const CHARACTER_SCALE = {
  ako: 0.78,
  ako2: 1,
  lisa: 0.8,
  lisa2: 1.14,
  rinko: 0.83,
  rinko2: 1.0,
  sayo: 0.8,
  sayo2: 0.95,
  yukina: 0.8,
  yukina2: 1,
};

function getCharacterScale(id) {
  const v = CHARACTER_SCALE[id];
  return typeof v === 'number' && v > 0 ? v : 1;
}

function assetsDir() {
  return path.join(__dirname, 'assets');
}

function listCharacters() {
  const dir = assetsDir();
  if (!fs.existsSync(dir)) return [];

  const ids = new Set();
  for (const file of fs.readdirSync(dir)) {
    const m = file.match(/^(.+)_(idle|run|dead)_0[1-4]\.png$/i);
    if (m) ids.add(m[1]);
  }

  return [...ids]
    .filter((id) =>
      ['idle', 'run', 'dead'].every((action) =>
        [1, 2, 3, 4].every((n) =>
          fs.existsSync(path.join(dir, `${id}_${action}_0${n}.png`))
        )
      )
    )
    .sort((a, b) => a.localeCompare(b, 'en'));
}

function parseCharacterArg(argv = process.argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--character=')) return arg.slice('--character='.length).trim();
    if (arg === '--character' && argv[i + 1]) return String(argv[i + 1]).trim();
  }
  return null;
}

function settingsPath(userDataPath) {
  return path.join(userDataPath, 'settings.json');
}

function loadSettings(userDataPath) {
  try {
    const raw = fs.readFileSync(settingsPath(userDataPath), 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return {};
  }
}

function saveSettings(userDataPath, data) {
  const next = { ...loadSettings(userDataPath), ...data };
  fs.writeFileSync(settingsPath(userDataPath), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

module.exports = {
  assetsDir,
  listCharacters,
  parseCharacterArg,
  loadSettings,
  saveSettings,
  CHARACTER_SCALE,
  getCharacterScale,
};
