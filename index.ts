type Community = {
  communityId: number;
  communityName: string;
};

type WeverseGroupCommunitiesResponse = {
  data?: Community[];
};

type WeverseHighlightResponse = {
  content?: {
    data?: Array<{
      cardType?: string;
      data?: {
        artistProfiles?: Array<{
          memberId?: string;
          artistOfficialProfile?: {
            officialImageUrl?: string;
            officialName?: string;
          };
        }>;
      };
    }>;
  };
};

type AvatarDownload = {
  groupName: string;
  memberName: string;
  imageUrl: string;
};

type AvatarProvider = {
  name: string;
  listAvatars: () => Promise<AvatarDownload[]>;
};

const WEVERSE_APP_ID = "be4d79eb8fc7bd008ee82c8ec4ff6fd4";
const WEVERSE_BASE_URL = "https://global.apis.naver.com/weverse/wevweb";
const WEVERSE_COMMON_QUERY = {
  appId: WEVERSE_APP_ID,
  language: "en",
  os: "WEB",
  platform: "WEB",
  wpf: "pc",
};

const slugify = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

const createWeverseHash = async (pathname: string) => {
  const timestamp = Date.now();
  const salt =
    pathname.substring(0, Math.min(255, pathname.length)) + timestamp;
  const hmacSalt = new TextEncoder().encode(salt);

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("1b9cb6378d959b45714bec49971ade22e6e24e42"),
    { name: "HMAC", hash: { name: "SHA-1" } },
    false,
    ["sign", "verify"],
  );

  const hash = btoa(
    String.fromCharCode(
      ...new Uint8Array(await crypto.subtle.sign("HMAC", key, hmacSalt)),
    ),
  );

  return {
    wmsgpad: timestamp.toString(),
    wmd: hash,
  };
};

const createWeverseUrl = async (
  pathname: string,
  query: Record<string, string>,
) => {
  const searchParams = new URLSearchParams(query);
  const unsignedPath = `${pathname}?${searchParams.toString()}`;
  const signedParams = new URLSearchParams(
    await createWeverseHash(unsignedPath),
  );

  return `${WEVERSE_BASE_URL}${unsignedPath}&${signedParams.toString()}`;
};

const weverseFetch = async <T>(
  pathname: string,
  query: Record<string, string>,
) => {
  const response = await fetch(await createWeverseUrl(pathname, query), {
    headers: {
      Origin: "https://weverse.io",
      Referer: "https://weverse.io/",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Weverse request failed: ${response.status} ${response.statusText}`,
    );
  }

  return (await response.json()) as T;
};

const getWeverseCommunities = async () => {
  const response = await weverseFetch<WeverseGroupCommunitiesResponse>(
    "/community/v1.0/groupCommunities",
    {
      ...WEVERSE_COMMON_QUERY,
      fields:
        "communityId,communityName,urlPath,logoImage,homeHeaderImage,availableActions,artistOfficialNames,lastArtistContentPublishedAt,openDate",
      groupKey: "ALL-ALL",
      limit: "1",
    },
  );

  return response.data ?? [];
};

const getWeverseCommunityAvatars = async (
  community: Community,
): Promise<AvatarDownload[]> => {
  const response = await weverseFetch<WeverseHighlightResponse>(
    `/community/v1.0/community-${community.communityId}/HIGHLIGHT/tabContent`,
    {
      ...WEVERSE_COMMON_QUERY,
      fields: "recommendProductSlot",
      gcc: "HK",
    },
  );

  const introCard = response.content?.data?.find(
    (entry) => entry.cardType === "COMMUNITY_INTRO",
  );

  const profiles = introCard?.data?.artistProfiles ?? [];

  return profiles
    .map((profile) => {
      const memberName = profile.artistOfficialProfile?.officialName?.trim();
      const imageUrl = profile.artistOfficialProfile?.officialImageUrl?.trim();

      if (!memberName || !imageUrl) {
        return null;
      }

      return {
        groupName: community.communityName,
        memberName,
        imageUrl,
      } satisfies AvatarDownload;
    })
    .filter((profile): profile is AvatarDownload => profile !== null);
};

const weverseProvider: AvatarProvider = {
  name: "weverse",
  listAvatars: async () => {
    const communities = await getWeverseCommunities();
    const communityResults = await Promise.all(
      communities.map((community) => getWeverseCommunityAvatars(community)),
    );

    return communityResults.flat();
  },
};

const downloadAvatar = async ({
  groupName,
  memberName,
  imageUrl,
}: AvatarDownload) => {
  const groupSlug = slugify(groupName);
  const memberSlug = slugify(memberName);
  const destination = `avatars/${groupSlug}/${memberSlug}.jpeg`;

  const response = await fetch(imageUrl);

  if (!response.ok) {
    throw new Error(
      `Avatar download failed: ${response.status} ${response.statusText}`,
    );
  }

  await Bun.write(destination, response);

  return destination;
};

const downloadAllMemberAvatars = async (providers: AvatarProvider[]) => {
  const avatarLists = await Promise.all(
    providers.map((provider) => provider.listAvatars()),
  );
  const avatars = avatarLists.flat();
  const uniqueAvatars = new Map<string, AvatarDownload>();

  for (const avatar of avatars) {
    const key = `${slugify(avatar.groupName)}/${slugify(avatar.memberName)}`;
    uniqueAvatars.set(key, avatar);
  }

  const downloadedFiles = await Promise.all(
    [...uniqueAvatars.values()].map(downloadAvatar),
  );

  return downloadedFiles;
};

const main = async () => {
  const downloadedFiles = await downloadAllMemberAvatars([weverseProvider]);
  console.log(`Downloaded ${downloadedFiles.length} avatars.`);
};

await main();
