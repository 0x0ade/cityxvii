# CityXVII

A rotonde-centric fork of the Citizen social web API for beaker/dat applications. Requires a Web browser which supports the Beaker/Dat stack (e.g. [Beaker browser](https://beakerbrowser.com)).

```js
// import the current dev build
import * as Citizen from '//cityxvii.hashbase.io/dev/api.js'

// Citizen.User
// Citizen.Index
```

 - [Todos](./todos.md)

## Rotonde-centric changes

### Lazy-load and index profiles

Profiles should be able to be lazily loaded / updated, with sane fallbacks provided before the content has been fetched. Yet at the same time, it should blend in well enough with the existing site indexing.

Rotonde needs to be able to easily access some basic information about portals outside of the usual social circle immediately.

### Passively index posts

Instead of fetching every post upfront, Rotonde fetches posts when they're needed. The only "metadata" required is the ID.

Note that this removes all thread-related functionality from CityXVII, as the thread's children cannot be determined without fetching every post's root ahead of time.

### Support for Rotonde-specific deviations

Rotonde requires a few extensions which aren't part of the vanilla Citizen schemas. While they could be handled outside of Citizen, having them inside of Citizen 

## Citizen.User API

```js
var user = new Citizen.User(url)
await user.setup()

(await) user.getProfile()
await user.setProfile({name, bio})
await user.setAvatar({data, format}) // not yet implemented

await user.follow(url, {name})
await user.unfollow(url)
await user.isFollowing(url)
await user.listFollows()

await user.microblog.list({..})
await user.microblog.count({..})
await user.microblog.get(id)
await user.microblog.add({type, ..})
await user.microblog.edit(id, {type, ..})
await user.microblog.remove(id)
```

## Citizen.Index API

```js
var index = new Citizen.Index(url)
await index.setup()

await index.reset()

// crawler controls

await index.crawlSite(url, {
  indexes: {
    live: false,
    microblog: {
      feed: true
    },
    social: {
      follows: true
    }
  }
})
await index.uncrawlSite(url)
index.listCrawledSites()
index.getCrawledSite(domain)
index.listProfiles()
(await) index.getProfile(domain)

// microblog index

await index.microblog.reset() // can desync - reset index instead!

index.microblog.listFeed({..})
(await) index.microblog.getPost(url)

// social index

await index.social.reset() // can desync - reset index instead!

await index.social.listFollowers(url)
await index.social.listFriends(url)
await index.social.isFollowing(urlSource, urlTarget)
await index.social.isFriends(urlA, urlB)
```

## File structure

| path | schema | description |
|-|-|-|
| `/profile.json` | `Profile` | The user's profile information. |
| `/avatar.png` | - | The user's image. Should be a square between 100-600px in width/height. |
| `/posts/*.json` | `MicroblogPost` | The user's posts. The filename sort order will determine the list order. |
| `/indexes/citizen.json` | `CitizenIndex` | The top-level index metadata. |
| `/indexes/citizen/microblog.json` | `MicroblogIndex` | The merged-microblog feed index. |
| `/indexes/citizen/social.json` | `SocialIndex` | The social-graph index. |

## File schemas

### Profile

User information.

| field | type | description |
|-|-|-|
| `name` | string | The user's name. |
| `bio` | string | A short description of the user. |
| `avatar` | string | The user's avatar image path, if it isn't `/avatar.png`. |
| `follows` | Array of ProfileFollow | The list of accounts that this user follows. |
| `timestampLast` | number | The time of the last profile activity. Defaults to the archive's `mtime` or 0. |

### ProfileFollow

Information about a followed user.

| field | type | description |
|-|-|-|
| `url` | string | The url of the followed user. |
| `name` | string | The profile name of the followed user. (Optional.) |

### MicroblogPost

A microblog post.

| field | type | description |
|-|-|-|
| `type` | string | What kind of post? Default "text". |
| `text` | string | The text of the post. |
| `threadRoot` | string | If the post is a reply, this is the URL of the root post in the thread. |
| `threadParent` | string | If the post is a reply, this is the URL of the immediate parent in the thread. |
| `createdAt` | number | The creation timestamp. |
| `mentions` | Array of MicroblogPostMention | Users mentioned in the post. |

### MicroblogPostMention

A user-mention inside a `MicroblogPost`.

| field | type | description |
|-|-|-|
| `url` | string | The URL of the mentioned user. |
| `name` | string | The name of the mentioned user. |

### CitizenIndex

Top-level metadata about the indexes.

| field | type | description |
|-|-|-|
| `sites` | Object of domain => CitizenIndexSite | Metadata regarding the indexed sites. |

### CitizenIndexSite

Metadata regarding a previously-indexed site.

| field | type | description |
|-|-|-|
| `key` | string | The resolved key of the dat. |
| `version` | string | The version of the dat which has been indexed. |
| `name` | string | The profile name of the site. |

### MicroblogIndex

A combined view of multiple microblogs. Provides a feed view.

| field | type | description |
|-|-|-|
| `feed` | Array of MicroblogIndexFeedPost | The indexed list of posts, ordered into a merged feed view. |

### MicroblogIndexFeedPost

A feed-index pointer to a post.

| field | type | description |
|-|-|-|
| `url` | string | The URL of the post. |
| `author` | string | The domain name of the author. |
| `filename` | string | The filename of the post. |
| `id` | number | The ID of the original post, which is also part of the filename. |
| `numid` | number | The numeric ID of the original post. Newer posts always have higher numeric IDs. In the best case, this value is close to the creation timestamp of the original post. |

### SocialIndex

The social-graph index.

| field | type | description |
|-|-|-|
| `followers` | Object of url => Array of urls | A map of "follower" relationships. Each entry is an array of users following the entry's key. |