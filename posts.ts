// Saves each listed member's public Weverse posts (photos, videos and text) to
// 080204/<member>.json, with a background colour for every image, plus
// 080204/index.json. Videos are copied to 080204/videos/<videoId>.mp4, because
// Weverse's own video links only work for half an hour. The workflow publishes the folder at
// https://members-avatar.jacob.com.hk/080204/.
//
//   bun posts.ts
//
// Only new posts are fetched. The last result is kept in the GitHub Actions
// cache (080204/); if the cache is empty, the copy that is already published is
// used instead, and only if that is missing too is everything since debut
// fetched again. Membership-only posts are skipped. Dates are in Korea time.
//
// Each post may also carry an event, a short English label worked out from its
// caption (a music show win, an award, a concert city, a TV appearance...). The
// labels are worked out again for every post on every run, so changing the
// rules below relabels old posts too.
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
const VIDEO_DIR = "videos"; // inside OUT_DIR
const VIDEO_QUALITY = 720; // the largest rendition kept, by its short side
const VIDEO_MAX_BYTES = 90 * 1024 * 1024; // GitHub Pages refuses files over 100 MB
const VIDEO_CONCURRENCY = 3;

// A video keeps its cover as src, its Weverse id as vid, and once copied, its
// file as mp4 (relative to 080204/).
type Media = { src: string; color?: string; video?: true; vid?: string; mp4?: string };
type SavedPost = { id: string; at: number; date: string; text?: string; event?: string; media: Media[] };
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
  data?: { url?: string; videoId?: string; uploadInfo?: { imageUrl?: string } };
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
    const vid = attachment.data?.videoId;
    media.push(attachment.type === "video" ? { src, video: true, ...(vid ? { vid } : {}) } : { src });
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

// ---------- events ----------
// Captions are in Korean, Japanese, English and sometimes Chinese, so each rule
// lists the words in each. The first rule that matches a caption gives its label.
type Names = [RegExp, string][];

const SHOWS: Names = [
  [/뮤직\s?뱅크|뮤뱅|ミュージックバンク|music\s?bank/i, "Music Bank"],
  [/엠\s?카운트다운|엠카|m\s?countdown/i, "M Countdown"],
  [/음악\s?중심|음중|music\s?core/i, "Music Core"],
  [/인기가요|인가|inkigayo/i, "Inkigayo"],
  [/쇼\s?챔피언|쇼챔|show\s?champion/i, "Show Champion"],
  [/더\s?쇼|the\s?show\b/i, "The Show"],
];
const CHARTS: Names = [
  [/멜론|melon/i, "Melon"],
  [/오리콘|オリコン|oricon/i, "Oricon"],
  [/빌보드|ビルボード|billboard/i, "Billboard"],
  [/써클\s?차트|circle\s?chart/i, "Circle Chart"],
];
const AWARDS: Names = [
  [/\bMAMA\b|마마/, "MAMA"],
  [/\bMMA\b|멜론\s?뮤직\s?어워드|melon\s?music\s?awards/i, "MMA"],
  [/골든\s?디스크|골디|golden\s?disc/i, "Golden Disc"],
  [/서울\s?가요\s?대상|서가대|seoul\s?music\s?awards/i, "Seoul Music Awards"],
  [/한터|hanteo/i, "Hanteo"],
  [/\bAAA\b|asia\s?artist\s?awards/i, "AAA"],
  [/レコード大賞|レコ大/, "Japan Record Awards"],
];
const TV: Names = [
  [/めざましテレビ|めざまし/, "Mezamashi TV"],
  [/うたコン/, "Utacon"],
  [/ミュージックステーション|Mステ|music\s?station/i, "Music Station"],
  [/紅白/, "Kohaku"],
  [/\bCDTV\b/, "CDTV"],
  [/아는\s?형님|아형/, "Knowing Bros"],
  [/주간\s?아이돌|주간아/, "Weekly Idol"],
  [/놀라운\s?토요일|놀토/, "Amazing Saturday"],
  [/런닝맨/, "Running Man"],
  [/가요\s?대전/, "Gayo Daejeon"],
  [/가요\s?대축제/, "Music Bank Global Festival"],
  [/가요\s?대제전/, "Gayo Daejejeon"],
];
const PLACES: Names = [
  [/서울|ソウル|seoul/i, "Seoul"],
  [/도쿄|東京|tokyo/i, "Tokyo"],
  [/오사카|大阪|osaka/i, "Osaka"],
  [/나고야|名古屋|nagoya/i, "Nagoya"],
  [/후쿠오카|福岡|fukuoka/i, "Fukuoka"],
  [/고베|神戸|kobe/i, "Kobe"],
  [/요코하마|横浜|yokohama/i, "Yokohama"],
  [/사이타마|埼玉|saitama/i, "Saitama"],
  [/삿포로|札幌|sapporo/i, "Sapporo"],
  [/홍콩|香港|hong\s?kong/i, "Hong Kong"],
  [/마카오|澳門|macau/i, "Macau"],
  [/타이베이|台北|taipei/i, "Taipei"],
  [/방콕|バンコク|bangkok/i, "Bangkok"],
  [/자카르타|ジャカルタ|jakarta/i, "Jakarta"],
  [/마닐라|マニラ|manila/i, "Manila"],
  [/싱가포르|シンガポール|singapore/i, "Singapore"],
  [/\bLA\b|los\s?angeles|로스앤젤레스|엘에이/, "Los Angeles"],
  [/뉴욕|new\s?york/i, "New York"],
  [/런던|london/i, "London"],
];
// The name that comes first in the caption, so "Kobe ... see you in Tokyo" is Kobe.
const nameIn = (names: Names, text: string) => {
  let best: { at: number; name: string } | undefined;
  for (const [re, name] of names) {
    const at = text.search(re);
    if (at >= 0 && (!best || at < best.at)) best = { at, name };
  }
  return best?.name;
};
// A name followed closely by a #1, as in "멜론 TOP100 차트 1위".
const firstOn = (names: Names, text: string) =>
  names.find(([re]) => new RegExp(`(${re.source})[^\\n]{0,30}?(1\\s?위|1\\s?位|#1|no\\.?\\s?1\\b)`, re.flags).test(text))?.[1];

const WIN = /1\s?위|1\s?位|first\s+win|1st\s+win|#1\b/i;
const LOOK_BACK = /함께한\s?지|\d\s?주년|anniversary|周年|어느덧\s?\d\s?년/i;
const NOMINEE = /1\s?위\s?후보|1位候補|nominee/i;
const AWARD = /수상|受賞|award|🏆|신인상|본상|대상|상을\s?받|상\s?(두|세|네)\s?개/i;
const LAST_SHOW = /막방|활동\s?마무리|활동을\s?(마무리|보내며)|활동기|이번\s?활동\s?(끝|마지막)|活動終了/;
const COMEBACK = /컴백\s?(했|을\s?했|날|하는\s?날|day)|드디어\s?(오늘\s?)?컴백|comeback\s?day|カムバ(しました|日)/i;
const ENCORE = /앙코르|アンコール|encore/i;
const FAN_CONCERT = /팬\s?콘서트|단독\s?공연|ファンコン/i;
const FAN_MEETING = /팬\s?미팅|팬밋|fan\s?meeting|ファンミ/i;
const JAPAN_TOUR = /일본\s?투어|日本ツアー|japan\s?tour/i;
const CONCERT = /공연|콘서트|concert|公演|ライブ|라이브\s?in|live\s?in|투어|tour|ツアー/i;
const THANKS = /고마|감사|ありがと|thank|謝謝|我愛你|사랑해|大好き/i;
const FESTIVAL = /대학\s?축제|学園祭/;

// Short English label for what a caption is about, if anything.
export const eventOf = (text = "") => {
  // Anniversary posts look back over everything, so they mark nothing new.
  if (LOOK_BACK.test(text)) return undefined;
  if (WIN.test(text) && !NOMINEE.test(text)) {
    const show = nameIn(SHOWS, text);
    if (show) return `${show} win`;
    const chart = firstOn(CHARTS, text);
    if (chart) return `#1 on ${chart}`;
  }
  if (AWARD.test(text)) {
    const award = nameIn(AWARDS, text);
    const trophies = (text.match(/🏆/g) ?? []).length;
    if (award) return trophies > 1 ? `${trophies} ${award} awards` : `${award} award`;
    return "Award";
  }
  if (LAST_SHOW.test(text)) return "Last music show";
  if (ENCORE.test(text)) return "Encore concert";
  if (FAN_CONCERT.test(text)) return "Fan concert";
  if (COMEBACK.test(text)) return "Comeback";
  if (FAN_MEETING.test(text)) return "Fan meeting";
  if (JAPAN_TOUR.test(text)) return "Japan tour";
  const tv = nameIn(TV, text);
  if (tv) return tv;
  const place = nameIn(PLACES, text);
  if (place && CONCERT.test(text)) return `${place} concert`;
  if (place && THANKS.test(text)) return place;
  if (FESTIVAL.test(text)) return "University festival";
  return undefined;
};

const EVENT_REPEAT_DAYS = 7; // the same label again within a week is the same event

// Labels every post again (so rule changes reach old posts), keeping only the
// first post for each event.
const labelEvents = (posts: SavedPost[]) => {
  const last = new Map<string, number>();
  for (const post of posts) {
    delete post.event;
    const label = eventOf(post.text);
    if (!label) continue;
    const seen = last.get(label);
    last.set(label, post.at);
    if (seen !== undefined && post.at - seen < EVENT_REPEAT_DAYS * 86_400_000) continue;
    post.event = label;
  }
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

// ---------- videos ----------
type PostDetail = {
  attachment?: { video?: Record<string, { videoId?: string; uploadInfo?: { imageUrl?: string } }> };
};
type PlayInfo = {
  playInfo?: {
    videos?: { list?: { source?: string; size?: number; encodingOption?: { name?: string } }[] };
  };
};

// Posts saved before videos were kept have no vid yet; one post lookup finds it.
const fillVideoIds = async (post: SavedPost) => {
  const missing = post.media.filter((m) => m.video && !m.vid);
  if (!missing.length) return;
  const detail = await weverseFetch<PostDetail>(`/post/v1.0/post-${post.id}`, {
    ...WEVERSE_COMMON_QUERY,
    fieldSet: "postV1",
  });
  const found = Object.values(detail.attachment?.video ?? {}).filter((v) => v.videoId);
  missing.forEach((media, i) => {
    const match = found.find((v) => v.uploadInfo?.imageUrl === media.src) ?? (found.length === missing.length ? found[i] : undefined);
    if (match?.videoId) media.vid = match.videoId;
  });
};

// The largest rendition up to VIDEO_QUALITY, or the smallest if all are larger.
const pickRendition = (list: NonNullable<NonNullable<PlayInfo["playInfo"]>["videos"]>["list"]) => {
  const ok = (list ?? [])
    .map((v) => ({ ...v, q: parseInt(v.encodingOption?.name ?? "", 10) || 0 }))
    .filter((v) => v.source?.startsWith("https://") && (v.size ?? 0) <= VIDEO_MAX_BYTES)
    .sort((a, b) => a.q - b.q);
  return ok.filter((v) => v.q <= VIDEO_QUALITY).at(-1) ?? ok[0];
};

const downloadVideo = async (vid: string, path: string) => {
  const info = await weverseFetch<PlayInfo>(`/cvideo/v1.0/cvideo-${vid}/playInfo`, {
    ...WEVERSE_COMMON_QUERY,
    videoId: vid,
  });
  const pick = pickRendition(info.playInfo?.videos?.list);
  if (!pick?.source) throw new Error("no playable rendition");
  const response = await fetch(pick.source, {
    headers: { Referer: "https://weverse.io/" },
    signal: AbortSignal.timeout(180_000),
  });
  const type = response.headers.get("content-type") ?? "";
  if (!response.ok || !(type.startsWith("video/") || type === "application/octet-stream")) {
    throw new Error(`HTTP ${response.status} ${type}`);
  }
  const body = await response.arrayBuffer();
  if (body.byteLength < 1024) throw new Error("file too small");
  await Bun.write(path, body);
};

// A copy that is already published, for runs that start with an empty cache.
const restoreVideo = async (mp4: string, path: string) => {
  try {
    const response = await fetch(`${PUBLIC_BASE_URL}/${OUT_DIR}/${mp4}`, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) return false;
    await Bun.write(path, await response.arrayBuffer());
    return true;
  } catch {
    return false;
  }
};

const fillVideos = async (posts: SavedPost[]) => {
  const withVideo = posts.filter((p) => p.media.some((m) => m.video && !m.mp4));
  for (const post of withVideo) {
    try {
      await fillVideoIds(post);
    } catch {}
  }

  const queue = posts.flatMap((p) => p.media.filter((m) => m.video && m.vid));
  let copied = 0, failed = 0;
  await Promise.all(
    Array.from({ length: VIDEO_CONCURRENCY }, async () => {
      for (let media; (media = queue.shift()); ) {
        const mp4 = `${VIDEO_DIR}/${media.vid}.mp4`;
        const path = `${OUT_DIR}/${mp4}`;
        if (await Bun.file(path).exists()) { media.mp4 = mp4; continue; }
        if (media.mp4 && (await restoreVideo(media.mp4, path))) continue;
        try {
          await downloadVideo(media.vid!, path);
          media.mp4 = mp4;
          copied++;
        } catch (error) {
          delete media.mp4;
          failed++;
          console.warn(`[posts] video ${media.vid}: ${(error as Error).message}`);
        }
      }
    }),
  );
  return { copied, failed };
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
  labelEvents(all);
  const { total, failed } = await fillColours(all);
  const videos = await fillVideos(all);

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
    `[posts] ${group.slug}/${member.slug}: started from ${from} (${posts.length} posts), ${added.length} new, ${all.length} in all, ${all.filter((p) => p.event).length} with events` +
      (total ? `; ${total - failed} colours worked out${failed ? `, ${failed} failed (tried again next run)` : ""}` : "") +
      (videos.copied || videos.failed ? `; ${videos.copied} videos copied${videos.failed ? `, ${videos.failed} failed (tried again next run)` : ""}` : ""),
  );
  return result;
};

if (import.meta.main) {
await mkdir(`${OUT_DIR}/${VIDEO_DIR}`, { recursive: true });
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
}
