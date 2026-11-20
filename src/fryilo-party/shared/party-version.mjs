/** App identity shared by the desktop client and relay. Prereleases stay distinct. */
export function normalizePartyVersion(value) {
  const version = String(value ?? "").trim();
  return version.length <= 40 &&
    /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version)
    ? version
    : "";
}

/** A room pins its creating app version until the room expires. */
export function roomAppVersion(room) {
  return normalizePartyVersion(room?.appVersion || room?.memberStates?.[room?.ownerId]?.app);
}

export function partyVersionError(version, members) {
  const expected = normalizePartyVersion(version);
  if (!expected)
    return "FrYiLoCo could not identify this app version. Restart the app before joining a party.";
  const different = members.find((member) => normalizePartyVersion(member?.app) !== expected);
  if (!different) return "";
  return `Everyone in the party must use FrYiLoCo ${expected}. ${different.name || "A party member"} has ${normalizePartyVersion(different.app) || "an unknown version"}.`;
}
