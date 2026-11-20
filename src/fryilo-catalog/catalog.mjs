export const normalize = value => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Riot numbers selectable forms at or above 900 (Revenant Reign Viego's six swords are
 * 994-999). League ships no such skin slot, so their data comes from the database package. */
export const isFormSkin = skin => Number.isSafeInteger(Number(skin?.id)) && Number(skin.id) % 1000 >= 900;

function skinFamilyKey(file) {
  if (file.skinNum > 0) return `skin:${file.skinNum}`;
  const parts = file.relative.replaceAll('\\','/').split('/').filter(Boolean);
  const token = file.variant ? parts.at(-3) : parts.length >= 3 ? parts.at(-2) : file.name;
  return `path:${normalize(token ?? file.name.replace(/\s*\([^)]*\)\s*$/, ''))}`;
}

export function buildSkinCards(files, newestFirst = false) {
  const families = new Map();
  for (const file of files) {
    const key = skinFamilyKey(file);
    const family = families.get(key) ?? [];
    family.push(file);
    families.set(key, family);
  }
  return [...families.values()].map(family => {
    const actualBase = family.find(file => !file.variant);
    const base = actualBase ?? family[0];
    return {base, chromas:family.filter(file => file.variant && (!actualBase || file.path !== base.path)), hasBase:Boolean(actualBase)};
  }).sort((a,b) => (newestFirst ? bySkinNumber(b,a) : bySkinNumber(a,b)) || a.base.name.localeCompare(b.base.name));
}

/** Oldest first. Riot numbers a champion's skins as it makes them, which is
 * release order for all but a few early and Prestige skins, and a skin the
 * database adds before any release date is known still counts as the newest.
 * Custom skins have no number, so they keep their alphabetical order either way. */
function bySkinNumber(a,b) {
  return (a.base.skinNum ?? 0) - (b.base.skinNum ?? 0);
}

export function skinGallery(groups, query = '') {
  const needle = normalize(query);
  return groups.flatMap(champion => buildSkinCards(champion.files).map(card => ({champion,card})))
    .filter(({champion,card}) => !needle || [champion.name,card.base.name,...card.chromas.map(file => file.name)]
      .some(value => normalize(value).includes(needle)))
    .sort((a,b) => a.card.base.name.localeCompare(b.card.base.name) || a.champion.name.localeCompare(b.champion.name));
}

export function chromaAppearanceUrl(championKey, file) {
  if (file.appearanceUrl) return file.appearanceUrl;
  const imageId = file.imageId ?? (/^\d+$/.test(file.name) ? file.name : '');
  if (!championKey || !imageId) return '';
  return `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/champion-chroma-images/${championKey}/${imageId}.png`;
}

/** Riot's loading-screen art for a champion's skin number, the card's second
 * choice when Data Dragon has no loading picture under the name asked for. */
export function skinLoadScreenUrl(champion, skinNum) {
  return champion?.skins?.find(skin => skin.num === skinNum && skin.parentSkin == null)?.loadScreenUrl ?? '';
}

export function chromaAppearanceOverlayUrl(file) {
  return file.appearanceOverlayUrl ?? '';
}

const cdragonAsset = path => `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/${path}`;

// These database packages are selectable premium skin forms and editions, but
// Riot does not publish them through the ordinary chroma endpoint: the database
// gives them ids of its own. Keep those ids as the stable key and point at art
// that exists instead of letting a 404 collapse every entry to one picture.
//
// Forms carry the portrait Riot's own game shows for them, bundled under
// public/forms by scripts/form-art.mjs; Revenant Reign Viego's swords, which have
// none, carry an in-game shot of each sword (scripts/viego-swords.ps1) and
// the emblem of the class each sword belongs to.
const formArt = file => `/forms/${file}`;
const form = (name, skinNum, file, extra = {}) => ({name, skinNum, appearanceUrl:formArt(file), badge:'FORM', ...extra});
const viegoSword = (id, className) => form(`Revenant Reign Viego (${className} Sword)`, 43, `${id}.jpg`, {formIcon:formArt(`class-${className.toLowerCase()}.png`)});
const specialAppearances = new Map([
  ['103086', {name:'Immortalized Legend Ahri', skinNum:85, badge:'TIER', appearanceUrl:cdragonAsset('assets/characters/ahri/skins/skin86/images/ahri_splash_tile_86.jpg')}],
  ['103087', {name:'Immortalized Legend Ahri (Signature)', skinNum:85, badge:'EDITION', appearanceUrl:cdragonAsset('assets/characters/ahri/skins/skin86/images/ahri_splash_tile_86.jpg'), appearanceOverlayUrl:cdragonAsset('assets/characters/ahri/skins/skin86/lcoverlays/splash_tile_signature.png')}],
  ['145999', {name:"Immortalized Legend Kai'Sa (Signature)", skinNum:70, badge:'EDITION', appearanceUrl:cdragonAsset('assets/characters/kaisa/skins/skin71/images/kaisa_splash_tile_71.jpg'), appearanceOverlayUrl:cdragonAsset('assets/characters/kaisa/skins/skin71/lcoverlays/splash_tile_signature.png')}],
  ['234994', viegoSword('234994', 'Assassin')],
  ['234995', viegoSword('234995', 'Fighter')],
  ['234996', viegoSword('234996', 'Mage')],
  ['234997', viegoSword('234997', 'Marksman')],
  ['234998', viegoSword('234998', 'Support')],
  ['234999', viegoSword('234999', 'Tank')],
  ['99991', form('Elementalist Lux (Air)', 7, '99991.png')],
  ['99992', form('Elementalist Lux (Dark)', 7, '99992.png')],
  ['99993', form('Elementalist Lux (Ice)', 7, '99993.png')],
  ['99994', form('Elementalist Lux (Magma)', 7, '99994.png')],
  ['99995', form('Elementalist Lux (Mystic)', 7, '99995.png')],
  ['99996', form('Elementalist Lux (Nature)', 7, '99996.png')],
  ['99997', form('Elementalist Lux (Storm)', 7, '99997.png')],
  ['99998', form('Elementalist Lux (Water)', 7, '99998.png')],
  ['99999', form('Elementalist Lux (Fire)', 7, '99999.png')],
  ['21997', form('Gun Goddess Miss Fortune (Zero Hour)', 16, '21997.png')],
  ['21998', form('Gun Goddess Miss Fortune (Royal Arms)', 16, '21998.png')],
  ['21999', form('Gun Goddess Miss Fortune (Starswarm)', 16, '21999.png')],
  ['25999', form('Spirit Blossom Morgana (Superbloom)', 80, '25999.png')],
  ['222998', form('Arcane Fractured Jinx (Hero of Zaun)', 60, '222998.png')],
  ['222999', form('Arcane Fractured Jinx (Powder)', 60, '222999.png')],
  ['875998', form('Radiant Serpent Sett (Divine Form)', 66, '875998.png')],
  ['875999', form('Radiant Serpent Sett (Serpent Form)', 66, '875999.png')],
  ['82998', form('Sahn-Uzal Mordekaiser (Ultimate Form)', 54, '82998.png')],
  ['82999', form('Sahn-Uzal Mordekaiser (Empire Form)', 54, '82999.png')],
  ['37998', form('DJ Sona (Concussive)', 6, '37998.jpg')],
  ['37999', form('DJ Sona (Ethereal)', 6, '37999.jpg')],
]);

/** Every database id with art of its own, for the check that each bundled file exists. */
export const SPECIAL_APPEARANCES = specialAppearances;

function skinNumberFromId(championKey, skinId) {
  if (!/^\d+$/.test(String(championKey)) || !/^\d+$/.test(String(skinId))) return 0;
  const number = Number(skinId) - Number(championKey) * 1000;
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

export function groupCatalog(champions, files) {
  const groups = champions.map(c => ({...c, files:[]}));
  const lookup = new Map(groups.flatMap(c => [[normalize(c.name), c], [normalize(c.id), c], [c.key, c]]));
  const unmatched = [];
  for (const file of files) {
    let parts = file.relative.replaceAll('\\','/').split('/').filter(Boolean);
    if (normalize(parts[0] ?? '') === 'skins') parts = parts.slice(1);
    const champion = lookup.get(normalize(parts[0]));
    if (!champion) { unmatched.push(file); continue; }
    const numericSkin = champion.skins.find(s => String(s.id) === file.name);
    const parentToken = parts.length >= 4 ? parts.at(-3) : undefined;
    const parentSkin = parentToken
      ? champion.skins.find(s => String(s.id) === parentToken || normalize(s.name) === normalize(parentToken))
      : undefined;
    // The raw update layout uses numeric skin/chroma directories. Renamed legacy
    // libraries can contain an extra numeric archive directory under a named skin;
    // that is still the parent skin, rather than an unnamed chroma.
    const rawNumericVariant = parts.length >= 4
      && /^\d+$/.test(parts[0] ?? '')
      && /^\d+$/.test(parentToken ?? '')
      && /^\d+$/.test(file.name);
    // Riot also ships selectable forms below a named skin folder. They use a
    // high numeric appearance id (for example Revenant Reign Viego's weapon
    // forms and the Hall of Legends Ahri forms) but are intentionally absent
    // from the ordinary skin list. Treat an unknown id below a known parent as
    // a selectable appearance so its own CommunityDragon art is shown.
    const namedNumericVariant = parts.length >= 4
      && /^\d+$/.test(file.name)
      && !/^\d+$/.test(parentToken ?? '')
      && !numericSkin
      && Boolean(parentSkin);
    const specialAppearance = specialAppearances.get(String(file.name));
    const isNestedVariant = parts.length >= 4 && (
      rawNumericVariant
      || namedNumericVariant
      ||
      Boolean(parentSkin && parentToken && /^\d+$/.test(parentToken))
      || !/^\d+$/.test(file.name)
    );
    const name = specialAppearance?.name
      ?? numericSkin?.name
      ?? file.embeddedName
      ?? (isNestedVariant
        ? file.name.includes('(') ? file.name
          : parentSkin ? `${parentSkin.name} (${namedNumericVariant ? 'Version' : 'Chroma'} ${file.name})`
          : parentToken && !/^\d+$/.test(parentToken) ? `${parentToken} (${file.name})`
          : file.name
        : /^\d+$/.test(file.name) ? parentSkin?.name ?? `Skin ${file.name}` : file.name);
    const exactSkin = champion.skins.find(s => normalize(s.name) === normalize(name));
    const baseName = name.replace(/\s*\([^)]*\)\s*$/, '');
    const metadataParent = numericSkin?.parentSkin == null
      ? undefined
      : champion.skins.find(s => s.num === numericSkin.parentSkin);
    const variant = numericSkin?.parentSkin != null || isNestedVariant || (baseName !== name && parts.length > 3 && !/\(\d{4}\)$/.test(name));
    const baseSkin = metadataParent ?? parentSkin ?? champion.skins.find(s => normalize(s.name) === normalize(baseName));
    const skin = variant ? baseSkin ?? exactSkin : exactSkin ?? baseSkin;
    // Database commits can arrive before the app's bundled Riot metadata. The
    // numeric layout still tells us both the base skin number and the chroma
    // image id, so new releases belong to their real family immediately.
    const numericParent = variant ? parentToken : file.name;
    const derivedSkinNum = skinNumberFromId(champion.key, numericParent);
    const derivedImageId = /^\d+$/.test(file.name) ? file.name : undefined;
    champion.files.push({
      ...file,
      name,
      skinNum:specialAppearance?.skinNum ?? skin?.num ?? derivedSkinNum,
      variant,
      imageId:(numericSkin ?? exactSkin)?.id ?? derivedImageId,
      appearanceUrl:specialAppearance?.appearanceUrl ?? numericSkin?.appearanceUrl,
      appearanceOverlayUrl:specialAppearance?.appearanceOverlayUrl ?? numericSkin?.appearanceOverlayUrl,
      badge:specialAppearance?.badge,
      formIcon:specialAppearance?.formIcon
    });
  }
  for (const c of groups) c.files.sort((a,b) => a.name.localeCompare(b.name));
  return {groups:groups.sort((a,b) => a.name.localeCompare(b.name)),unmatched};
}

export async function switchSkin(api, installed, oldIds, newId) {
  const previous = installed.filter(m => oldIds.includes(m.id) && m.enabled && m.id !== newId);
  const disabled = [];
  try {
    for (const mod of previous) { await api(mod.id,false); disabled.push(mod.id); }
    await api(newId,true);
  } catch (error) {
    const failures = [];
    for (const id of disabled) { try { await api(id,true); } catch { failures.push(id); } }
    if(failures.length) throw new Error(`${error}. Could not restore previous skins: ${failures.join(', ')}`);
    throw error;
  }
}

/* What a database update changes, as a sentence naming the skins. A database
   path is champion/base skin[/chroma or form]/file, so a skin's chromas and
   forms fold into the skin; a skin is new only when its own file arrives. */
/** The database files an update left out, named as a player would know them:
 * "Sett (875998): it holds no game files". The copy already installed stays,
 * so the message says so. */
export function describeSkippedFiles(skipped, champions) {
  if (!skipped?.length) return '';
  const nameOf = path => {
    const [championKey, baseId, ...rest] = path.split('/');
    const fileId = rest.at(-1)?.replace(/\.fantome$/i, '') ?? baseId;
    const champion = champions.find(group => group.key === championKey);
    const entry = champion?.skins.find(candidate => candidate.num === Number(baseId) % 1000);
    const skin = entry ? (entry.num === 0 ? champion.name : entry.name) : champion?.name;
    return skin ? (fileId === baseId ? skin : `${skin} (${fileId})`) : path;
  };
  const shown = skipped.slice(0, 3).map(file => `${nameOf(file.path)}: ${file.reason}`).join('; ');
  const more = skipped.length > 3 ? ` and ${skipped.length - 3} more` : '';
  return `${skipped.length} skin file${skipped.length === 1 ? '' : 's'} could not be installed and ${skipped.length === 1 ? 'was' : 'were'} skipped (${shown}${more}). Any copy you already had stays.`;
}

export function describeDatabaseChanges(changes, champions) {
  const skinOf = path => path.split('/').slice(0, 2).join('/');
  const newSkins = new Set(changes.added
    .filter(path => { const [, baseId, file] = path.split('/'); return file === `${baseId}.fantome`; })
    .map(skinOf));
  const updated = [...new Set([...changes.changed, ...changes.removed, ...changes.added].map(skinOf))]
    .filter(skin => !newSkins.has(skin));
  const nameOf = skin => {
    const [championKey, baseId] = skin.split('/');
    const champion = champions.find(group => group.key === championKey);
    const entry = champion?.skins.find(candidate => candidate.num === Number(baseId) % 1000);
    return entry ? (entry.num === 0 ? champion.name : entry.name) : null;
  };
  const names = [...new Set(updated.map(nameOf).filter(Boolean))];
  const parts = [];
  if (updated.length) {
    const shown = names.slice(0, 3).join(', ');
    const more = updated.length - Math.min(names.length, 3);
    parts.push(`${updated.length} skin${updated.length === 1 ? '' : 's'} updated${shown ? `: ${shown}${more > 0 ? ` and ${more} more` : ''}` : ''}`);
  }
  if (newSkins.size) parts.push(`${newSkins.size} new skin${newSkins.size === 1 ? '' : 's'}`);
  return parts.join('; ');
}
