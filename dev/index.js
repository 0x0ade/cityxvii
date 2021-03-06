/* globals DatArchive URL */

import {toUrl, toDomain, ensureFolderExists, ignoreNotFound, deepClone} from './util.js'
import {User} from './user.js'
import * as Schemas from './schemas.js'

const POST_FILE_PATH_REGEX = /^\/posts\/[^\/]+\.json$/i
const BACKSLASH_FILE_PATH_REGEX = /\\/g

// exported api
// =

export class Index extends DatArchive {
  constructor (url) {
    super(toUrl(url))

    this._state = null
    this._vstate = null // volatile state
    this.isEditable = false
    this.microblog = new MicroblogAPI(this)
    this.social = new SocialAPI(this)
  }

  getIndexUrl () {
    return this.url + '/index/citizen.json'
  }

  async setup () {
    var info = await this.getInfo()
    this.isEditable = info.isOwner
    await this._load()

    this._vstate = {
      watchers: {},
      writing: {}
    }

    if (this.isEditable) {
      await ensureFolderExists(this, '/index')
      await ensureFolderExists(this, '/index/citizen')
    }

    await Promise.all([
      this.microblog.setup(),
      this.social.setup()
    ])
  }

  async reset () {
    this._state = new Schemas.CitizenIndex({}, this.getIndexUrl())
    await this._save()
    await Promise.all([
      this.microblog.reset(),
      this.social.reset()
    ])
  }

  async _load () {
    try {
      this._state = new Schemas.CitizenIndex(await this.readFile('/index/citizen.json'), this.getIndexUrl())
    } catch (e) {
      console.warn('Failed to read the citizen index state', e)
      this._state = new Schemas.CitizenIndex({}, this.getIndexUrl())
    }
  }

  async _save () {
    return this._writeFileLate('/index/citizen.json', JSON.stringify(this._state))    
  }

  async _writeFileLate (path, data, opts) {
    // TODO: Make this resolve when the timeout resolves? Or pretend like nothing happened?
    if (!this.isEditable) {
      return
    }
    let timeout = this._vstate.writing[path]
    if (timeout) {
      clearTimeout(timeout)
    }
    this._vstate.writing[path] = setTimeout(async () => {
      await this.writeFile(path, data, opts)
    }, 5000) // TODO: Arbitrary write delay!
  }

  async crawlSite (url, opts) {
    opts = new Schemas.CrawlOpts(opts)
    var user = new User(url)
    var domain = user.getDomainName()
    var siteState = this._state.sites[domain]
    var profileState = this._state.profiles[domain]

    if (!siteState) {
      siteState = this._state.sites[domain] = {key: '', name: '', version: 0}
    }
    if (!profileState) {
      profileState = this._state.profiles[domain] = new Schemas.Profile(null, domain)
    }
    
    var key = await DatArchive.resolveName(domain)
    if (siteState.key && siteState.key !== key) { // key change
      // warn user
      // TODO

      // reset user
      await Promise.all([
        this.microblog.uncrawlSite(user),
        this.social.uncrawlSite(user)
      ])
      siteState = this._state.sites[domain] = {key, name: '', version: 0}
      profileState = this._state.profiles[domain] = new Schemas.Profile(null, domain)
    }

    // index up to current version
    var previousVersion = siteState && typeof siteState.version === 'number' ? siteState.version : 0
    var {version} = await user.getInfo()
    var changes
    if (previousVersion > 0) {
      changes = await user.history({start: previousVersion, end: version + 1}).catch(e => null)
    }
    if (!changes) {
      // No information present, let's just readdir /posts/.
      changes = await user.readdir('/posts/').catch(ignoreNotFound)
      changes = !changes ? [] : changes.map(path => ({path: '/posts/' + path.replace(BACKSLASH_FILE_PATH_REGEX, '/'), type: 'put'}))
      changes.push({path: '/profile.json', type: 'put'})
    }
    await Promise.all([
      this.microblog.crawlSite(user, changes, opts),
      this.social.crawlSite(user, changes, opts)
    ])

    // fetch latest profile
    var profile = await user.getProfile().catch(e => ({}))

    // update crawl state
    this._state.sites[domain] = {key, version, name: profile.name || ''}
    this._state.profiles[domain] = profile.getSynced ? profile.getSynced() : profile

    // If opts.live is set to true, listen to updates.
    if (opts.live && !this._vstate.watchers[domain]) {
      var watcher;
      try {
        watcher = user.watch()
      } catch (e) {
        this._vstate.watchers[domain] = e
      }
      this._vstate.watchers[domain] = watcher
      if (watcher && !(watcher instanceof Error)) {
        watcher.addEventListener('invalidated', async ({path}) => {
          if (path.startsWith('/index/')) {
            return
          }
          // Download and cache the update in the background.
          await user.download(path)
        })
        watcher.addEventListener('changed', async ({path}) => {
          if (path.startsWith('/index/')) {
            return
          }
          // Let's just lazily recrawl.
          await this.crawlSite(url, opts)
          // Note: See above why new Event doesn't work.
          this.dispatchEvent({type: 'indexes-live-updated', url: url + path})
        })
      }
    }

    await this._save()
  }

  async uncrawlSite (url) {
    var user = new User(url)
    var domain = user.getDomainName()

    // remove all previously indexed data
    await Promise.all([
      this.microblog.uncrawlSite(user),
      this.social.uncrawlSite(user)
    ])

    // update crawl state
    delete this._state.sites[domain]
    delete this._state.profiles[domain]
    
    // Close any watchers.
    var watcher = this._vstate.watchers[domain]
    if (watcher) {
      if (!(watcher instanceof Error))
        watcher.close()
      delete this._vstate.watchers[domain]
    }

    await this._save()
  }

  listCrawledSites () {
    return deepClone(this._state.sites)
  }

  getCrawledSite (domain) {
    domain = toDomain(domain)
    return (domain in this._state.sites) ? deepClone(this._state.sites[domain]) : {key: '', name: '', version: 0}
  }

  listProfiles () {
    var i = -1
    var result = []
    for (let domain in this._state.profiles) {
      let profile = this._state.profiles[domain]
      if (!profile.url)
        continue
      result[++i] = profile
    }
    return result
  }

  getProfile (domain) {
    domain = toDomain(domain)
    domain = ((domain in this._state.sites) ? this._state.sites[domain].key : null) || domain
    var profile = this._state.profiles[domain]
    if (!profile || !profile.url) {
      this._state.profiles[domain] = profile = new Schemas.Profile(null, domain)
    }
    return profile
  }
}

// internal methods
// =

class IndexAPI {
  constructor (archive) {
    this.archive = archive
  }

  async setup () {
    // should be overridden as needed
  }

  async crawl (url, opts) {
    // should be overridden as needed
  }
}

class MicroblogAPI extends IndexAPI {
  constructor (archive) {
    super(archive)
    this._state = null
  }

  getIndexUrl () {
    return this.archive.url + '/index/citizen/microblog.json'
  }

  async setup () {
    await this._load()
    // TODO watch for changes to the index in other tabs
  }

  async reset () {
    this._state = new Schemas.MicroblogIndex({}, this.getIndexUrl())
    await this._save()
  }

  async _load () {
    try {
      this._state = new Schemas.MicroblogIndex(await this.archive.readFile('/index/citizen/microblog.json'), this.getIndexUrl())
    } catch (e) {
      console.warn('Failed to read the microblog state', e)
      this._state = new Schemas.MicroblogIndex({}, this.getIndexUrl())
    }
  }

  async _save () {
    return this.archive._writeFileLate('/index/citizen/microblog.json', JSON.stringify(this._state))    
  }

  async crawlSite (user, changes, opts) {
    var domain = user.getDomainName()

    // get a list of files that need indexing since last crawl()
    var changesToIndex = {}
    for (let change of changes) {
      if (POST_FILE_PATH_REGEX.test(change.path)) {
        let filename = change.path.slice('/posts/'.length)
        changesToIndex[filename] = change
      }
    }

    var userFeed = this._state.userFeeds[domain] || []

    // read and index files
    // NOTE this is pretty lazy (filter out, re/add, sort) but I'm not going to optimize this until I need to -prf
    for (var filename in changesToIndex) {
      // remove existing
      this._state.feed = this._state.feed.filter(p => !(p.author === domain && p.filename === filename))
      userFeed = userFeed.filter(p => !(p.author === domain && p.filename === filename))
      // TODO remove thread

      if (changesToIndex[filename].type === 'del') {
        // no new data to index, remove only
        continue
      }

      // feed index
      if (opts.indexes.microblog.feed) {
        // add / readd
        var item = Schemas.MicroblogIndex.postToFeedItem(domain, filename)
        this._state.feed.push(item)
        userFeed.push(item)
      }
    }

    // sort by numid
    this._state.feed.sort((a, b) => b.numid - a.numid)
    userFeed.sort((a, b) => b.numid - a.numid)
    this._state.userFeeds[domain] = userFeed

    // write updated state
    await this._save()
  }

  async uncrawlSite (user) {
    var domain = user.getDomainName()

    // remove all previously indexed data
    let origin = `dat://${domain}/`
    this._state.feed = this._state.feed.filter(post => post.author !== domain)

    // write updated state
    await this._save()
  }

  listFeed (query) {
    query = new Schemas.MicroblogIndexFeedQuery(query)
    var {author, after, before, offset, limit, reverse} = query

    var results = (author ? this._state.userFeeds[toDomain(author)] || [] : this._state.feed).slice()

    if (before || after) {
      results = results.filter(meta => {
        if (before && meta.numid >= before) return false
        if (after && meta.numid <= after) return false
        return true
      })
    }

    if (reverse) results = results.reverse()
    if (offset && limit) results = results.slice(offset, offset + limit)
    else if (offset) results = results.slice(offset)
    else if (limit) results = results.slice(0, limit)

    return results
  }

  getPost (url) {
    var post = this._state.posts[url]
    if (!post || !post.url) {
      this._state.posts[url] = post = new Schemas.MicroblogPost(null, url)
    }
    return post
  }
}

class SocialAPI extends IndexAPI {
  constructor (archive) {
    super(archive)
    this._state = null
  }

  getIndexUrl () {
    return this.archive.url + '/index/citizen/social.json'
  }

  async setup () {
    await this._load()
    // TODO watch for changes to the index in other tabs
  }

  async reset () {
    this._state = new Schemas.SocialIndex({}, this.getIndexUrl())
    await this._save()
  }

  async _load () {
    try {
      this._state = new Schemas.SocialIndex(await this.archive.readFile('/index/citizen/social.json'), this.getIndexUrl())
    } catch (e) {
      console.warn('Failed to read the social state', e)
      this._state = new Schemas.SocialIndex({}, this.getIndexUrl())
    }
  }

  async _save () {
    return this.archive._writeFileLate('/index/citizen/social.json', JSON.stringify(this._state))    
  }

  async crawlSite (user, changes, opts) {
    var followerDomain = user.getDomainName()

    // has the profile.json changed?
    var needsIndex = false
    for (let change of changes) {
      if (change.path === '/profile.json' || change.path === '/portal.json') {
        needsIndex = true
      }
    }
    if (!needsIndex) {
      return
    }

    // fetch latest
    let follows = await user.listFollows()

    // feed index
    // NOTE this is pretty lazy (filter out, re/add, sort) but I'm not going to optimize this until I need to -prf
    if (opts.indexes.social.follows) {
      // remove all previously indexed data
      for (let url in this._state.followers) {
        this._state.followers[url] = this._state.followers[url].filter(d => d !== followerDomain)
      }

      for (let follow of follows) {
        let followedDomain
        try {
          followedDomain = toDomain(follow.url)
        } catch (e) {
          console.warn('Failed to index follow by', followerDomain, 'url:', follow.url)
          console.warn('Error:', e)
          continue
        }
        let followers = this._state.followers[followedDomain] = this._state.followers[followedDomain] || []
        if (followers.indexOf(followerDomain) === -1) {
          followers.push(followerDomain)
        }
      }
    }

    // write updated state
    await this._save()
  }

  async uncrawlSite (user) {
    var domain = user.getDomainName()

    // remove all previously indexed data
    for (let url in this._state.followers) {
      this._state.followers[url] = this._state.followers[url].filter(d => d !== domain)
    }

    // write updated state
    await this._save()
  }

  async listFollowers (url) {
    return deepClone(this._state.followers[toDomain(url)] || [])
  }

  async listFriends (url) {
    var targetDomain = toDomain(url)
    var followers = await this.listFollowers(targetDomain)
    var friends = []
    for (let followerDomain of followers) {
      if (await this.isFollowing(targetDomain, followerDomain)) {
        friends.push(followerDomain)
      }
    }
    return friends.filter(Boolean)
  }

  async isFollowing (urlSource, urlTarget) {
    var followers = this._state.followers[toDomain(urlTarget)] || []
    return followers.indexOf(toDomain(urlSource)) !== -1
  }

  async isFriends (urlA, urlB) {
    var arr = await Promise.all([
      this.isFollowing(urlA, urlB),
      this.isFollowing(urlB, urlA)
    ])
    return arr[0] && arr[1]
  }
}
