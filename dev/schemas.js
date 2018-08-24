/* globals URL */

import {JSONParseError} from './errors.js'
import {toUrl, toDomain, ignoreNotFound} from './util.js'

// base class
// 

class Schema {
  constructor (input, url) {
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input)
      } catch (e) {
        console.debug(e)
        throw new JSONParseError()
      }
    }
    Object.defineProperty(this, '_url', {enumerable: false, value: url ? new URL(url) : url})
    
    if (!url) {
      // URL-less data cannot be awaited.
      Object.defineProperty(this, 'then', {enumerable: false, value: undefined})
      Object.defineProperty(this, '_fetched', {enumerable: false, configurable: true, value: true})
    }

    this.update(input)
  }

  update (input) {
    Object.defineProperty(this, '_input', {enumerable: false, configurable: true, value: input || {}})
  }

  _new () {
    return new this.constructor(this._input, this._url)
  }

  _fetch () {
    return fetch(this._url).then(ignoreNotFound, ignoreNotFound).then(r => r ? r.json() : r)
  }

  then (onFulfillment, onRejection) {
    return this._fetch().then(input => {
      this.update(input)
      let result = this._new()
      // Fetched data cannot be awaited in a loop.
      Object.defineProperty(result, '_source', {enumerable: false, value: this})
      Object.defineProperty(result, 'then', {enumerable: false, value: undefined})
      Object.defineProperty(this, '_fetched', {enumerable: false, configurable: true, value: true})
      Object.defineProperty(result, '_fetched', {enumerable: false, configurable: true, value: true})
      return result
    }).then(onFulfillment, onRejection)/*.catch(e => {
      console.error(this.constructor, this._url)
      throw e
    })*/
  }

  catch (onRejection) {
    return this.then(res => res).catch(onRejection)
  }

  getSynced () {
    return this._source || this
  }

  isFetched () {
    return this._fetched || false
  }

  get (attr, type, fallback) {
    return _get(this._input, attr, type, fallback)
  }

  getHostname () {
    return this._url ? this._url.hostname : ''
  }

  getOrigin () {
    return this._url ? this._url.origin : ''
  }

  getPath () {
    return this._url ? this._url.pathname : ''
  }

  getFilename () {
    return this.getPath().split('/').slice(-1)[0]
  }

  get url () {
    return this._url ? this._url.toString() : ''
  }
}

function _get (obj, attr, type, fallback) {
  var value = obj[attr]
  if (typeof value === type) return value
  return fallback
}

function _feedItem (obj) {
  Object.defineProperty(obj, "url", {
    configurable: true,
    enumerable: false,
    get() {
      return `dat://${obj.author}/posts/${obj.filename}`
    }
  })
  Object.defineProperty(obj, "id", {
    configurable: true,
    enumerable: false,
    get() {
      return obj.filename.slice(0, -5)
    }
  })
  Object.defineProperty(obj, "numid", {
    configurable: true,
    enumerable: false,
    get() {
      return parseInt(obj.id) || parseInt(obj.id, 36)
    }
  })
  return obj
}

// exported api
// =

export class Profile extends Schema {
  constructor (input, meta) {
    super(input, 'dat://' + toDomain(meta))
  }

  async _fetch () {
    let tryfetch = async (url) => {
      try {
        var r = await fetch(url)
        if (r.ok) {
          return r.json()
        }
      } catch (e) {
        ignoreNotFound(e)
      }
      return null
    }
    
    // First, try profile.json.
    // If it cannot be fetched, fall back to portal.json (Rotonde).
    return (await tryfetch(this._url + '/profile.json')) || (await tryfetch(this._url + '/portal.json'))
  }

  update (input) {
    super.update(input)

    var domain = this.getHostname()
    this.name = this.get('name', 'string', domain.length > 16 ? domain.substr(0, 8) + '..' + domain.substr(domain.length - 4) : domain)
    this.bio = this.get('bio', 'string', '')
    this.avatar = this.get('avatar', 'string', 'avatar.png')
    this.follows = Profile.toProfileFollows(this._input.follows)
  }

  static toProfileFollows (follows) {
    if (!follows || typeof follows !== 'object' || !Array.isArray(follows)) {
      return []
    }

    follows = follows.map(follow => {
      if (!follow || typeof follow !== 'object') return false
      if (!follow.url || typeof follow.url !== 'string') return false
      return {
        url: follow.url,
        name: typeof follow.name === 'string' ? follow.name : false
      }
    })
    return follows.filter(Boolean)
  }

  getAvatarUrl () {
    return this.getOrigin() + '/' + this.avatar
  }
}

export class MicroblogPost extends Schema {
  constructor (input, meta) {
    super(input, meta)
  }

  update (input) {
    super.update(input)

    this.type = this.get('type', 'string', 'text')
    this.text = this.get('text', 'string', '')
    this.threadRoot = this.get('threadRoot', 'string', false)
    this.threadParent = this.get('threadParent', 'string', false)
    this.createdAt = this.get('createdAt', 'number', 0)
  }
}

export class CitizenIndex extends Schema {
  constructor (input, meta) {
    super(input, meta)
  }

  update (input) {
    super.update(input)

    this.sites = CitizenIndex.toSites(this._input.sites)
    this.profiles = CitizenIndex.toProfiles(this._input.profiles)
  }

  static toSites (sites) {
    if (!sites || typeof sites !== 'object' || Array.isArray(sites)) {
      return {}
    }

    var res = {}
    for (let domain in sites) {
      let site = sites[domain]
      if (!site || typeof site !== 'object') continue
      if (typeof site.key !== 'string') continue
      res[domain] = {
        key: site.key,
        version: typeof site.version === 'number' ? site.version : 0,
        name: typeof site.name === 'string' ? site.name : ''
      }
    }
    return res
  }

  static toProfiles (profiles) {
    if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) {
      return {}
    }

    var res = {}
    for (let domain in profiles) {
      let profile = profiles[domain]
      if (!profile || typeof profile !== 'object') continue
      if (typeof profile.name !== 'string') continue
      if (typeof profile.bio !== 'string') continue
      res[domain] = new Profile(profile, domain)
    }
    return res
  }
}

export class MicroblogIndex extends Schema {
  constructor (input, meta) {
    super(input, meta)
  }

  update (input) {
    super.update(input)

    this.feed = MicroblogIndex.toFeed(this._input.feed)
  }

  static toFeed (feed) {
    if (!feed || typeof feed !== 'object' || !Array.isArray(feed)) {
      return []
    }

    feed = feed.map(post => {
      if (!post || typeof post !== 'object') return false
      if (!post.author || typeof post.author !== 'string') return false
      if (!post.filename || typeof post.filename !== 'string') return false
      return _feedItem({
        author: post.author,
        filename: post.filename,
      })
    })
    return feed.filter(Boolean)
  }

  static toThreads (threads) {
    if (!threads || typeof threads !== 'object' || Array.isArray(threads)) {
      return {}
    }

    var res = {}
    for (let url in threads) {
      let thread = threads[url]
      if (!thread || !Array.isArray(thread)) continue
      res[url] = thread.filter(v => typeof v === 'string')
    }
    return res
  }

  static postToFeedItem (domain, filename) {
    return _feedItem({
      author: domain,
      filename: filename
    })
  }
}

export class SocialIndex extends Schema {
  constructor (input, meta) {
    super(input, meta)
  }

  update (input) {
    super.update(input)

    this.followers = SocialIndex.toFollowers(this._input.followers)
  }

  static toFollowers (followers) {
    if (!followers || typeof followers !== 'object' || Array.isArray(followers)) {
      return {}
    }

    var res = {}
    for (let url in followers) {
      let f = followers[url]
      if (!f || !Array.isArray(f)) continue
      res[url] = f.filter(v => typeof v === 'string')
    }
    return res
  }
}

export class MicroblogPostsQuery extends Schema {
  constructor (input) {
    super(input)

    this.offset = this.get('offset', 'number', 0)
    this.limit = this.get('limit', 'number')
    this.reverse = this.get('reverse', 'boolean', false)
    this.includeContent = this.get('includeContent', 'boolean', true)
    this.rootPostsOnly = this.get('rootPostsOnly', 'boolean', false)

    // overrides
    if (this.rootPostsOnly) {
      // need to pull content to apply this filter
      this.includeContent = true
    }
  }
}

export class CrawlOpts extends Schema {
  constructor (input) {
    super(input)

    this.indexes = this.get('indexes', 'object', {})
    this.indexes.microblog = _get(this.indexes, 'microblog', 'object', {})
    this.indexes.microblog.feed = _get(this.indexes.microblog, 'feed', 'boolean', true)
    this.indexes.social = _get(this.indexes, 'social', 'object', {})
    this.indexes.social.follows = _get(this.indexes.social, 'follows', 'boolean', true)
  }
}

export class MicroblogIndexFeedQuery extends Schema {
  constructor (input) {
    super(input)

    this.after = this.get('after', 'number', null)
    this.before = this.get('before', 'number', null)
    this.includeContent = this.get('includeContent', 'boolean', true)
    this.offset = this.get('offset', 'number', null)
    this.limit = this.get('limit', 'number', null)
    this.reverse = this.get('reverse', 'boolean', false)
  }
}
