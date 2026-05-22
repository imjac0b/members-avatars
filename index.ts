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
const README_PLACEHOLDER = "<!-- GENERATED_MEMBERS_AVATARS -->";
const README_TEMPLATE_PATH = "README.template.md";
const README_OUTPUT_PATH = "README.md";
const ARIA2_INPUT_PATH = "avatars.aria2c.txt";
const PUBLIC_BASE_URL = (
  process.env.PUBLIC_BASE_URL ?? "https://members-avatar.jacob.com.hk"
).replace(/\/+$/, "");
const REQUEST_TIMEOUT_MS = 20_000;
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
  const groupSlug = slugify(community.communityName);

  const avatars = profiles
    .map((profile) => {
      const memberName = profile.artistOfficialProfile?.officialName?.trim();
      const imageUrl = profile.artistOfficialProfile?.officialImageUrl?.trim();

      if (!memberName || !imageUrl) {
        return null;
      }

      const memberSlug = slugify(memberName);

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

const buildCatalog = (avatars: AvatarDownload[]): GroupCatalog[] => {
  const groups = new Map<string, GroupCatalog>();

  for (const avatar of avatars) {
    const groupSlug = slugify(avatar.groupName);
    const memberSlug = slugify(avatar.memberName);
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
  groups
    .map((group) => {
      const members = group.members
        .map(
          (member) =>
            `| ${member.memberName} | ![${member.memberName}](${toPublicAvatarUrl(member.outputPath)}) | \`${member.outputPath}\` |`,
        )
        .join("\n");

      return `## ${group.groupName}

| Member | Avatar | Path |
| --- | --- | --- |
${members}`;
    })
    .join("\n");

const updateReadme = async (groups: GroupCatalog[]) => {
  console.log("[readme] Updating README.md from template");

  const template = await Bun.file(README_TEMPLATE_PATH).text();
  const catalog = renderReadmeCatalog(groups);
  const readme = template.replace(README_PLACEHOLDER, catalog);

  await Bun.write(README_OUTPUT_PATH, readme);
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
  const process = Bun.spawn([
    "aria2c",
    "--allow-overwrite=true",
    "--auto-file-renaming=false",
    "--max-tries=5",
    "--retry-wait=2",
    "--timeout=20",
    "--connect-timeout=20",
    "--continue=true",
    "--input-file",
    ARIA2_INPUT_PATH,
    "--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
  ]);

  const exitCode = await process.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(process.stderr).text();
    throw new Error(`aria2c batch failed: ${stderr.trim()}`);
  }
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
    const key = `${slugify(avatar.groupName)}/${slugify(avatar.memberName)}`;
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
  const avatars = await downloadAllMemberAvatars([weverseProvider]);
  const groups = buildCatalog(avatars);

  await updateReadme(groups);

  console.log(`[done] Downloaded ${avatars.length} avatars across ${groups.length} groups`);
};

await main();
