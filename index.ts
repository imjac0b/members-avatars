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

type BerrizDiscoverResponse = {
  data?: {
    contents?: Array<{
      type?: string;
      id?: string;
      name?: string;
    }>;
  };
};

type BerrizCommunityDetailResponse = {
  data?: {
    communityId?: number;
    name?: string;
    artists?: Array<{
      name?: string;
      imageUrl?: string;
    }>;
  };
};

type FansHomeScreenResponse = {
  data?: {
    randomizedAllGroups?: Array<{
      id?: string;
      name?: string;
      _member?: {
        nickname?: string;
      };
    }>;
  };
};

type FansGroupArtistsResponse = {
  data?: {
    group?: {
      randomizedArtists?: Array<{
        name?: string;
        nickname?: string;
        code?: string;
        profileImage?: {
          thumbnailUrl?: string;
        };
      }>;
    };
  };
};

type AvatarDownload = {
  groupName: string;
  memberName: string;
  imageUrl: string;
  outputPath: string;
};

type AvatarProvider = {
  name: string;
  listAvatars: () => Promise<AvatarDownload[]>;
};

type GroupCatalog = {
  groupName: string;
  groupSlug: string;
  members: Array<{
    memberName: string;
    memberSlug: string;
    outputPath: string;
  }>;
};

const WEVERSE_APP_ID = "be4d79eb8fc7bd008ee82c8ec4ff6fd4";
const WEVERSE_BASE_URL = "https://global.apis.naver.com/weverse/wevweb";
const BERRIZ_BASE_URL = "https://svc-api.berriz.in/service/v1";
const FANS_GRAPHQL_URL = "https://api.app.fans/graphql";
const README_PLACEHOLDER = "<!-- GENERATED_MEMBERS_AVATARS -->";
const README_TEMPLATE_PATH = "README.template.md";
const README_OUTPUT_PATH = "README.md";
const GROUPS_JSON_PATH = "avatars/groups.json";
const ARIA2_INPUT_PATH = "avatars.aria2c.txt";
const PUBLIC_BASE_URL = (
  process.env.PUBLIC_BASE_URL ?? "https://members-avatar.jacob.com.hk"
).replace(/\/+$/, "");
const REQUEST_TIMEOUT_MS = 20_000;
const BERRIZ_LANGUAGE_CODE = "en";
const WEVERSE_COMMON_QUERY = {
  appId: WEVERSE_APP_ID,
  language: "en",
  os: "WEB",
  platform: "WEB",
  wpf: "pc",
};

const slugifyMemberName = (value: string) => {
  const slug = value
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[./\\]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}-]+/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "unnamed";
};

const slugifyGroupName = (value: string) => {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[./\\]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "unnamed-group";
};

const isMostlyAscii = (value: string) => /^[\x00-\x7F]+$/.test(value);

const pickEnglishLikeName = (...values: Array<string | undefined>) => {
  const normalized = values
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  return normalized.find(isMostlyAscii);
};

const removeWeverseTypeParam = (url: string) => {
  const parsedUrl = new URL(url);
  parsedUrl.searchParams.delete("type");
  return parsedUrl.toString();
};

const createWeverseHash = async (pathname: string) => {
  const timestamp = Date.now();
  const salt = pathname.substring(0, Math.min(255, pathname.length)) + timestamp;
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
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
  console.log("[weverse] Fetching group communities");

  const response = await weverseFetch<WeverseGroupCommunitiesResponse>(
    "/community/v1.0/groupCommunities",
    {
      ...WEVERSE_COMMON_QUERY,
      fields:
        "communityId,communityName,urlPath,logoImage,homeHeaderImage,availableActions,artistOfficialNames,lastArtistContentPublishedAt,openDate",
      groupKey: "ALL-ALL",
      limit: "999999",
    },
  );

  const communities = response.data ?? [];
  console.log(`[weverse] Loaded ${communities.length} communities`);
  return communities;
};

const getWeverseCommunityAvatars = async (
  community: Community,
): Promise<AvatarDownload[]> => {
  console.log(`[weverse] Fetching members for ${community.communityName}`);

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
  const groupSlug = slugifyGroupName(community.communityName);

  const avatars = profiles
    .map((profile) => {
      const memberName = profile.artistOfficialProfile?.officialName?.trim();
      const imageUrl = profile.artistOfficialProfile?.officialImageUrl?.trim();

      if (!memberName || !imageUrl) {
        return null;
      }

      const memberSlug = slugifyMemberName(memberName);

      return {
        groupName: community.communityName,
        memberName,
        imageUrl: removeWeverseTypeParam(imageUrl),
        outputPath: `avatars/${groupSlug}/${memberSlug}.jpeg`,
      } satisfies AvatarDownload;
    })
    .filter((profile): profile is AvatarDownload => profile !== null);

  console.log(
    `[weverse] Found ${avatars.length} members for ${community.communityName}`,
  );

  return avatars;
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

const berrizFetch = async <T>(pathname: string, query: Record<string, string>) => {
  const url = new URL(`${BERRIZ_BASE_URL}${pathname}`);

  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Accept: "application/json",
      Referer: "https://berriz.in/",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Berriz request failed: ${response.status} ${response.statusText}`,
    );
  }

  return (await response.json()) as T;
};

const getBerrizCommunities = async () => {
  console.log("[berriz] Fetching communities");

  const response = await berrizFetch<BerrizDiscoverResponse>("/home/discover", {
    cursor: "0",
    size: "999999",
    languageCode: BERRIZ_LANGUAGE_CODE,
  });

  const communities = (response.data?.contents ?? [])
    .filter((entry) => entry.type === "COMMUNITY" && entry.id && entry.name)
    .map((entry) => ({
      communityId: Number(entry.id),
      communityName: entry.name!.trim(),
    }))
    .filter(
      (community) =>
        Number.isFinite(community.communityId) && community.communityName.length > 0,
    );

  console.log(`[berriz] Loaded ${communities.length} communities`);
  return communities;
};

const getBerrizCommunityAvatars = async (
  community: Community,
): Promise<AvatarDownload[]> => {
  console.log(`[berriz] Fetching members for ${community.communityName}`);

  const response = await berrizFetch<BerrizCommunityDetailResponse>(
    `/community/main/${community.communityId}`,
    {
      languageCode: BERRIZ_LANGUAGE_CODE,
    },
  );

  const groupName = response.data?.name?.trim() || community.communityName;
  const groupSlug = slugifyGroupName(groupName);
  const artists = response.data?.artists ?? [];

  const avatars = artists
    .map((artist) => {
      const memberName = artist.name?.trim();
      const imageUrl = artist.imageUrl?.trim();

      if (!memberName || !imageUrl) {
        return null;
      }

      const memberSlug = slugifyMemberName(memberName);

      return {
        groupName,
        memberName,
        imageUrl,
        outputPath: `avatars/${groupSlug}/${memberSlug}.jpeg`,
      } satisfies AvatarDownload;
    })
    .filter((artist): artist is AvatarDownload => artist !== null);

  console.log(`[berriz] Found ${avatars.length} members for ${groupName}`);
  return avatars;
};

const berrizProvider: AvatarProvider = {
  name: "berriz",
  listAvatars: async () => {
    const communities = await getBerrizCommunities();
    const communityResults = await Promise.all(
      communities.map((community) => getBerrizCommunityAvatars(community)),
    );

    return communityResults.flat();
  },
};

const fansFetch = async <T>(
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
) => {
  const response = await fetch(FANS_GRAPHQL_URL, {
    method: "POST",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Accept: "*/*",
      "Content-Type": "application/json",
      Origin: "https://www.fans.land",
      Referer: "https://www.fans.land/",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
    },
    body: JSON.stringify({
      operationName,
      query,
      variables,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Fans request failed: ${response.status} ${response.statusText}`,
    );
  }

  return (await response.json()) as T;
};

const FANS_HOME_SCREEN_QUERY = `query HomeScreen($bannerFilter: BannerLayoutFilterInput, $bannerPage: PageInput) {
  randomizedAllGroups {
    id
    code
    name
    status
    activateAt
    mainGridImage {
      key
      url
      thumbnailUrl: thumbnailUrl(mode: THUMBNAIL, width: 800)
      __typename
    }
    mainLogoImage {
      key
      thumbnailUrl: thumbnailUrl(mode: THUMBNAIL, width: 800)
      __typename
    }
    _member {
      id
      suspensionCategory
      status
      slug
      nickname
      profileImage {
        key
        thumbnailUrl(mode: THUMBNAIL, width: 400)
        __typename
      }
      __typename
    }
    __typename
  }
  bannerLayouts(filter: $bannerFilter, page: $bannerPage) {
    objects {
      ...BannerCarouselForHomeScreen
      __typename
    }
    __typename
  }
}

fragment BannerCarouselForHomeScreen on BannerLayout {
  id
  banners {
    id
    backgroundColor
    body
    bodyTextColor
    title
    titleTextColor
    url
    image {
      key
      width
      height
      thumbnailUrl(mode: THUMBNAIL, height: 270)
      __typename
    }
    __typename
  }
  __typename
}`;

const FANS_GROUP_ARTISTS_QUERY = `query RandomizedCommunityArtists($filter: GroupFilterInput) {
  group(filter: $filter) {
    randomizedArtists {
      id
      name
      nickname
      profileImage {
        key
        thumbnailUrl(mode: CROP, width: 10000)
        __typename
      }
      code
      member {
        slug
        __typename
      }
      __typename
    }
    __typename
  }
}`;

const getFansGroups = async () => {
  console.log("[fans] Fetching groups");

  const response = await fansFetch<FansHomeScreenResponse>(
    "HomeScreen",
    FANS_HOME_SCREEN_QUERY,
    {
      bannerFilter: {
        classification_Overlap: ["HOME"],
        mode_Overlap: ["CAROUSEL"],
        isActive_Exact: true,
      },
      bannerPage: {
        first: 50,
      },
    },
  );

  const groups = (response.data?.randomizedAllGroups ?? [])
    .map((group) => ({
      communityId: Number(group.id),
      communityName: group.name?.trim() || group._member?.nickname?.trim() || "",
    }))
    .filter(
      (group) =>
        Number.isFinite(group.communityId) && group.communityName.length > 0,
    );

  console.log(`[fans] Loaded ${groups.length} groups`);
  return groups;
};

const getFansGroupAvatars = async (
  community: Community,
): Promise<AvatarDownload[]> => {
  console.log(`[fans] Fetching members for ${community.communityName}`);

  const response = await fansFetch<FansGroupArtistsResponse>(
    "RandomizedCommunityArtists",
    FANS_GROUP_ARTISTS_QUERY,
    {
      filter: {
        id_Overlap: [String(community.communityId)],
      },
    },
  );

  const groupSlug = slugifyGroupName(community.communityName);
  const artists = response.data?.group?.randomizedArtists ?? [];

  const avatars = artists
    .map((artist) => {
      const memberName =
        pickEnglishLikeName(artist.name, artist.nickname) ?? artist.code?.trim();
      const imageUrl = artist.profileImage?.thumbnailUrl?.trim();

      if (!memberName || !imageUrl) {
        return null;
      }

      const memberSlug = slugifyMemberName(memberName);

      return {
        groupName: community.communityName,
        memberName,
        imageUrl,
        outputPath: `avatars/${groupSlug}/${memberSlug}.jpeg`,
      } satisfies AvatarDownload;
    })
    .filter((artist): artist is AvatarDownload => artist !== null);

  console.log(`[fans] Found ${avatars.length} members for ${community.communityName}`);
  return avatars;
};

const fansProvider: AvatarProvider = {
  name: "fans",
  listAvatars: async () => {
    const communities = await getFansGroups();
    const communityResults = await Promise.all(
      communities.map((community) => getFansGroupAvatars(community)),
    );

    return communityResults.flat();
  },
};

const buildCatalog = (avatars: AvatarDownload[]): GroupCatalog[] => {
  const groups = new Map<string, GroupCatalog>();
  const sortedAvatars = [...avatars].sort((a, b) => {
    const groupComparison = a.groupName.localeCompare(b.groupName);
    if (groupComparison !== 0) {
      return groupComparison;
    }

    return a.memberName.localeCompare(b.memberName);
  });

  for (const avatar of sortedAvatars) {
    const groupSlug = slugifyGroupName(avatar.groupName);
    const memberSlug = slugifyMemberName(avatar.memberName);
    const existingGroup = groups.get(groupSlug);

    if (!existingGroup) {
      groups.set(groupSlug, {
        groupName: avatar.groupName,
        groupSlug,
        members: [
          {
            memberName: avatar.memberName,
            memberSlug,
            outputPath: avatar.outputPath,
          },
        ],
      });
      continue;
    }

    existingGroup.members.push({
      memberName: avatar.memberName,
      memberSlug,
      outputPath: avatar.outputPath,
    });
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      members: group.members.sort((a, b) =>
        a.memberName.localeCompare(b.memberName),
      ),
    }))
    .sort((a, b) => a.groupName.localeCompare(b.groupName));
};

const toPublicAvatarPath = (outputPath: string) =>
  outputPath.startsWith("avatars/") ? outputPath.slice("avatars/".length) : outputPath;

const toPublicAvatarUrl = (outputPath: string) =>
  `${PUBLIC_BASE_URL}/${toPublicAvatarPath(outputPath)}`;

const renderReadmeCatalog = (groups: GroupCatalog[]) =>
  {
    const totalGroups = groups.length;
    const totalMembers = groups.reduce(
      (count, group) => count + group.members.length,
      0,
    );

    const sections = groups
      .map((group) => {
        const members = group.members
          .map(
            (member) =>
              `| ${member.memberName} | <img src="${toPublicAvatarUrl(member.outputPath)}" alt="${member.memberName}" loading="lazy" width="100"> | \`${toPublicAvatarPath(member.outputPath)}\` |`,
          )
          .join("\n");

        return `## ${group.groupName}

| Member | Avatar | Path |
| --- | --- | --- |
${members}`;
      })
      .join("\n");

    return `- Total groups: ${totalGroups}
- Total members: ${totalMembers}

${sections}`;
  };

const updateReadme = async (groups: GroupCatalog[]) => {
  console.log("[readme] Updating README.md from template");

  const template = await Bun.file(README_TEMPLATE_PATH).text();
  const catalog = renderReadmeCatalog(groups);
  const readme = template.replace(README_PLACEHOLDER, catalog);

  await Bun.write(README_OUTPUT_PATH, readme);
};

const updateJsonCatalogs = async (groups: GroupCatalog[]) => {
  console.log("[catalog] Updating groups.json and per-group members.json");

  const groupCatalog = groups.map((group) => ({
    id: group.groupSlug,
    name: group.groupName,
  }));

  await Bun.write(GROUPS_JSON_PATH, `${JSON.stringify(groupCatalog, null, 2)}\n`);

  for (const group of groups) {
    const membersPath = `avatars/${group.groupSlug}/members.json`;
    const membersCatalog = group.members.map((member) => ({
      id: member.memberSlug,
      name: member.memberName,
    }));

    await Bun.write(membersPath, `${JSON.stringify(membersCatalog, null, 2)}\n`);
  }
};

const createAria2Input = async (avatars: AvatarDownload[]) => {
  const manifest = avatars
    .map(
      (avatar) => `${avatar.imageUrl}
  out=${avatar.outputPath.slice(avatar.outputPath.lastIndexOf("/") + 1)}
  dir=${avatar.outputPath.slice(0, avatar.outputPath.lastIndexOf("/"))}`,
    )
    .join("\n");

  await Bun.write(ARIA2_INPUT_PATH, `${manifest}\n`);
  console.log(`[download] Wrote aria2 manifest ${ARIA2_INPUT_PATH}`);
};

const runAria2Batch = async () => {
  console.log("[download] Starting aria2c batch");

  const process = Bun.spawn([
    "aria2c",
    "--allow-overwrite=true",
    "--auto-file-renaming=false",
    "--max-tries=5",
    "--retry-wait=2",
    "--timeout=20",
    "--connect-timeout=20",
    "--continue=true",
    "--summary-interval=3",
    "--download-result=hide",
    "--console-log-level=warn",
    "--input-file",
    ARIA2_INPUT_PATH,
    "--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
  ], {
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await process.exited;

  if (exitCode !== 0) {
    throw new Error(`aria2c batch failed with exit code ${exitCode}`);
  }

  console.log("[download] aria2c batch finished");
};

const downloadAllMemberAvatars = async (providers: AvatarProvider[]) => {
  const avatarLists = await Promise.all(
    providers.map(async (provider) => {
      console.log(`[provider] Loading avatars from ${provider.name}`);
      const avatars = await provider.listAvatars();
      console.log(`[provider] ${provider.name} returned ${avatars.length} avatars`);
      return avatars;
    }),
  );

  const uniqueAvatars = new Map<string, AvatarDownload>();

  for (const avatar of avatarLists.flat()) {
    const key = `${slugifyGroupName(avatar.groupName)}/${slugifyMemberName(avatar.memberName)}`;
    uniqueAvatars.set(key, avatar);
  }

  const avatars = [...uniqueAvatars.values()];
  console.log(`[download] Downloading ${avatars.length} unique avatars`);
  for (const [index, avatar] of avatars.entries()) {
    console.log(
      `[download] ${index + 1}/${avatars.length} ${avatar.groupName} / ${avatar.memberName} -> ${avatar.outputPath}`,
    );
  }
  await createAria2Input(avatars);
  await runAria2Batch();

  return avatars;
};

const main = async () => {
  const avatars = await downloadAllMemberAvatars([
    weverseProvider,
    berrizProvider,
    fansProvider,
  ]);
  const groups = buildCatalog(avatars);

  await updateReadme(groups);
  await updateJsonCatalogs(groups);

  console.log(`[done] Downloaded ${avatars.length} avatars across ${groups.length} groups`);
};

await main();
