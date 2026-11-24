import { readdir, rm, unlink } from "node:fs/promises";
import { WEVERSE_COMMON_QUERY, weverseFetch } from "./weverse";

type Community = {
  communityId: number;
  communityName: string;
  iconImageUrl?: string;
};

type WeverseGroupCommunitiesResponse = {
  data?: Array<{
    communityId?: number;
    communityName?: string;
    logoImage?: string;
  }>;
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
      imageUrl?: string;
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
      mainLogoImage?: {
        thumbnailUrl?: string;
      };
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

type GroupIconDownload = {
  groupName: string;
  imageUrl: string;
  outputPath: string;
};

type ProviderResult = {
  avatars: AvatarDownload[];
  icons: GroupIconDownload[];
};

type AvatarProvider = {
  name: string;
  listAvatars: () => Promise<ProviderResult>;
};

type GroupCatalog = {
  groupName: string;
  groupSlug: string;
  iconOutputPath?: string;
  members: Array<{
    memberName: string;
    memberSlug: string;
    outputPath: string;
  }>;
};

const BERRIZ_BASE_URL = "https://svc-api.berriz.in/service/v1";
const FANS_GRAPHQL_URL = "https://api.app.fans/graphql";
const README_PLACEHOLDER = "<!-- GENERATED_MEMBERS_AVATARS -->";
const README_TEMPLATE_PATH = "README.template.md";
const README_OUTPUT_PATH = "README.md";
const GROUPS_JSON_PATH = "avatars/groups.json";
const MEMBERS_JSON_PATH = "avatars/members.json";
const ARIA2_INPUT_PATH = "avatars.aria2c.txt";
// Which image URL each saved file came from. The workflow keeps avatars/ in the
// GitHub Actions cache, so a file whose URL hasn't changed is not downloaded again.
const SOURCES_PATH = "avatars/.sources.json";
// Folders inside avatars/ that other steps write (left alone when pruning).
const KEEP_DIRS = ["posts"];
const PUBLIC_BASE_URL = (
  process.env.PUBLIC_BASE_URL ?? "https://members-avatar.jacob.com.hk"
).replace(/\/+$/, "");
const REQUEST_TIMEOUT_MS = 20_000;
const BERRIZ_LANGUAGE_CODE = "en";

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

const groupIconOutputPath = (groupSlug: string) => `avatars/${groupSlug}/icon.jpeg`;

const buildGroupIcon = (
  groupName: string,
  iconImageUrl: string | undefined,
): GroupIconDownload | null => {
  const imageUrl = iconImageUrl?.trim();

  if (!imageUrl) {
    return null;
  }

  const groupSlug = slugifyGroupName(groupName);

  return {
    groupName,
    imageUrl,
    outputPath: groupIconOutputPath(groupSlug),
  };
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

  const communities: Community[] = [];

  for (const entry of response.data ?? []) {
    const communityName = entry.communityName?.trim();

    if (typeof entry.communityId !== "number" || !communityName) {
      continue;
    }

    communities.push({
      communityId: entry.communityId,
      communityName,
      iconImageUrl: entry.logoImage?.trim(),
    });
  }

  console.log(`[weverse] Loaded ${communities.length} communities`);
  return communities;
};

const getWeverseCommunityAvatars = async (
  community: Community,
): Promise<ProviderResult> => {
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

  const icon = buildGroupIcon(community.communityName, community.iconImageUrl);

  return { avatars, icons: icon ? [icon] : [] };
};

const weverseProvider: AvatarProvider = {
  name: "weverse",
  listAvatars: async () => {
    const communities = await getWeverseCommunities();
    const communityResults = await Promise.all(
      communities.map((community) => getWeverseCommunityAvatars(community)),
    );

    return {
      avatars: communityResults.flatMap((result) => result.avatars),
      icons: communityResults.flatMap((result) => result.icons),
    };
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
      iconImageUrl: entry.imageUrl?.trim(),
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
): Promise<ProviderResult> => {
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

  const icon = buildGroupIcon(groupName, community.iconImageUrl);

  return { avatars, icons: icon ? [icon] : [] };
};

const berrizProvider: AvatarProvider = {
  name: "berriz",
  listAvatars: async () => {
    const communities = await getBerrizCommunities();
    const communityResults = await Promise.all(
      communities.map((community) => getBerrizCommunityAvatars(community)),
    );

    return {
      avatars: communityResults.flatMap((result) => result.avatars),
      icons: communityResults.flatMap((result) => result.icons),
    };
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
      iconImageUrl: group.mainLogoImage?.thumbnailUrl?.trim(),
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
): Promise<ProviderResult> => {
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

  const icon = buildGroupIcon(community.communityName, community.iconImageUrl);

  return { avatars, icons: icon ? [icon] : [] };
};

const fansProvider: AvatarProvider = {
  name: "fans",
  listAvatars: async () => {
    const communities = await getFansGroups();
    const communityResults = await Promise.all(
      communities.map((community) => getFansGroupAvatars(community)),
    );

    return {
      avatars: communityResults.flatMap((result) => result.avatars),
      icons: communityResults.flatMap((result) => result.icons),
    };
  },
};

const buildCatalog = (
  avatars: AvatarDownload[],
  icons: GroupIconDownload[],
): GroupCatalog[] => {
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

  for (const icon of icons) {
    const groupSlug = slugifyGroupName(icon.groupName);
    const existingGroup = groups.get(groupSlug);

    if (!existingGroup) {
      groups.set(groupSlug, {
        groupName: icon.groupName,
        groupSlug,
        iconOutputPath: icon.outputPath,
        members: [],
      });
      continue;
    }

    if (!existingGroup.iconOutputPath) {
      existingGroup.iconOutputPath = icon.outputPath;
    }
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

        const groupIcon = group.iconOutputPath
          ? `<img src="${toPublicAvatarUrl(group.iconOutputPath)}" alt="${group.groupName}" loading="lazy" width="60"> `
          : "";

        return `## ${groupIcon}${group.groupName}

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
    iconPath: group.iconOutputPath
      ? toPublicAvatarPath(group.iconOutputPath)
      : undefined,
  }));

  await Bun.write(GROUPS_JSON_PATH, `${JSON.stringify(groupCatalog, null, 2)}\n`);

  const allMembersCatalog = groups.flatMap((group) =>
    group.members.map((member) => ({
      id: member.memberSlug,
      name: member.memberName,
      groupId: group.groupSlug,
      groupName: group.groupName,
      avatarPath: toPublicAvatarPath(member.outputPath),
    })),
  );

  await Bun.write(
    MEMBERS_JSON_PATH,
    `${JSON.stringify(allMembersCatalog, null, 2)}\n`,
  );

  for (const group of groups) {
    const membersPath = `avatars/${group.groupSlug}/members.json`;
    const membersCatalog = group.members.map((member) => ({
      id: member.memberSlug,
      name: member.memberName,
    }));

    await Bun.write(membersPath, `${JSON.stringify(membersCatalog, null, 2)}\n`);
  }

  // Group folders restored from the cache for groups that no longer exist.
  const current = new Set([...groups.map((group) => group.groupSlug), ...KEEP_DIRS]);
  for (const entry of await readdir("avatars", { withFileTypes: true })) {
    if (entry.isDirectory() && !current.has(entry.name)) {
      await rm(`avatars/${entry.name}`, { recursive: true, force: true });
      console.log(`[catalog] Removed stale group folder ${entry.name}`);
    }
  }
};

const createAria2Input = async (
  downloads: Array<{ imageUrl: string; outputPath: string }>,
) => {
  const manifest = downloads
    .map(
      (download) => `${download.imageUrl}
  out=${download.outputPath.slice(download.outputPath.lastIndexOf("/") + 1)}
  dir=${download.outputPath.slice(0, download.outputPath.lastIndexOf("/"))}`,
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

const loadSources = async (): Promise<Record<string, string>> => {
  const file = Bun.file(SOURCES_PATH);
  if (!(await file.exists())) {
    return {};
  }
  try {
    return (await file.json()) as Record<string, string>;
  } catch {
    return {};
  }
};

// Removes images left in the cache for members or groups that are gone.
const pruneStaleFiles = async (current: Set<string>) => {
  let removed = 0;
  for await (const path of new Bun.Glob("avatars/**/*.jpeg").scan(".")) {
    if (KEEP_DIRS.some((dir) => path.startsWith(`avatars/${dir}/`))) {
      continue;
    }
    if (!current.has(path)) {
      await unlink(path);
      removed++;
    }
  }
  if (removed > 0) {
    console.log(`[download] Removed ${removed} stale images`);
  }
};

const downloadAllMemberAvatars = async (
  providers: AvatarProvider[],
): Promise<ProviderResult> => {
  const providerResults = await Promise.all(
    providers.map(async (provider) => {
      console.log(`[provider] Loading avatars from ${provider.name}`);
      const result = await provider.listAvatars();
      console.log(
        `[provider] ${provider.name} returned ${result.avatars.length} avatars and ${result.icons.length} group icons`,
      );
      return result;
    }),
  );

  const uniqueAvatars = new Map<string, AvatarDownload>();

  for (const avatar of providerResults.flatMap((result) => result.avatars)) {
    const key = `${slugifyGroupName(avatar.groupName)}/${slugifyMemberName(avatar.memberName)}`;
    uniqueAvatars.set(key, avatar);
  }

  const uniqueIcons = new Map<string, GroupIconDownload>();

  for (const icon of providerResults.flatMap((result) => result.icons)) {
    const key = slugifyGroupName(icon.groupName);
    uniqueIcons.set(key, icon);
  }

  const avatars = [...uniqueAvatars.values()];
  const icons = [...uniqueIcons.values()];

  console.log(
    `[download] Found ${avatars.length} unique avatars and ${icons.length} group icons`,
  );
  for (const [index, avatar] of avatars.entries()) {
    console.log(
      `[download] ${index + 1}/${avatars.length} ${avatar.groupName} / ${avatar.memberName} -> ${avatar.outputPath}`,
    );
  }
  const wanted = [...avatars, ...icons];
  const previous = await loadSources();
  const changed: typeof wanted = [];
  for (const download of wanted) {
    const exists = await Bun.file(download.outputPath).exists();
    if (exists && previous[download.outputPath] === download.imageUrl) {
      continue;
    }
    if (exists) {
      // So aria2c's --continue doesn't resume onto the old image.
      await unlink(download.outputPath);
    }
    changed.push(download);
  }

  console.log(
    `[download] ${wanted.length - changed.length} unchanged (kept from cache), ${changed.length} to download`,
  );

  if (changed.length > 0) {
    await createAria2Input(changed);
    await runAria2Batch();
  }

  await pruneStaleFiles(new Set(wanted.map((download) => download.outputPath)));
  await Bun.write(
    SOURCES_PATH,
    `${JSON.stringify(
      Object.fromEntries(
        wanted
          .map((download) => [download.outputPath, download.imageUrl])
          .sort(([a], [b]) => a!.localeCompare(b!)),
      ),
      null,
      2,
    )}\n`,
  );

  return { avatars, icons };
};

const main = async () => {
  const { avatars, icons } = await downloadAllMemberAvatars([
    weverseProvider,
    berrizProvider,
    fansProvider,
  ]);
  const groups = buildCatalog(avatars, icons);

  await updateReadme(groups);
  await updateJsonCatalogs(groups);

  console.log(`[done] Downloaded ${avatars.length} avatars across ${groups.length} groups`);
};

await main();
