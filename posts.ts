// Saves each listed member's public Weverse posts (photos, video covers and
// text) to 080204/<member>.json, with a background colour for every image,
// plus 080204/index.json. The workflow publishes the folder at
// https://members-avatar.jacob.com.hk/080204/.
//
//   bun posts.ts
//
// Only new posts are fetched. The last result is kept in the GitHub Actions
// cache (080204/); if the cache is empty, the copy that is already published is
// used instead, and only if that is missing too is everything since debut
// fetched again. Membership-only posts are skipped. Dates are in Korea time.
import { mkdir } from "node:fs/promises";
import sharp from "sharp";
import { WEVERSE_COMMON_QUERY, weverseFetch } from "./weverse";

type MemberConfig = { slug: string; memberId: string };
type GroupConfig = { slug: string; name: string; debut: string; members: MemberConfig[] };

// weverse.io/<group>/profile/<memberId>
const GROUPS: GroupConfig[] = [
  {
    slug: "illit",
    name: "ILLIT",
    debut: "2024-03-25",
    members: [
      { slug: "yunah", memberId: "510ac062fa128b9cd7b80c2cf342ba03" },
      { slug: "minju", memberId: "be7ff20f247e10eece125e7e4c6feece" },
      { slug: "moka", memberId: "68f46ef34d4de196264e91af1523a9ac" },
      { slug: "wonhee", memberId: "f18fa49aedf1905462fb96ddc1fbe31c" },
      { slug: "iroha", memberId: "48158d9a0f593f8a77cea38bb82e56cd" },
    ],
  },
];

const OUT_DIR = "080204";
const PUBLIC_BASE_URL = (
  process.env.PUBLIC_BASE_URL ?? "https://members-avatar.jacob.com.hk"
).replace(/\/+$/, "");
const PAGE_SIZE = 50;
const COLOUR_CONCURRENCY = 8;

type Media = { src: string; color?: string; video?: true };
type SavedPost = { id: string; at: number; date: string; text?: string; media: Media[] };
type SavedMember = {
  group: string;
  member: string;
  name: string;
  memberId: string;
  birthday?: string;
  checkedAt: string;
  posts: SavedPost[];
};

type WeverseAttachment = {
  type?: string;
  data?: { url?: string; uploadInfo?: { imageUrl?: string } };
};
type WeversePost = {
  postId: string;
  publishedAt: number;
  plainBody?: string;
  membershipOnly?: boolean;
  orderedAttachments?: WeverseAttachment[];
  author?: {
    artistOfficialProfile?: {
      officialName?: string;
      officialImageUrl?: string;
      birthday?: { dateString?: string };
    };
  };
};
type WeversePostsResponse = {
  data?: WeversePost[];
  paging?: { nextParams?: { after?: string } };
};

const kstDate = (ms: number) => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10);

// "Jan 15, 2004" -> "2004-01-15"
const isoBirthday = (value?: string) => {
  if (!value) return undefined;
  const parsed = new Date(`${value} 12:00 UTC`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString().slice(0, 10);
};

const loadSaved = async (group: GroupConfig, member: MemberConfig) => {
  const path = `${OUT_DIR}/${member.slug}.json`;
  const file = Bun.file(path);
  if (await file.exists()) {
    try {
      return { saved: (await file.json()) as SavedMember, from: "cache" };
    } catch {}
  }
  try {
    const response = await fetch(`${PUBLIC_BASE_URL}/${path}`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (response.ok) {
      return { saved: (await response.json()) as SavedMember, from: "published copy" };
    }
  } catch {}
  return { saved: undefined, from: "nothing saved" };
};

// Newest first, until a post we already have or one from before debut.
const fetchNewPosts = async (
  member: MemberConfig,
  known: Set<string>,
  debut: string,
) => {
  const fresh: WeversePost[] = [];
  let after = "";
  let author: WeversePost["author"];

  for (let page = 0; page < 200; page++) {
    const response = await weverseFetch<WeversePostsResponse>(
      `/post/v1.0/member-${member.memberId}/posts`,
      {
        ...WEVERSE_COMMON_QUERY,
        fieldSet: "postsV1",
        filterType: "DEFAULT",
        limit: String(PAGE_SIZE),
        pagingType: "CURSOR",
        sortType: "LATEST",
        ...(after ? { after } : {}),
      },
    );
    const data = response.data ?? [];
    author ??= data[0]?.author;

    let reachedKnown = false;
    for (const post of data) {
      if (known.has(post.postId) || kstDate(post.publishedAt) < debut) {
        reachedKnown = true;
        continue;
      }
      fresh.push(post);
    }

    after = response.paging?.nextParams?.after ?? "";
    if (reachedKnown || !after || data.length === 0) break;
    await Bun.sleep(300);
  }

  return { fresh, author };
};

const toSavedPost = (post: WeversePost): SavedPost => {
  const media: Media[] = [];
  for (const attachment of post.orderedAttachments ?? []) {
    const src =
      attachment.type === "photo"
        ? attachment.data?.url
        : attachment.type === "video"
          ? attachment.data?.uploadInfo?.imageUrl
          : undefined;
    if (!src || !src.startsWith("https://") || media.some((m) => m.src === src)) continue;
    media.push(attachment.type === "video" ? { src, video: true } : { src });
  }
  const text = post.plainBody?.trim();
  return {
    id: post.postId,
    at: post.publishedAt,
    date: kstDate(post.publishedAt),
    ...(text ? { text } : {}),
    media,
  };
};

const fetchImage = async (src: string, sizes: string[]) => {
  let last: unknown;
  for (const size of sizes) {
    const url = size && src.includes("wevpstatic.net") && !src.includes("?") ? `${src}?type=${size}` : src;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (response.ok && (response.headers.get("content-type") ?? "").startsWith("image/")) {
        return Buffer.from(await response.arrayBuffer());
      }
      last = new Error(`HTTP ${response.status}`);
    } catch (error) {
      last = error;
    }
  }
  throw last;
};

// Average colour, leaning towards the colourful parts so it isn't muddy.
const colourOf = async (image: Buffer) => {
  const { data } = await sharp(image)
    .resize(32, 32, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let r = 0, g = 0, b = 0, w = 0;
  for (let i = 0; i < data.length; i += 3) {
    const weight = 0.25 + (Math.max(data[i]!, data[i + 1]!, data[i + 2]!) - Math.min(data[i]!, data[i + 1]!, data[i + 2]!)) / 255;
    r += data[i]! * weight;
    g += data[i + 1]! * weight;
    b += data[i + 2]! * weight;
    w += weight;
  }
  const hex = (value: number) => Math.round(value / w).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
};

const fillColours = async (posts: SavedPost[]) => {
  const queue = posts.flatMap((post) => post.media.filter((m) => !m.color));
  const total = queue.length;
  let failed = 0;
  await Promise.all(
    Array.from({ length: COLOUR_CONCURRENCY }, async () => {
      for (let media; (media = queue.shift()); ) {
        try {
          media.color = await colourOf(await fetchImage(media.src, ["s100", ""]));
        } catch {
          failed++;
        }
      }
    }),
  );
  return { total, failed };
};

const syncMember = async (group: GroupConfig, member: MemberConfig) => {
  const { saved, from } = await loadSaved(group, member);
  const posts = saved?.posts ?? [];
  const known = new Set(posts.map((post) => post.id));

  let fresh: WeversePost[] = [];
  let author: WeversePost["author"];
  try {
    ({ fresh, author } = await fetchNewPosts(member, known, group.debut));
  } catch (error) {
    console.warn(`[posts] ${group.slug}/${member.slug}: couldn't reach Weverse (${(error as Error).message}); keeping what was saved`);
  }

  const added = fresh.filter((post) => !post.membershipOnly).map(toSavedPost);
  const all = [...posts, ...added].sort((a, b) => a.at - b.at);
  const { total, failed } = await fillColours(all);

  const profile = author?.artistOfficialProfile;
  const result: SavedMember = {
    group: group.slug,
    member: member.slug,
    name: profile?.officialName ?? saved?.name ?? member.slug.toUpperCase(),
    memberId: member.memberId,
    birthday: isoBirthday(profile?.birthday?.dateString) ?? saved?.birthday,
    checkedAt: new Date().toISOString(),
    posts: all,
  };
  await Bun.write(`${OUT_DIR}/${member.slug}.json`, `${JSON.stringify(result)}\n`);

  console.log(
    `[posts] ${group.slug}/${member.slug}: started from ${from} (${posts.length} posts), ${added.length} new, ${all.length} in all` +
      (total ? `; ${total - failed} colours worked out${failed ? `, ${failed} failed (tried again next run)` : ""}` : ""),
  );
  return result;
};

await mkdir(OUT_DIR, { recursive: true });
for (const group of GROUPS) {
  const members: SavedMember[] = [];
  for (const member of group.members) {
    members.push(await syncMember(group, member));
  }

  const index = {
    group: group.slug,
    name: group.name,
    debut: group.debut,
    checkedAt: new Date().toISOString(),
    members: members.map((m) => ({
      slug: m.member,
      name: m.name,
      birthday: m.birthday,
      avatar: `${group.slug}/${m.member}.jpeg`,
      posts: `080204/${m.member}.json`,
      count: m.posts.length,
      latest: m.posts.at(-1)?.date,
    })),
  };
  await Bun.write(`${OUT_DIR}/index.json`, `${JSON.stringify(index, null, 2)}\n`);
}
