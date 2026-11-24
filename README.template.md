# Members Avatars

This repo fetches official member profile pictures from Weverse, Berriz, and Fans and publishes them in a predictable file layout:

```text
https://members-avatar.jacob.com.hk/<group-name>/<member-name>.jpeg
```

`README.md` is generated from this template by `index.ts`.

Run the fetcher with:

```sh
bun index.ts
```

The workflow keeps `avatars/` in the GitHub Actions cache and remembers each file's source URL in `avatars/.sources.json`, so an avatar is only downloaded again when its URL changes.

## Weverse posts

`posts.ts` saves the public Weverse posts of the members listed at the top of the file, for [080204.xyz](https://080204.xyz):

```text
https://members-avatar.jacob.com.hk/posts/<group>/index.json          members, birthdays, post counts
https://members-avatar.jacob.com.hk/posts/<group>/<member>.json       posts, oldest first
https://members-avatar.jacob.com.hk/posts/<group>/<member>.webp       160px avatar
```

Each post has its id, time (`at`, ms), Korea date, text and media (`src`, background `color`, `video` for a video cover). Membership-only posts are skipped.

```sh
bun posts.ts
```

Only posts newer than the last run are fetched: the last result is kept in the Actions cache (`posts/`), with the published copy as a fallback.

Current providers:

- `weverse`
- `berriz`
- `fans`

The generated catalog appears below.

<!-- GENERATED_MEMBERS_AVATARS -->
