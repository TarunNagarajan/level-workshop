export const INCEPTION_PROFILE_IDS = ['story', 'standard', 'guarded', 'sealed'] as const;

type AvailableProfile = { id: string };

export function resolveNewInceptionProfileId(
  explicitProfileId: string | null | undefined,
  configuredDefaultProfileId: string | null | undefined,
  availableProfiles: readonly AvailableProfile[],
): string {
  const available = new Set(availableProfiles.map(profile => profile.id));
  const isAvailableProfile = (profileId: string | null | undefined): profileId is string =>
    typeof profileId === 'string' && (INCEPTION_PROFILE_IDS as readonly string[]).includes(profileId) && available.has(profileId);

  if (isAvailableProfile(explicitProfileId)) return explicitProfileId;
  if (isAvailableProfile(configuredDefaultProfileId)) return configuredDefaultProfileId;
  return 'story';
}
